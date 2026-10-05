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
  const emailError = q<HTMLParagraphElement>('email-error');
  const passwordError = q<HTMLParagraphElement>('password-error');
  const errorSummary = q<HTMLDivElement>('error-summary');
  const togglePwBtn = q<HTMLButtonElement>('toggle-password');
  const forgotBtn = q<HTMLButtonElement>('forgot-btn');
  const statusEl = q<HTMLDivElement>('auth-status');
  const submitBtn = q<HTMLButtonElement>('sign-in-btn');
  const signInTab = q<HTMLButtonElement>('sign-in-tab');
  const signUpTab = q<HTMLButtonElement>('sign-up-tab');
  const configHint = q<HTMLDivElement>('config-hint');
  const closeBtn = q<HTMLButtonElement>('close-btn');

  let mode: 'signin' | 'signup' = 'signin';
  let busy = false;

  // ---------- status + errors ----------
  function setStatus(message: string, kind = ''): void {
    statusEl.textContent = message;
    statusEl.classList.remove('hidden', 'error', 'success', 'warn');
    if (message) statusEl.classList.add(kind);
    else statusEl.classList.add('hidden');
  }

  function setFieldError(input: HTMLInputElement, errorEl: HTMLParagraphElement, message: string): void {
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
    input.classList.toggle('invalid', !!message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearErrors(): void {
    setFieldError(emailInput, emailError, '');
    setFieldError(passwordInput, passwordError, '');
    errorSummary.classList.add('hidden');
    errorSummary.textContent = '';
  }

  function showSummary(links: { href: string; text: string }[]): void {
    errorSummary.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'There is a problem';
    const list = document.createElement('ul');
    for (const item of links) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.text;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(item.href)?.focus();
      });
      li.appendChild(a);
      list.appendChild(li);
    }
    errorSummary.append(title, list);
    errorSummary.classList.remove('hidden');
  }

  function validate(): boolean {
    clearErrors();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const problems: { href: string; text: string }[] = [];

    if (!email) {
      setFieldError(emailInput, emailError, 'Enter your email address.');
      problems.push({ href: '#auth-email', text: 'Enter your email address' });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(emailInput, emailError, 'Enter a valid email address.');
      problems.push({ href: '#auth-email', text: 'Enter a valid email address' });
    }

    if (!password) {
      setFieldError(passwordInput, passwordError, 'Enter your password.');
      problems.push({ href: '#auth-password', text: 'Enter your password' });
    } else if (mode === 'signup' && password.length < 8) {
      setFieldError(passwordInput, passwordError, 'Password must be at least 8 characters.');
      problems.push({ href: '#auth-password', text: 'Password must be at least 8 characters' });
    }

    if (problems.length === 0) return true;
    if (problems.length > 1) {
      showSummary(problems);
      errorSummary.focus();
    } else {
      document.querySelector<HTMLInputElement>(problems[0].href)?.focus();
    }
    return false;
  }

  // ---------- mode ----------
  function submitLabel(): string {
    if (busy) return mode === 'signup' ? 'Creating account…' : 'Signing in…';
    return mode === 'signup' ? 'Create Account' : 'Sign In';
  }

  function setMode(next: 'signin' | 'signup'): void {
    mode = next;
    setStatus('');
    clearErrors();
    const signup = mode === 'signup';
    signInTab.classList.toggle('active', !signup);
    signInTab.setAttribute('aria-selected', String(!signup));
    signUpTab.classList.toggle('active', signup);
    signUpTab.setAttribute('aria-selected', String(signup));
    brandSub.textContent = signup
      ? 'Create an account to sync your history across your devices'
      : 'Sign in to sync your history across your devices';
    submitBtn.textContent = submitLabel();
    forgotBtn.hidden = signup;
    passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    passwordInput.placeholder = signup ? 'At least 8 characters' : 'Your password';
    emailInput.focus();
  }

  function setBusy(value: boolean): void {
    busy = value;
    submitBtn.disabled = value;
    forgotBtn.disabled = value;
    signInTab.disabled = value;
    signUpTab.disabled = value;
    submitBtn.textContent = submitLabel();
  }

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  }

  function goToDashboard(): void {
    window.location.replace('dashboard.html');
  }

  // ---------- submit ----------
  async function handleSubmit(): Promise<void> {
    if (busy || !validate()) return;
    setBusy(true);
    setStatus('');
    try {
      const res = await sendMessage({
        type: mode === 'signup' ? 'AUTH_SIGN_UP' : 'AUTH_SIGN_IN',
        email: emailInput.value.trim(),
        password: passwordInput.value,
      });
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

  // ---------- forgot password ----------
  async function handleForgot(): Promise<void> {
    if (busy) return;
    clearErrors();
    setStatus('');
    const email = emailInput.value.trim();
    if (!email) {
      setFieldError(emailInput, emailError, 'Enter your email address first, then request a reset.');
      emailInput.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(emailInput, emailError, 'Enter a valid email address.');
      emailInput.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await sendMessage({ type: 'AUTH_RESET_PASSWORD', email });
      if (!res?.ok) {
        setStatus(res?.error || 'Could not send the reset email.', 'error');
        return;
      }
      setStatus(`Password reset email sent to ${email} — check your inbox and spam folder.`, 'success');
    } finally {
      setBusy(false);
    }
  }

  // ---------- password visibility ----------
  togglePwBtn.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    togglePwBtn.classList.toggle('visible', !showing);
    togglePwBtn.setAttribute('aria-pressed', String(!showing));
    const label = showing ? 'Show password' : 'Hide password';
    togglePwBtn.setAttribute('aria-label', label);
    togglePwBtn.title = label;
  });

  // clear a field's error as soon as the user edits it
  emailInput.addEventListener('input', () => {
    if (!emailError.classList.contains('hidden')) setFieldError(emailInput, emailError, '');
  });
  passwordInput.addEventListener('input', () => {
    if (!passwordError.classList.contains('hidden')) setFieldError(passwordInput, passwordError, '');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void handleSubmit();
  });
  signInTab.addEventListener('click', () => setMode('signin'));
  signUpTab.addEventListener('click', () => setMode('signup'));
  forgotBtn.addEventListener('click', () => void handleForgot());
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
