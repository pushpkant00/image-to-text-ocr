import { FIREBASE_CONFIG, isFirebaseConfigured } from '../shared/firebase-config.js';

const AUTH_KEY = 'auth';
const HISTORY_LIMIT = 100;
const TOKEN_SKEW_MS = 60_000;
const WRITE_CHUNK = 400;

const AUTH_ERROR_MESSAGES = {
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

function friendlyError(raw) {
  const code = String(raw || '').split(':')[0].trim();
  return AUTH_ERROR_MESSAGES[code] || raw || 'Request failed.';
}

function requireConfigured() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured — add your project keys in src/shared/firebase-config.js');
  }
}

function networkError() {
  return new Error('Network error — check your internet connection.');
}

async function request(url, { body, form = false, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: form
        ? { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }
        : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(friendlyError(data?.error?.message || `Request failed (${res.status})`));
  return data;
}

// ---------- session ----------
async function getSession() {
  const { auth = null } = await chrome.storage.local.get('auth');
  return auth;
}

async function saveSession(auth) {
  await chrome.storage.local.set({ auth });
  return auth;
}

async function clearSession() {
  await chrome.storage.local.remove('auth');
}

export async function getAuthState() {
  const auth = await getSession();
  if (!auth) return null;
  return { uid: auth.uid, email: auth.email };
}

async function getIdToken({ force = false } = {}) {
  const auth = await getSession();
  if (!auth?.refreshToken) throw new Error('Not signed in.');
  if (!force && auth.idToken && Date.now() < auth.expiresAt - TOKEN_SKEW_MS) return auth.idToken;

  let data;
  try {
    data = await request(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`, {
      form: true,
      body: { grant_type: 'refresh_token', refresh_token: auth.refreshToken },
    });
  } catch {
    await clearSession();
    throw new Error('Session expired — please sign in again.');
  }

  const next = {
    uid: data.user_id || auth.uid,
    email: auth.email,
    idToken: data.id_token,
    refreshToken: data.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  await saveSession(next);
  return next.idToken;
}

// ---------- auth ----------
function identityUrl(path) {
  return `https://identitytoolkit.googleapis.com/v1/${path}?key=${FIREBASE_CONFIG.apiKey}`;
}

async function persistAuth(data, email) {
  const auth = {
    uid: data.localId,
    email: data.email || email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  };
  await saveSession(auth);
  return { uid: auth.uid, email: auth.email };
}

export async function signIn(email, password) {
  requireConfigured();
  const data = await request(identityUrl('accounts:signInWithPassword'), {
    body: { email, password, returnSecureToken: true },
  });
  return persistAuth(data, email);
}

export async function signUp(email, password) {
  requireConfigured();
  const data = await request(identityUrl('accounts:signUp'), {
    body: { email, password, returnSecureToken: true },
  });
  return persistAuth(data, email);
}

export async function signOut() {
  await clearSession();
}

// ---------- firestore (REST) ----------
function docsBase() {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
}

// Firestore resource name (no host prefix) — required for batchWrite update/delete
function docName(uid, id) {
  return `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/history/${id}`;
}

function collectionName(uid) {
  return `${docsBase()}/users/${uid}/history`;
}

function toValue(value) {
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: toFields(value) } };
}

function toFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) fields[key] = toValue(value);
  }
  return fields;
}

function fromValue(value) {
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('mapValue' in value) return fromFields(value.mapValue?.fields);
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(fromValue);
  return undefined;
}

function fromFields(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) obj[key] = fromValue(value);
  return obj;
}

function entryFields(entry) {
  const fields = toFields({
    text: entry.text || '',
    confidence: entry.confidence || 0,
    timestamp: entry.timestamp || Date.now(),
    language: entry.language || 'eng',
  });
  if (entry.area) fields.area = toValue(entry.area);
  return fields;
}

function parseDoc(doc) {
  const id = String(doc?.name || '').split('/').pop();
  if (!id) return null;
  const fields = fromFields(doc.fields);
  if (typeof fields.text !== 'string' || !fields.text) return null;
  return {
    id,
    text: fields.text,
    confidence: Number(fields.confidence) || 0,
    timestamp: Number(fields.timestamp) || 0,
    language: fields.language || 'eng',
    ...(fields.area ? { area: fields.area } : {}),
  };
}

async function firestoreError(res) {
  let message = `Request failed (${res.status})`;
  try {
    const data = await res.json();
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

async function firestoreFetch(url, init = {}) {
  const doFetch = (token) =>
    fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });

  let token = await getIdToken();
  let res;
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

async function listHistory() {
  const auth = await getSession();
  if (!auth) return [];
  requireConfigured();
  const res = await firestoreFetch(`${collectionName(auth.uid)}?pageSize=${HISTORY_LIMIT}`);
  if (res.status === 404) return []; // Firestore database not created yet
  if (!res.ok) throw await firestoreError(res);
  const data = await res.json().catch(() => ({}));
  return (data.documents || []).map(parseDoc).filter(Boolean);
}

async function putEntries(entries) {
  if (!entries.length) return;
  const auth = await getSession();
  if (!auth) return;
  requireConfigured();
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const writes = entries.slice(i, i + WRITE_CHUNK).map((entry) => ({
      update: { name: docName(auth.uid, entry.id), fields: entryFields(entry) },
    }));
    const res = await firestoreFetch(`${docsBase()}:batchWrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
    if (!res.ok) throw await firestoreError(res);
  }
}

async function deleteEntries(ids) {
  if (!ids.length) return;
  const auth = await getSession();
  if (!auth) return;
  requireConfigured();
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    const writes = ids.slice(i, i + WRITE_CHUNK).map((id) => ({ delete: docName(auth.uid, id) }));
    const res = await firestoreFetch(`${docsBase()}:batchWrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
    if (!res.ok) throw await firestoreError(res);
  }
}

// ---------- public API (used by the background service worker) ----------
export async function pushEntry(entry) {
  if (!entry?.text) return;
  const auth = await getSession();
  if (!auth) return; // signed out — local history only
  await putEntries([entry]);
}

export async function removeEntryFromCloud(id) {
  const auth = await getSession();
  if (!auth) return;
  await deleteEntries([id]);
}

export async function clearCloudHistory() {
  const auth = await getSession();
  if (!auth) return;
  const docs = await listHistory();
  await deleteEntries(docs.map((doc) => doc.id));
}

export async function syncHistory() {
  requireConfigured();
  const auth = await getSession();
  if (!auth) throw new Error('Not signed in.');

  const cloud = await listHistory();
  const { history: local = [] } = await chrome.storage.local.get({ history: [] });

  const byId = new Map();
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
