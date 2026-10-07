import { FIREBASE_CONFIG, isFirebaseConfigured } from '../shared/firebase-config.js';
import {
  ENC_PREFIX,
  LOCKED_TEXT,
  b64,
  unb64,
  generateKeyBytes,
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
  INVALID_LOGIN_URL: 'Firebase is not configured correctly.',
  ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL:
    'This Google email already has an account created with a password. In the Firebase console (Authentication → Users), delete that old user, then sign in with Google again.',
  FEDERATED_USER_ID_ALREADY_LINKED: 'This Google account is already linked to a different sign-in.',
  INVALID_IDP_RESPONSE: 'Google sign-in failed — try again.',
  INVALID_PROVIDER_ID: 'Google sign-in is not enabled for this Firebase project.',
  OPERATION_NOT_ALLOWED: 'Google sign-in is not enabled in the Firebase console (Authentication → Sign-in method → Google).',
  PROJECT_DISABLED: 'This Firebase project is disabled.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
};

/** Error table for the email sign-in link flow (same codes, other wording). */
const EMAIL_ERROR_MESSAGES: Record<string, string> = {
  ...AUTH_ERROR_MESSAGES,
  OPERATION_NOT_ALLOWED:
    'Email login is not enabled — in the Firebase console open Authentication → Sign-in method and enable Email/Password.',
  INVALID_OOB_CODE: 'That login link is invalid or was already used — send a new one.',
  EXPIRED_OOB_CODE: 'That login link has expired — send a new one.',
  INVALID_EMAIL: 'Enter a valid email address.',
  MISSING_EMAIL: 'Enter a valid email address.',
  USER_NOT_FOUND: 'No account for that email yet — send the link again and wait a moment.',
};

function friendlyError(raw: string, kind: 'google' | 'email' = 'google'): string {
  const code = String(raw || '').split(':')[0].trim();
  const table = kind === 'email' ? EMAIL_ERROR_MESSAGES : AUTH_ERROR_MESSAGES;
  return table[code] || AUTH_ERROR_MESSAGES[code] || raw || 'Request failed.';
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
  /** Which error-message table to use — Google sign-in vs email link login. */
  kind?: 'google' | 'email';
}

async function request<T>(url: string, { body, form = false, headers = {}, kind = 'google' }: RequestOptions = {}): Promise<T> {
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
  if (!res.ok) throw new Error(friendlyError(data?.error?.message || `Request failed (${res.status})`, kind));
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
  return { uid: auth.uid, email: auth.email, emailVerified: auth.emailVerified === true };
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

/** Local key recording which account last owned this device's history. */
const LAST_ACCOUNT_KEY = 'lastAccountUid';

/** Ask Chrome for a Google OAuth access token (opens the Google account picker). */
async function getGoogleAccessToken(): Promise<string> {
  if (typeof chrome.identity?.getAuthToken !== 'function') {
    throw new Error('Google sign-in is unavailable — reload the extension (the "identity" permission may be missing).');
  }
  let token: string;
  try {
    const res = (await chrome.identity.getAuthToken({ interactive: true })) as { token?: string } | string;
    token = typeof res === 'string' ? res : res?.token || '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/oauth|client.?id|manifest/i.test(message)) {
      throw new Error('Google sign-in is not configured — add googleClientId to firebase-secrets.json and rebuild.');
    }
    throw new Error('Google sign-in was cancelled or failed — try again.');
  }
  if (!token) throw new Error('Google sign-in returned no token — try again.');
  return token;
}

/** Drop this extension's cached Google token so the next sign-in shows the account picker. */
async function dropGoogleToken(): Promise<void> {
  try {
    const res = (await chrome.identity.getAuthToken({ interactive: false })) as { token?: string } | string;
    const token = typeof res === 'string' ? res : res?.token;
    if (token) await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    /* no cached token */
  }
}

/** Exchange the Google access token for a Firebase session (sign-in or first-time link). */
async function signInWithGoogleIdp(): Promise<IdentityResponse> {
  const accessToken = await getGoogleAccessToken();
  let data: IdentityResponse;
  try {
    data = await request<IdentityResponse>(identityUrl('accounts:signInWithIdp'), {
      body: {
        postBody: `access_token=${accessToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnSecureToken: true,
      },
    });
  } catch (err) {
    if (!isNetworkError(err)) await recordFailure();
    throw err;
  }
  await clearFailures();
  if (!data.localId || !data.refreshToken) throw new Error('Google sign-in failed — try again.');
  return data;
}

export async function signInWithGoogle(): Promise<AuthUser> {
  requireConfigured();
  await assertNotLocked();
  const data = await signInWithGoogleIdp();
  return finishSignIn(data, data.email || '');
}

/**
 * Persist a fresh Identity Toolkit session and prepare this device for sync.
 * Account switch on this device → the previous account's history must not
 * show (or sync) under the new account. Same account keeps the device
 * history so it can be merged back with the cloud copy on sync.
 */
async function finishSignIn(data: IdentityResponse, email: string): Promise<AuthUser> {
  const user = await persistAuth(data, email);
  const { lastAccountUid = null } = await chrome.storage.local.get<LocalStorage>(LAST_ACCOUNT_KEY);
  if (lastAccountUid && lastAccountUid !== user.uid) await chrome.storage.local.set({ history: [] });
  await chrome.storage.local.set({ [LAST_ACCOUNT_KEY]: user.uid });
  await ensureSyncKey(); // throw → login reports the setup failure
  // Silent merge/upload right after any sign-in (popup, sidepanel, page) so a
  // fresh install pulls the cloud history back without opening the dashboard.
  void syncHistory().catch((err: unknown) =>
    console.warn('[auth] post-sign-in sync failed:', err instanceof Error ? err.message : String(err)),
  );
  return user;
}

// ---------- email sign-in link (passwordless, like a one-time login code) ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pull the oobCode out of a pasted Firebase action link (or accept a bare code). */
function extractOobCode(pasted: string): string {
  const value = String(pasted || '')
    .trim()
    .replace(/^['"<(\[]+/, '')
    .replace(/['">)\]]+$/, '');
  if (!value) return '';
  const fromUrl = /[?&#]oobCode=([^&\s]+)/.exec(value);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]);
    } catch {
      return fromUrl[1];
    }
  }
  return /^[A-Za-z0-9_-]{10,}$/.test(value) ? value : '';
}

/** Send the passwordless email sign-in link (Firebase EMAIL_SIGNIN out-of-band code). */
export async function sendLoginEmail(email: string): Promise<void> {
  requireConfigured();
  await assertNotLocked();
  const addr = String(email || '').trim();
  if (!EMAIL_RE.test(addr) || addr.length >= 256) throw new Error('Enter a valid email address.');
  await request(identityUrl('accounts:sendOobCode'), {
    kind: 'email',
    body: { requestType: 'EMAIL_SIGNIN', email: addr, canHandleCodeInApp: true },
  });
}

/** Complete the email login: paste the emailed link (or the bare oobCode). */
export async function loginWithEmail(email: string, pasted: string): Promise<AuthUser> {
  requireConfigured();
  await assertNotLocked();
  const addr = String(email || '').trim();
  if (!EMAIL_RE.test(addr)) throw new Error('Enter a valid email address.');
  const oobCode = extractOobCode(pasted);
  if (!oobCode) throw new Error('Paste the login link (or the code) from your email.');
  let data: IdentityResponse;
  try {
    data = await request<IdentityResponse>(identityUrl('accounts:signInWithEmailLink'), {
      kind: 'email',
      body: { email: addr, oobCode },
    });
  } catch (err) {
    if (!isNetworkError(err)) await recordFailure();
    throw err;
  }
  await clearFailures();
  if (!data.localId || !data.refreshToken) throw new Error('Login failed — try again.');
  return finishSignIn(data, addr);
}

export async function deleteAccount(): Promise<void> {
  requireConfigured();
  const auth = await getSession();
  if (!auth) throw new Error('Not signed in.');
  await assertNotLocked();

  // Best-effort cloud wipe while the session is still valid.
  await clearCloudHistory().catch(() => {});

  const finishDelete = async (): Promise<void> => {
    await dropGoogleToken();
    await clearSession();
    await chrome.storage.local.remove(['history', 'syncKeys', LAST_ACCOUNT_KEY]);
  };

  // Prefer the session's own (freshly refreshed) token — no extra prompts.
  // If Firebase demands a newer login, re-confirm with Google.
  const sessionToken = await getIdToken({ force: true }).catch(() => null);
  if (sessionToken) {
    try {
      await request(identityUrl('accounts:delete'), { body: { idToken: sessionToken } });
      await finishDelete();
      return;
    } catch (err) {
      if (isNetworkError(err)) throw err;
    }
  }
  try {
    const data = await signInWithGoogleIdp();
    if (!data.idToken) throw new Error('Could not re-authenticate — try again.');
    await request(identityUrl('accounts:delete'), { body: { idToken: data.idToken } });
  } catch (err) {
    if (err instanceof Error && err.message === AUTH_ERROR_MESSAGES.ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL) {
      throw new Error(
        'This account logs in with email, so Google cannot re-confirm it. Log out, log back in with your email link, and delete the account within a minute of logging in — or delete the user in the Firebase console (Authentication → Users).',
      );
    }
    throw err;
  }
  await finishDelete();
}

export async function signOut(): Promise<void> {
  const auth = await getSession();
  // While signed in the database is the store — copy it back to this device so
  // history stays available (chrome.storage.local) after signing out.
  if (auth) {
    try {
      await chrome.storage.local.set({ history: await listHistory() });
    } catch {
      /* offline — keep whatever local copy exists */
    }
  }
  await clearSession();
  await dropGoogleToken();
  // Drop this device's cached sync key — it is re-fetched from the account
  // profile on the next sign-in, so a signed-out profile cannot decrypt cloud data.
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
  /** Raw base64 syncKey — readable only by the signed-in owner (Firestore rules). */
  syncKey?: string;
  /** Legacy password-wrapped form (pre-Google accounts). */
  salt?: string;
  wrappedKey?: string;
  v?: number;
}

function profileDocUrl(uid: string): string {
  // 4 segments (…/users/{uid}/profile/main) so it is a real document path
  // and matches the documented rule: match /users/{userId}/{doc=**}
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/profile/main`;
}

function profileFields(profile: SyncProfile): FieldMap {
  const obj: Record<string, JsonValue | undefined> = { v: profile.v || 1 };
  if (profile.syncKey) obj.syncKey = profile.syncKey;
  if (profile.salt) obj.salt = profile.salt;
  if (profile.wrappedKey) obj.wrappedKey = profile.wrappedKey;
  return toFields(obj);
}

async function getProfile(uid: string): Promise<SyncProfile | null> {
  const token = await getIdToken();
  const res = await fetch(profileDocUrl(uid), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw await firestoreError(res);
  const doc = (await res.json().catch(() => null)) as FirestoreDoc | null;
  const fields = fromFields(doc?.fields);
  const profile: SyncProfile = {};
  if (typeof fields.syncKey === 'string') profile.syncKey = fields.syncKey;
  if (typeof fields.salt === 'string') profile.salt = fields.salt;
  if (typeof fields.wrappedKey === 'string') profile.wrappedKey = fields.wrappedKey;
  if (fields.v !== undefined) profile.v = Number(fields.v) || 1;
  if (!profile.syncKey && !profile.wrappedKey) return null;
  return profile;
}

async function createProfileIfMissing(uid: string, profile: SyncProfile): Promise<boolean> {
  const token = await getIdToken();
  const res = await fetch(`${profileDocUrl(uid)}?currentDocument.exists=false`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: profileFields(profile) }),
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
    body: JSON.stringify({ fields: profileFields(profile) }),
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
 * Make sure this device holds the account's syncKey.
 * - Profile has a raw syncKey → cache it locally (normal path).
 * - Device has a cached key but no cloud key yet → publish it.
 * - Nothing anywhere → generate a fresh key and store it in the profile.
 * - Legacy password-wrapped profile → rotate to a raw key (the password is
 *   gone after the Google migration; old ciphertext becomes LOCKED_TEXT).
 */
async function ensureSyncKey(): Promise<void> {
  const auth = await getSession();
  if (!auth) return;
  const { [SYNC_KEYS_LOCAL]: keys = {} } = await chrome.storage.local.get<Record<string, Record<string, string>>>(
    SYNC_KEYS_LOCAL,
  );
  const cached = keys[auth.uid];
  const cache = (value: string): Promise<void> =>
    chrome.storage.local.set({ [SYNC_KEYS_LOCAL]: { ...keys, [auth.uid]: value } });

  const profile = await getProfile(auth.uid);

  if (profile?.syncKey) {
    if (cached !== profile.syncKey) await cache(profile.syncKey);
    return;
  }

  if (cached) {
    // This device already has a key — publish it to the profile.
    if (profile) await updateProfile(auth.uid, { ...profile, syncKey: cached, v: 2 });
    else if (!(await createProfileIfMissing(auth.uid, { syncKey: cached, v: 1 }))) {
      const again = await getProfile(auth.uid);
      if (again?.syncKey) await cache(again.syncKey);
      else if (again) await updateProfile(auth.uid, { ...again, syncKey: cached, v: 2 });
    }
    return;
  }

  // Nothing cached and nothing usable in the cloud — start fresh.
  const syncKey = b64(generateKeyBytes());
  if (profile) {
    await updateProfile(auth.uid, { ...profile, syncKey, v: 2 });
  } else if (!(await createProfileIfMissing(auth.uid, { syncKey, v: 1 }))) {
    // Lost a create race with another device — adopt its key.
    const again = await getProfile(auth.uid);
    if (!again?.syncKey) throw new Error('Could not set up sync encryption — try signing in again.');
    await cache(again.syncKey);
    return;
  }
  await cache(syncKey);
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
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { entries, legacyIds };
}

/** Cloud history, newest first — the primary store while signed in. */
export async function listHistory(): Promise<OCRHistoryEntry[]> {
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
  if (!(await getSyncKey())) {
    // First sync after sign-in / a legacy profile — (re)create or fetch the key.
    await ensureSyncKey();
    if (!(await getSyncKey())) throw new Error('Sync encryption key unavailable — sign out and sign in again to restore it.');
  }

  const { entries: cloud, legacyIds } = await listHistoryCloud();
  const { history: local = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });

  // While signed in the account database is the store. chrome.storage.local
  // only holds staging entries that have not reached the cloud yet (written
  // offline or while signed out) — push them up, then empty the staging area.
  const cloudIds = new Set(cloud.map((entry) => entry.id));
  const merged = [...cloud, ...local.filter((entry) => !cloudIds.has(entry.id))]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, HISTORY_LIMIT);

  const mergedIds = new Set(merged.map((entry) => entry.id));
  const toUpload = merged.filter((entry) => !cloudIds.has(entry.id));
  // Pre-encryption cloud docs: rewrite them encrypted under the same id.
  const toEncrypt = merged.filter((entry) => legacyIds.has(entry.id));
  const toDelete = cloud.filter((entry) => !mergedIds.has(entry.id)).map((entry) => entry.id);

  await putEntries([...toUpload, ...toEncrypt]);
  await deleteEntries(toDelete);
  await chrome.storage.local.set({ history: [] });

  // Open UIs read through GET_HISTORY (cloud) — nudge them to reload.
  chrome.runtime.sendMessage({ type: 'HISTORY_UPDATED' }).catch(() => {});

  return { uploaded: toUpload.length + toEncrypt.length, removed: toDelete.length, total: merged.length };
}
