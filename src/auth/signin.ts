interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
  configured?: boolean;
  googleAuth?: boolean;
}

document.addEventListener('DOMContentLoaded', () => {
  const q = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
  };

  const googleBtn = q<HTMLButtonElement>('google-btn');
  const googleBtnLabel = q<HTMLSpanElement>('google-btn-label');
  const statusEl = q<HTMLDivElement>('auth-status');
  const configHint = q<HTMLDivElement>('config-hint');
  const closeBtn = q<HTMLButtonElement>('close-btn');

  let busy = false;

  function setStatus(message: string, kind = ''): void {
    statusEl.textContent = message;
    statusEl.classList.remove('hidden', 'error', 'success', 'warn');
    if (message) statusEl.classList.add(kind);
    else statusEl.classList.add('hidden');
  }

  function setBusy(value: boolean): void {
    busy = value;
    googleBtn.disabled = value;
    googleBtnLabel.textContent = value ? 'Waiting for Google…' : 'Continue with Google';
  }

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  }

  function goToDashboard(): void {
    window.location.replace('dashboard.html');
  }

  async function handleGoogleSignIn(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      const res = await sendMessage({ type: 'AUTH_SIGN_IN_GOOGLE' });
      if (!res?.ok) {
        setStatus(res?.error || 'Sign-in failed — try again.', 'error');
        return;
      }
      goToDashboard();
    } catch {
      setStatus('Sign-in failed — reload the extension and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  googleBtn.addEventListener('click', () => void handleGoogleSignIn());
  closeBtn.addEventListener('click', () => {
    window.close();
    setTimeout(() => history.back(), 120);
  });

  // Already signed in? Skip straight to the dashboard. Otherwise surface a
  // setup hint when Firebase / the Google OAuth client is not configured yet.
  void (async () => {
    const res = await sendMessage({ type: 'AUTH_STATE' });
    if (res?.ok && res.user) {
      goToDashboard();
      return;
    }
    if (!res?.ok) return;
    if (!res.configured) {
      configHint.textContent =
        'Cloud sync is off — add your Firebase config (apiKey, authDomain, projectId) to firebase-secrets.json and rebuild.';
      configHint.classList.remove('hidden');
    } else if (!res.googleAuth) {
      configHint.textContent =
        'Google sign-in is not configured — add googleClientId to firebase-secrets.json and rebuild.';
      configHint.classList.remove('hidden');
    }
  })();
});
