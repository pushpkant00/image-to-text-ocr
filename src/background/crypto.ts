// Client-side encryption for synced OCR history.
//
// Key hierarchy (Google-only sign-in):
//   syncKey = random 256-bit AES-GCM data key, stored base64 in the account's
//             private Firestore profile (users/{uid}/profile) and cached
//             per-uid in chrome.storage.local. Firestore security rules keep
//             every users/{uid} document readable only by its owner.
// History text is encrypted with the syncKey before upload (enc:v1:), so
// plain text never travels over the network or sits at rest in Firestore.

export const ENC_PREFIX = 'enc:v1:';
export const LOCKED_TEXT =
  'Locked entry — could not decrypt. It was encrypted with an older encryption key this device no longer has access to.';

const IV_BYTES = 12; // standard AES-GCM nonce length
const KEY_BYTES = 32; // AES-256

export function b64(bytes: Uint8Array<ArrayBuffer>): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

export function unb64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesGcmEncrypt(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64(out);
}

async function aesGcmDecrypt(key: CryptoKey, payload: string): Promise<Uint8Array<ArrayBuffer> | null> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unb64(payload);
  } catch {
    return null;
  }
  if (bytes.length <= IV_BYTES) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
      key,
      bytes.slice(IV_BYTES),
    );
    return new Uint8Array(plain);
  } catch {
    return null; // tampered / wrong key
  }
}

export function generateKeyBytes(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export async function importSyncKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt one history text field → `enc:v1:<base64(iv‖ct)>`. */
export async function encryptText(text: string, key: CryptoKey): Promise<string> {
  return ENC_PREFIX + (await aesGcmEncrypt(key, new TextEncoder().encode(text)));
}

/** Decrypt an `enc:v1:` value. Null = not decryptable (corrupt / wrong key). */
export async function decryptText(value: string, key: CryptoKey): Promise<string | null> {
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext — pass through
  const plain = await aesGcmDecrypt(key, value.slice(ENC_PREFIX.length));
  if (!plain) return null;
  return new TextDecoder().decode(plain);
}
