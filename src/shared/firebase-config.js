// Firebase project config — fill these in from your Firebase console:
// Project settings -> General -> Your apps -> Web app -> SDK setup and configuration -> Config
// Then enable Authentication -> Sign-in method -> Email/Password,
// and create a Cloud Firestore database.
export const FIREBASE_CONFIG = {
  apiKey: '', // e.g. "AIzaSy..."
  authDomain: '', // e.g. "my-app.firebaseapp.com"
  projectId: '', // e.g. "my-app"
};

export function isFirebaseConfigured() {
  return Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}
