// Injects the real Firebase config from the gitignored firebase-secrets.json
// into dist/shared/firebase-config.js. Runs after `tsc` (see package.json build).
// Without the secrets file the build still succeeds — markers stay in place and
// isFirebaseConfigured() reports false, so sign-in/cloud sync remain disabled.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const secretsPath = join(root, 'firebase-secrets.json');
const target = join(root, 'dist', 'shared', 'firebase-config.js');

if (!existsSync(target)) {
  console.error('[config] dist/shared/firebase-config.js missing — run tsc first.');
  process.exit(1);
}

if (!existsSync(secretsPath)) {
  console.warn('[config] firebase-secrets.json not found — building with auth disabled.');
  console.warn('[config] copy firebase-secrets.example.json to firebase-secrets.json to enable sign-in/sync.');
  process.exit(0);
}

type Secrets = { apiKey?: string; authDomain?: string; projectId?: string; googleClientId?: string };
const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as Secrets;

const pairs: Array<[string, string | undefined]> = [
  ['__FIREBASE_API_KEY__', secrets.apiKey],
  ['__FIREBASE_AUTH_DOMAIN__', secrets.authDomain],
  ['__FIREBASE_PROJECT_ID__', secrets.projectId],
];

let out = readFileSync(target, 'utf8');
let empty = 0;
for (const [marker, value] of pairs) {
  if (!value) {
    empty++;
    continue;
  }
  out = out.split(marker).join(value);
}
writeFileSync(target, out);

if (empty > 0 || out.includes('__FIREBASE_')) {
  console.warn(`[config] ${empty} value(s) empty in firebase-secrets.json — placeholders remain, auth stays disabled.`);
} else {
  console.log('[config] Firebase config injected -> dist/shared/firebase-config.js');
}

// Google OAuth client id -> dist/manifest.json identity.oauth2 (chrome.identity.getAuthToken).
const manifestPath = join(root, 'dist', 'manifest.json');
if (secrets.googleClientId) {
  if (!existsSync(manifestPath)) {
    console.error('[config] dist/manifest.json missing — run build.ts first.');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const identity = (manifest.identity as Record<string, unknown> | undefined) || {};
  manifest.identity = { ...identity, oauth2: { client_id: secrets.googleClientId } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('[config] Google OAuth client id injected -> dist/manifest.json');
} else {
  console.warn('[config] googleClientId missing in firebase-secrets.json — "Continue with Google" will report a setup error.');
}
