// Firebase project config — values are injected at build time from the
// gitignored firebase-secrets.json (see inject-config.ts).
// Setup: copy firebase-secrets.example.json -> firebase-secrets.json and fill in
// your values (Firebase console -> Project settings -> Your apps -> Web app -> Config).
// Without that file the extension still builds; sign-in and cloud sync stay disabled.
export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export const FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: '__FIREBASE_API_KEY__',
  authDomain: '__FIREBASE_AUTH_DOMAIN__',
  projectId: '__FIREBASE_PROJECT_ID__',
};

export function isFirebaseConfigured(): boolean {
  const { apiKey, projectId } = FIREBASE_CONFIG;
  // placeholders were not replaced => no firebase-secrets.json at build time
  return Boolean(apiKey && projectId && !apiKey.startsWith('__'));
}
