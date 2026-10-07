import { mountLoginCard } from '../shared/login.js';

interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
  configured?: boolean;
  googleAuth?: boolean;
}

document.addEventListener('DOMContentLoaded', () => {
  const shell = document.getElementById('login-shell');
  if (!shell) throw new Error('#login-shell not found');

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  }

  function goToDashboard(): void {
    window.location.replace('dashboard.html');
  }

  // Already logged in? Skip straight to the dashboard. Otherwise surface a
  // setup hint when Firebase / the Google OAuth client is not configured yet.
  void (async () => {
    const res = await sendMessage({ type: 'AUTH_STATE' });
    if (res?.ok && res.user) {
      goToDashboard();
      return;
    }
    let hint: string | undefined;
    if (res?.ok && !res.configured) {
      hint =
        'Cloud sync is off — add your Firebase config (apiKey, authDomain, projectId) to firebase-secrets.json and rebuild.';
    } else if (res?.ok && !res.googleAuth) {
      hint = 'Google login is not configured — add googleClientId to firebase-secrets.json and rebuild.';
    }
    mountLoginCard(shell, {
      hint,
      onSignedIn: goToDashboard,
      onClose: () => {
        window.close();
        setTimeout(() => history.back(), 120);
      },
    });
  })();
});
