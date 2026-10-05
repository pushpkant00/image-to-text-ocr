import { FIREBASE_CONFIG, isFirebaseConfigured } from '../shared/firebase-config.js';
import {
  ENC_PREFIX,
  LOCKED_TEXT,
  b64,
  unb64,
  generateKeyBytes,
  wrapSyncKey,
  unwrapSyncKey,
  importSyncKey,
  encryptText,
  decryptText,
} from './crypto.js';

const AUTH_KEY = 'auth';
const HISTORY_LIMIT = 100;
const TOKEN_SKEW_MS = 60_000;
const WRITE_CHUNK = 400;

interface FirestoreValue {
  nullValue?: 'NULL_VALUE';
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  mapValue?: { fields?: Record<string, FirestoreValue> };
  arrayValue?: { values?: FirestoreValue[] };
}

interface FirestoreDoc {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}

interface IdentityResponse {
  localId?: string;
  email?: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: string;
  emailVerified?: boolean;
}

interface RefreshResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: string;
  user_id?: string;
}

interface FirestoreResponse {
  documents?: FirestoreDoc[];
  error?: { message?: string };
}

type FieldMap = Record<string, FirestoreValue>;

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  API_KEY_INVALID: 'Firebase is not configured correctly (bad API key).',
  EMAIL_EXISTS: 'An account with this email already exists.',
  EMAIL_NOT_FOUND: 'No account found with this email.',
  USER_NOT_FOUND: 'No account found with this email.',
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_PASSWORD: 'Incorrect email or password.',
  INVALID_LOGIN_CREDENTIALS: 'Incorrect email or password.',
  INVALID_LOGIN_URL: 'Firebase is not configured correctly.',
  MISSING_PASSWORD: 'Enter your password.',
  MISSING_EMAIL: 'Enter your email address.',
  WEAK_PASSWORD: 'Password must be at least 6 characters.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
  OPERATION_NOT_ALLOWED: 'Email/password sign-in is not enabled in the Firebase console.',
  PROJECT_DISABLED: 'This Firebase project is disabled.',
  USER_DISABLED: 'This account has been disabled.',
};

function friendlyError(raw: string): string {
  const code = String(raw || '').split(':')[0].trim();
  return AUTH_ERROR_MESSAGES[code] || raw || 'Request failed.';
}

function requireConfigured(): void {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured — add your project keys in src/shared/firebase-config.ts');
  }
}

// ---------- sign-in backoff (client-side throttle) ----------
// State lives in chrome.storage.session (cleared when the browser closes).
const BACKOFF_KEY = 'authBackoff';
const BACKOFF_THRESHOLD = 5; // failures before the first lockout
const BACKOFF_BASE_MS = 30_000; // 30s, 60s, 120s, … capped at 5 min
const BACKOFF_MAX_MS = 300_000;

interface BackoffState {
  fails?: number;
  lockedUntil?: number;
}

async function backoffRemaining(): Promise<number> {
  const { [BACKOFF_KEY]: state } = await chrome.storage.session.get<Record<typeof BACKOFF_KEY, BackoffState | undefined>>(
    BACKOFF_KEY,
  );
  return Math.max(0, (state?.lockedUntil || 0) - Date.now());
}

async function recordFailure(): Promise<void> {
  const { [BACKOFF_KEY]: state } = await chrome.storage.session.get<Record<typeof BACKOFF_KEY, BackoffState | undefined>>(
    BACKOFF_KEY,
  );
  const fails = (state?.fails || 0) + 1;
  let lockedUntil = 0;
  if (fails >= BACKOFF_THRESHOLD) {
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (fails - BACKOFF_THRESHOLD), BACKOFF_MAX_MS);
    lockedUntil = Date.now() + delay;
  }
  await chrome.storage.session.set({ [BACKOFF_KEY]: { fails, lockedUntil } });
}

async function clearFailures(): Promise<void> {
  await chrome.storage.session.remove(BACKOFF_KEY);
}

async function assertNotLocked(): Promise<void> {
  const wait = await backoffRemaining();
  if (wait > 0) throw new Error(`Too many attempts — try again in ${Math.ceil(wait / 1000)}s.`);
}

function isNetworkError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Network error');
}

function networkError(): Error {
  return new Error('Network error — check your internet connection.');
}

interface RequestOptions {
  body?: Record<string, unknown>;
  form?: boolean;
  headers?: Record<string, string>;
}

async function request<T>(url: string, { body, form = false, headers = {} }: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: form
        ? { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }
        : { 'Content-Type': 'application/json', ...headers },
      body:
        body === undefined
          ? undefined
          : form
            ? new URLSearchParams(body as Record<string, string>).toString()
            : JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  const data = (await res.json().catch(() => null)) as FirestoreResponse | null;
  if (!res.ok) throw new Error(friendlyError(data?.error?.message || `Request failed (${res.status})`));
  return data as T;
}

// ---------- session ----------
async function getSession(): Promise<AuthSession | null> {
  const { auth = null } = await chrome.storage.local.get<LocalStorage>('auth');
  return auth ?? null;
}

async function saveSession(auth: AuthSession): Promise<AuthSession> {
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(AUTH_KEY);
}

export async function getAuthState(): Promise<AuthUser | null> {
  const auth = await getSession();
  if (!auth) return null;
  if (auth.emailVerified !== true) {
    // Unverified — re-check with Firebase so a just-clicked link is picked up.
    try {
      return await refreshVerifiedFlag(auth);
    } catch {
      /* offline or expired — fall through to the cached value */
    }
  }
  return { uid: auth.uid, email: auth.email, emailVerified: auth.emailVerified === true };
}

async function refreshVerifiedFlag(auth: AuthSession): Promise<AuthUser> {
  const idToken = await getIdToken();
  const data = await request<{ users?: Array<{ emailVerified?: boolean }> }>(identityUrl('accounts:lookup'), {
    body: { idToken },
  });
  const emailVerified = data.users?.[0]?.emailVerified === true;
  await saveSession({ ...auth, emailVerified });
  return { uid: auth.uid, email: auth.email, emailVerified };
}

async function getIdToken({ force = false }: { force?: boolean } = {}): Promise<string> {
  const auth = await getSession();
  if (!auth?.refreshToken) throw new Error('Not signed in.');
  if (!force && auth.idToken && Date.now() < auth.expiresAt - TOKEN_SKEW_MS) return auth.idToken;

  let data: RefreshResponse;
  try {
    data = await request<RefreshResponse>(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`, {
      form: true,
      body: { grant_type: 'refresh_token', refresh_token: auth.refreshToken },
    });
  } catch {
    await clearSession();
    throw new Error('Session expired — please sign in again.');
  }

  const next: AuthSession = {
    ...auth,
    uid: data.user_id || auth.uid,
    idToken: data.id_token,
    refreshToken: data.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  await saveSession(next);
  if (!next.idToken) throw new Error('Session expired — please sign in again.');
  return next.idToken;
}

// ---------- auth ----------
function identityUrl(path: string): string {
  return `https://identitytoolkit.googleapis.com/v1/${path}?key=${FIREBASE_CONFIG.apiKey}`;
}

async function persistAuth(data: IdentityResponse, email: string): Promise<AuthUser> {
  const auth: AuthSession = {
    uid: data.localId || '',
    email: data.email || email,
    emailVerified: data.emailVerified === true,
    idToken: data.idToken,
    refreshToken: data.refreshToken || '',
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  };
  await saveSession(auth);
  return { uid: auth.uid, email: auth.email, emailVerified: auth.emailVerified };
}

async function sendVerificationEmail(idToken: string): Promise<void> {
  await request(identityUrl('accounts:sendOobCode'), {
    body: { requestType: 'VERIFY_EMAIL', idToken },
  });
}

/** Local key recording which account last owned this device's history. */
const LAST_ACCOUNT_KEY = 'lastAccountUid';

export async function signIn(email: string, password: string): Promise<AuthUser> {
  requireConfigured();
  await assertNotLocked();
  let data: IdentityResponse;
  try {
    data = await request<IdentityResponse>(identityUrl('accounts:signInWithPassword'), {
      body: { email, password, returnSecureToken: true },
    });
  } catch (err) {
    if (!isNetworkError(err)) await recordFailure();
    throw err;
  }
  await clearFailures();
  const user = await persistAuth(data, email);
  // Account switch on this device → the previous account's history must not
  // show (or sync) under the new account. Same account / first sign-in keeps
  // the device history so a re-login can merge it back with the cloud copy.
  const { lastAccountUid = null } = await chrome.storage.local.get<LocalStorage>(LAST_ACCOUNT_KEY);
  if (lastAccountUid && lastAccountUid !== user.uid) await chrome.storage.local.set({ history: [] });
  await chrome.storage.local.set({ [LAST_ACCOUNT_KEY]: user.uid });
  await ensureSyncKey(password); // throw → sign-in reports the setup failure
  return user;
}

export async function signUp(email: string, password: string): Promise<AuthUser> {
  requireConfigured();
  await assertNotLocked();
  const data = await request<IdentityResponse>(identityUrl('accounts:signUp'), {
    body: { email, password, returnSecureToken: true },
  });
  const user = await persistAuth(data, email);
  // A brand-new account always starts with a clean device history so it never
  // inherits another account's OCR results.
  await chrome.storage.local.set({ history: [], [LAST_ACCOUNT_KEY]: user.uid });
  // Best-effort: the resend button is available if this fails.
  if (data.idToken) await sendVerificationEmail(data.idToken).catch(() => {});
  await ensureSyncKey(password);
  return user;
}

export async function resendVerification(): Promise<void> {
  requireConfigured();
  const idToken = await getIdToken();
  await sendVerificationEmail(idToken);
}

export async function sendPasswordReset(email: string): Promise<void> {
  requireConfigured();
  await request(identityUrl('accounts:sendOobCode'), {
    body: { requestType: 'PASSWORD_RESET', email },
  });
}

export async function deleteAccount(email: string, password: string): Promise<void> {
  requireConfigured();
  await assertNotLocked();
  // Re-authenticate so the caller must prove ownership of the account.
  let idToken: string | undefined;
  try {
    const data = await request<IdentityResponse>(identityUrl('accounts:signInWithPassword'), {
      body: { email, password, returnSecureToken: true },
    });
    idToken = data.idToken;
  } catch (err) {
    if (!isNetworkError(err)) await recordFailure();
    throw err;
  }
  await clearFailures();
  // Best-effort cloud wipe while the fresh token is valid, then delete the
  // account itself (which also invalidates the tokens).
  await clearCloudHistory().catch(() => {});
  await request(identityUrl('accounts:delete'), { body: { idToken } });
  await clearSession();
  await chrome.storage.local.remove(['history', 'syncKeys', LAST_ACCOUNT_KEY]);
}

export async function signOut(): Promise<void> {
  const auth = await getSession();
  await clearSession();
  // Drop this device's cached sync key — it is re-derived from the password
  // on the next sign-in, so a signed-out profile cannot decrypt cloud data.
  // Remember which account this device belonged to so the next account that
  // signs in can be detected as a switch (history is wiped) vs the same
  // account re-logging in (history is kept and re-merged on sync).
  if (auth) {
    const { syncKeys = {} } = await chrome.storage.local.get<LocalStorage>({ syncKeys: {} });
    delete syncKeys[auth.uid];
    await chrome.storage.local.set({ syncKeys, [LAST_ACCOUNT_KEY]: auth.uid });
  }
}

// ---------- sync encryption key (see background/crypto.ts) ----------
const SYNC_KEYS_LOCAL = 'syncKeys';

interface SyncProfile {
  salt: string; // base64 (32 random bytes)
  wrappedKey: string; // base64(iv‖ct) — syncKey wrapped with PBKDF2(password, salt)
  v?: number;
}

function profileDocUrl(uid: string): string {
  // 4 segments (…/users/{uid}/profile/main) so it is a real document path
  // and matches the documented rule: match /users/{userId}/{doc=**}
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/profile/main`;
}

async function getProfile(uid: string): Promise<SyncProfile | null> {
  const token = await getIdToken();
  const res = await fetch(profileDocUrl(uid), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw await firestoreError(res);
  const doc = (await res.json().catch(() => null)) as FirestoreDoc | null;
  const fields = fromFields(doc?.fields);
  if (typeof fields.salt !== 'string' || typeof fields.wrappedKey !== 'string') return null;
  return { salt: fields.salt, wrappedKey: fields.wrappedKey, v: Number(fields.v) || 1 };
}

async function createProfileIfMissing(uid: string, profile: SyncProfile): Promise<boolean> {
  const token = await getIdToken();
  const res = await fetch(`${profileDocUrl(uid)}?currentDocument.exists=false`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: toFields({ salt: profile.salt, wrappedKey: profile.wrappedKey, v: profile.v || 1 }),
    }),
  });
  if (res.status === 409) return false; // another device created it first
  if (!res.ok) throw await firestoreError(res);
  return true;
}

async function updateProfile(uid: string, profile: SyncProfile): Promise<void> {
  const token = await getIdToken();
  const res = await fetch(profileDocUrl(uid), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: toFields({ salt: profile.salt, wrappedKey: profile.wrappedKey, v: profile.v || 1 }),
    }),
  });
  if (!res.ok) throw await firestoreError(res);
}

/** Raw syncKey for the signed-in account, cached on-device. Null when signed out / not yet set up. */
async function getSyncKey(): Promise<CryptoKey | null> {
  const auth = await getSession();
  if (!auth) return null;
  const { [SYNC_KEYS_LOCAL]: keys = {} } = await chrome.storage.local.get<Record<string, Record<string, string>>>(
    SYNC_KEYS_LOCAL,
  );
  const rawB64 = keys[auth.uid];
  if (!rawB64) return null;
  try {
    return await importSyncKey(unb64(rawB64));
  } catch {
    return null;
  }
}

/**
 * Make sure this device holds the account's syncKey. Called on every
 * sign-in/sign-up with the password (the only moment it is available).
 * - No cloud profile yet → generate a key, wrap it, create the profile.
 * - Profile exists → unwrap it (normal path).
 * - Unwrap fails → password was changed: re-wrap this device's cached key if
 *   we have one, otherwise start a fresh key (older ciphertext becomes
 *   permanently locked, shown as LOCKED_TEXT).
 */
async function ensureSyncKey(password: string): Promise<void> {
  const auth = await getSession();
  if (!auth) return;
  const { [SYNC_KEYS_LOCAL]: keys = {} } = await chrome.storage.local.get<Record<string, Record<string, string>>>(
    SYNC_KEYS_LOCAL,
  );
  const cached = keys[auth.uid];

  let profile = await getProfile(auth.uid);
  const salt = profile ? unb64(profile.salt) : crypto.getRandomValues(new Uint8Array(32));
  let raw: Uint8Array<ArrayBuffer> | null = profile ? await unwrapSyncKey(profile.wrappedKey, password, salt) : null;

  if (!raw) {
    if (profile) {
      raw = cached ? unb64(cached) : generateKeyBytes();
      await updateProfile(auth.uid, { ...profile, wrappedKey: await wrapSyncKey(raw, password, salt) });
    } else {
      raw = generateKeyBytes();
      const wrappedKey = await wrapSyncKey(raw, password, salt);
      const created = await createProfileIfMissing(auth.uid, { salt: b64(salt), wrappedKey, v: 1 });
      if (!created) {
        // Lost a create race with another device — adopt its key.
        profile = await getProfile(auth.uid);
        raw = profile ? await unwrapSyncKey(profile.wrappedKey, password, unb64(profile.salt)) : null;
        if (!raw) throw new Error('Could not set up sync encryption — try signing in again.');
      }
    }
  }

  if (!raw) throw new Error('Could not set up sync encryption — try signing in again.');
  await chrome.storage.local.set({ [SYNC_KEYS_LOCAL]: { ...keys, [auth.uid]: b64(raw) } });
}

// ---------- firestore (REST) ----------
function docsBase(): string {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
}

// Firestore resource name (no host prefix) — required for batchWrite update/delete
function docName(uid: string, id: string): string {
  return `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/history/${id}`;
}

function collectionName(uid: string): string {
  return `${docsBase()}/users/${uid}/history`;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function toValue(value: JsonValue | undefined): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: toFields(value) } };
}

function toFields(obj: Record<string, JsonValue | undefined>): FieldMap {
  const fields: FieldMap = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) fields[key] = toValue(value);
  }
  return fields;
}

function fromValue(value: FirestoreValue | undefined): JsonValue | undefined {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.nullValue !== undefined) return null;
  if (value.mapValue !== undefined) return fromFields(value.mapValue.fields);
  if (value.arrayValue !== undefined) return (value.arrayValue.values || []).map(fromValue) as JsonValue[];
  return undefined;
}

function fromFields(fields?: FieldMap): Record<string, JsonValue> {
  const obj: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const parsed = fromValue(value);
    if (parsed !== undefined) obj[key] = parsed;
  }
  return obj;
}

function entryFields(entry: OCRHistoryEntry): FieldMap {
  const fields = toFields({
    text: entry.text || '',
    confidence: entry.confidence || 0,
    timestamp: entry.timestamp || Date.now(),
    language: entry.language || 'eng',
  });
  if (entry.area) {
    fields.area = toValue({ x: entry.area.x, y: entry.area.y, width: entry.area.width, height: entry.area.height });
  }
  return fields;
}

function parseDoc(doc: FirestoreDoc): OCRHistoryEntry | null {
  const id = String(doc?.name || '').split('/').pop();
  if (!id) return null;
  const fields = fromFields(doc.fields);
  const text = fields.text;
  if (typeof text !== 'string' || !text) return null;
  const entry: OCRHistoryEntry = {
    id,
    text,
    confidence: Number(fields.confidence) || 0,
    timestamp: Number(fields.timestamp) || 0,
    language: typeof fields.language === 'string' ? fields.language : 'eng',
  };
  const area = fields.area;
  if (area && typeof area === 'object' && !Array.isArray(area)) {
    const { x, y, width, height } = area;
    if ([x, y, width, height].every((n) => typeof n === 'number')) {
      entry.area = { x: x as number, y: y as number, width: width as number, height: height as number };
    }
  }
  return entry;
}

async function firestoreError(res: Response): Promise<Error> {
  let message = `Request failed (${res.status})`;
  try {
    const data = (await res.json()) as FirestoreResponse;
    message = data?.error?.message || message;
  } catch {
    /* keep default message */
  }
  if (res.status === 401 || res.status === 403) {
    await clearSession();
    return new Error('Session expired — please sign in again.');
  }
  return new Error(message);
}

async function firestoreFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string): Promise<Response> =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });

  let token = await getIdToken();
  let res: Response;
  try {
    res = await doFetch(token);
  } catch {
    throw networkError();
  }
  if (res.status === 401) {
    token = await getIdToken({ force: true });
    try {
      res = await doFetch(token);
    } catch {
      throw networkError();
    }
  }
  return res;
}

interface CloudHistory {
  entries: OCRHistoryEntry[];
  /** Ids of cloud docs still stored as pre-encryption plaintext. */
  legacyIds: Set<string>;
}

async function listHistoryCloud(): Promise<CloudHistory> {
  const empty: CloudHistory = { entries: [], legacyIds: new Set() };
  const auth = await getSession();
  if (!auth) return empty;
  requireConfigured();
  const res = await firestoreFetch(`${collectionName(auth.uid)}?pageSize=${HISTORY_LIMIT}`);
  if (res.status === 404) return empty; // Firestore database not created yet
  if (!res.ok) throw await firestoreError(res);
  const data = (await res.json().catch(() => ({}))) as FirestoreResponse;
  const key = await getSyncKey();
  const entries: OCRHistoryEntry[] = [];
  const legacyIds = new Set<string>();
  for (const doc of data.documents || []) {
    const entry = parseDoc(doc);
    if (!entry) continue;
    if (entry.text.startsWith(ENC_PREFIX)) {
      const plain = key ? await decryptText(entry.text, key) : null;
      entry.text = plain ?? LOCKED_TEXT;
    } else {
      legacyIds.add(entry.id);
    }
    entries.push(entry);
  }
  return { entries, legacyIds };
}

async function listHistory(): Promise<OCRHistoryEntry[]> {
  return (await listHistoryCloud()).entries;
}

async function batchWrite(writes: Record<string, unknown>[]): Promise<void> {
  if (!writes.length) return;
  const auth = await getSession();
  if (!auth) return;
  requireConfigured();
  const res = await firestoreFetch(`${docsBase()}:batchWrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw await firestoreError(res);
}

async function putEntries(entries: OCRHistoryEntry[]): Promise<void> {
  if (!entries.length) return;
  const auth = await getSession();
  if (!auth) return;
  const key = await getSyncKey();
  if (!key) throw new Error('Sync encryption key unavailable — sign out and sign in again to restore it.');
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const writes: Record<string, unknown>[] = [];
    for (const entry of entries.slice(i, i + WRITE_CHUNK)) {
      const fields = entryFields({ ...entry, text: await encryptText(entry.text || '', key) });
      writes.push({ update: { name: docName(auth.uid, entry.id), fields } });
    }
    await batchWrite(writes);
  }
}

async function deleteEntries(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const auth = await getSession();
  if (!auth) return;
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    const writes = ids.slice(i, i + WRITE_CHUNK).map((id) => ({ delete: docName(auth.uid, id) }));
    await batchWrite(writes);
  }
}

// ---------- public API (used by the background service worker) ----------
export async function pushEntry(entry: OCRHistoryEntry): Promise<void> {
  if (!entry?.text) return;
  const auth = await getSession();
  if (!auth) return; // signed out — local history only
  if (auth.emailVerified !== true) return; // silent — UI shows the verify banner
  await putEntries([entry]);
}

export async function removeEntryFromCloud(id: string): Promise<void> {
  const auth = await getSession();
  if (!auth) return;
  await deleteEntries([id]);
}

export async function clearCloudHistory(): Promise<void> {
  const auth = await getSession();
  if (!auth) return;
  const docs = await listHistory();
  await deleteEntries(docs.map((doc) => doc.id));
}

export async function syncHistory(): Promise<SyncStats> {
  requireConfigured();
  const auth = await getSession();
  if (!auth) throw new Error('Not signed in.');
  if (auth.emailVerified !== true) throw new Error('Verify your email address to enable sync.');
  if (!(await getSyncKey())) throw new Error('Sync encryption key unavailable — sign out and sign in again to restore it.');

  const { entries: cloud, legacyIds } = await listHistoryCloud();
  const { history: local = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });

  const byId = new Map<string, OCRHistoryEntry>();
  for (const entry of cloud) byId.set(entry.id, entry);
  for (const entry of local) byId.set(entry.id, entry); // local copy wins on id collision

  const merged = [...byId.values()]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ history: merged });

  const mergedIds = new Set(merged.map((entry) => entry.id));
  const cloudIds = new Set(cloud.map((entry) => entry.id));
  const toUpload = merged.filter((entry) => !cloudIds.has(entry.id));
  // Pre-encryption cloud docs: rewrite them encrypted under the same id.
  const toEncrypt = merged.filter((entry) => legacyIds.has(entry.id));
  const toDelete = cloud.filter((entry) => !mergedIds.has(entry.id)).map((entry) => entry.id);

  await putEntries([...toUpload, ...toEncrypt]);
  await deleteEntries(toDelete);

  return { uploaded: toUpload.length + toEncrypt.length, removed: toDelete.length, total: merged.length };
}
