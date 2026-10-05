interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
  configured?: boolean;
}

document.addEventListener('DOMContentLoaded', () => {
  const q = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
  };

  const form = q<HTMLFormElement>('auth-form');
  const brandSub = q<HTMLParagraphElement>('brand-sub');
  const emailInput = q<HTMLInputElement>('auth-email');
  const passwordInput = q<HTMLInputElement>('auth-password');
  const statusEl = q<HTMLDivElement>('auth-status');
  const submitBtn = q<HTMLButtonElement>('sign-in-btn');
  const toggleBtn = q<HTMLButtonElement>('sign-up-btn');
  const configHint = q<HTMLDivElement>('config-hint');
  const closeBtn = q<HTMLButtonElement>('close-btn');

  let mode: 'signin' | 'signup' = 'signin';
  let busy = false;

  function setStatus(message: string, kind = ''): void {
    statusEl.textContent = message;
    statusEl.classList.remove('hidden', 'error', 'success', 'warn');
    if (message) statusEl.classList.add(kind);
    else statusEl.classList.add('hidden');
  }

  function submitLabel(): string {
    if (busy) return mode === 'signup' ? 'Creating account…' : 'Signing in…';
    return mode === 'signup' ? 'Create Account' : 'Sign In';
  }

  function setMode(next: 'signin' | 'signup'): void {
    mode = next;
    setStatus('');
    const signup = mode === 'signup';
    brandSub.textContent = signup
      ? 'Create an account to sync your history across your devices'
      : 'Sign in to sync your history across your devices';
    submitBtn.textContent = submitLabel();
    toggleBtn.textContent = signup ? 'Back to sign in' : 'Create Account';
    passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    passwordInput.placeholder = signup ? 'At least 8 characters' : 'Your password';
    emailInput.focus();
  }

  function setBusy(value: boolean): void {
    busy = value;
    submitBtn.disabled = value;
    toggleBtn.disabled = value;
    submitBtn.textContent = submitLabel();
  }

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  }

  function goToDashboard(): void {
    window.location.replace('dashboard.html');
  }

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setStatus(
        mode === 'signup'
          ? 'Enter your email and password to create your account.'
          : 'Enter your email and password.',
        'error',
      );
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setStatus('Password must be at least 8 characters.', 'error');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await sendMessage({ type: mode === 'signup' ? 'AUTH_SIGN_UP' : 'AUTH_SIGN_IN', email, password });
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
    void handleSubmit();
  });
  toggleBtn.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
  closeBtn.addEventListener('click', () => {
    window.close();
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
