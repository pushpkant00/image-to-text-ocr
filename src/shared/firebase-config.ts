// Firebase project config — fill these in from your Firebase console:
// Project settings -> General -> Your apps -> Web app -> SDK setup and configuration -> Config
// Then enable Authentication -> Sign-in method -> Email/Password,
// and create a Cloud Firestore database.
export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export const FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: 'AIzaSyAKO2433a1I7OHTCZaFtZLQkYAco3Ix4hE',
  authDomain: 'extension-a6144.firebaseapp.com',
  projectId: 'extension-a6144',
};

export function isFirebaseConfigured(): boolean {
  return Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}
