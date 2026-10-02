import { FIREBASE_CONFIG, isFirebaseConfigured } from '../shared/firebase-config.js';

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
  return { uid: auth.uid, email: auth.email };
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
    uid: data.user_id || auth.uid,
    email: auth.email,
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
    idToken: data.idToken,
    refreshToken: data.refreshToken || '',
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  };
  await saveSession(auth);
  return { uid: auth.uid, email: auth.email };
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  requireConfigured();
  const data = await request<IdentityResponse>(identityUrl('accounts:signInWithPassword'), {
    body: { email, password, returnSecureToken: true },
  });
  return persistAuth(data, email);
}

export async function signUp(email: string, password: string): Promise<AuthUser> {
  requireConfigured();
  const data = await request<IdentityResponse>(identityUrl('accounts:signUp'), {
    body: { email, password, returnSecureToken: true },
  });
  return persistAuth(data, email);
}

export async function signOut(): Promise<void> {
  await clearSession();
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

async function listHistory(): Promise<OCRHistoryEntry[]> {
  const auth = await getSession();
  if (!auth) return [];
  requireConfigured();
  const res = await firestoreFetch(`${collectionName(auth.uid)}?pageSize=${HISTORY_LIMIT}`);
  if (res.status === 404) return []; // Firestore database not created yet
  if (!res.ok) throw await firestoreError(res);
  const data = (await res.json().catch(() => ({}))) as FirestoreResponse;
  return (data.documents || []).map(parseDoc).filter((e): e is OCRHistoryEntry => e !== null);
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
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const writes = entries.slice(i, i + WRITE_CHUNK).map((entry) => ({
      update: { name: docName(auth.uid, entry.id), fields: entryFields(entry) },
    }));
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

  const cloud = await listHistory();
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
  const toDelete = cloud.filter((entry) => !mergedIds.has(entry.id)).map((entry) => entry.id);

  await putEntries(toUpload);
  await deleteEntries(toDelete);

  return { uploaded: toUpload.length, removed: toDelete.length, total: merged.length };
}
