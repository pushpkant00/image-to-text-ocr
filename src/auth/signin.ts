interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
  configured?: boolean;
  stats?: SyncStats;
}

document.addEventListener('DOMContentLoaded', () => {
  const q = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
  };

  const form = q<HTMLFormElement>('auth-form');
  const emailInput = q<HTMLInputElement>('auth-email');
  const passwordInput = q<HTMLInputElement>('auth-password');
  const statusEl = q<HTMLDivElement>('auth-status');
  const signInBtn = q<HTMLButtonElement>('sign-in-btn');
  const signUpBtn = q<HTMLButtonElement>('sign-up-btn');
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
    signInBtn.disabled = value;
    signUpBtn.disabled = value;
    signInBtn.textContent = value ? 'Signing in…' : 'Sign In';
  }

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  }

  function goToDashboard(): void {
    window.location.replace('dashboard.html');
  }

  async function handleAuth(kind: 'AUTH_SIGN_IN' | 'AUTH_SIGN_UP'): Promise<void> {
    if (busy) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setStatus('Enter your email and password.', 'error');
      return;
    }
    if (kind === 'AUTH_SIGN_UP' && password.length < 8) {
      setStatus('Password must be at least 8 characters.', 'error');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await sendMessage({ type: kind, email, password });
      if (!res?.ok) {
        setStatus(res?.error || 'Sign-in failed', 'error');
        return;
      }
      passwordInput.value = '';
      goToDashboard();
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void handleAuth('AUTH_SIGN_IN');
  });
  signUpBtn.addEventListener('click', () => void handleAuth('AUTH_SIGN_UP'));
  closeBtn.addEventListener('click', () => {
    window.close();
    // If the browser refuses to close a non-script-opened tab, fall back to history.
    setTimeout(() => history.back(), 120);
  });

  // Already signed in? Skip straight to the dashboard.
  void (async () => {
    const res = await sendMessage({ type: 'AUTH_STATE' });
    if (res?.ok && res.user) {
      goToDashboard();
      return;
    }
    configHint.classList.toggle('hidden', !(res?.ok && !res.configured));
  })();
});
