/** Shared Login card — Buyhatke-style: Continue with Google, or an email
 *  sign-in link. Rendered as a centered page (auth/signin.html) or as an
 *  overlay modal inside the toolbar popup / side panel. */

export interface LoginOptions {
  /** 'page' = stand-alone centered card; 'overlay' = modal over the host UI. */
  mode: 'page' | 'overlay';
  /** Called once after a successful login (host updates its UI / navigates). */
  onSignedIn: (user: AuthUser) => void;
  /** Page mode: "Not now" button. Overlay: × button, backdrop click, Esc. */
  onClose?: () => void;
  /** Setup hint shown when Firebase / googleClientId is missing. */
  hint?: string;
}

export type LoginHostOptions = Omit<LoginOptions, 'mode'>;

interface LoginResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
}

async function sendMessage(message: BackgroundRequest): Promise<LoginResponse> {
  try {
    const res = (await chrome.runtime.sendMessage(message)) as LoginResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  } catch {
    return { ok: false, error: 'Login failed — reload the extension and try again.' };
  }
}

const GOOGLE_SVG =
  '<svg viewBox="0 0 18 18" aria-hidden="true">' +
  '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/>' +
  '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>' +
  '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>' +
  '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>' +
  '</svg>';

const CARD_HTML = `
  <div class="login-brand">
    <img src="../icons/icon128.png" alt="" class="login-icon" width="48" height="48">
    <h1 class="login-title">Login to Continue</h1>
    <p class="login-sub">Sync your history across your devices</p>
  </div>

  <div class="login-status hidden" role="alert"></div>

  <button type="button" class="login-google">
    ${GOOGLE_SVG}
    <span class="login-google-label">Continue with Google</span>
  </button>

  <div class="login-divider"><span>Or</span></div>

  <form class="login-email-step" novalidate>
    <p class="login-email-title">Continue via Email Verification</p>
    <input type="email" class="login-input login-email-input" placeholder="Enter Email"
           autocomplete="email" spellcheck="false" aria-label="Email address" required>
    <button type="submit" class="login-primary login-send">Send Login Link</button>
  </form>

  <form class="login-code-step hidden" novalidate>
    <p class="login-email-title">Check your email</p>
    <p class="login-email-hint">We sent a login link to <b class="login-email-echo"></b>. Open it,
      then paste the link (or the code) below.</p>
    <input type="text" class="login-input login-code-input" placeholder="Paste link or code"
           autocomplete="one-time-code" spellcheck="false" aria-label="Login link or code" required>
    <button type="submit" class="login-primary login-verify">Verify &amp; Login</button>
    <div class="login-step-actions">
      <button type="button" class="login-link login-back">Use a different email</button>
      <button type="button" class="login-link login-resend">Resend link</button>
    </div>
  </form>

  <p class="login-hint">Your screenshots never leave your device. Sync is optional and stores only
    recognized text in your own account.</p>

  <div class="login-config-hint hidden"></div>

  <div class="login-footer hidden">
    <button type="button" class="login-later">Not now — continue without an account</button>
  </div>`;

function renderCard(opts: LoginOptions, hooks: { close?: () => void }): HTMLElement {
  const card = document.createElement('div');
  card.className = 'login-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', String(opts.mode === 'overlay'));
  card.setAttribute('aria-label', 'Login');
  card.innerHTML = CARD_HTML;

  const $ = <T extends HTMLElement>(selector: string): T => {
    const el = card.querySelector<T>(selector);
    if (!el) throw new Error(`login card: ${selector} missing`);
    return el;
  };

  const status = $('.login-status');
  const googleBtn = $<HTMLButtonElement>('.login-google');
  const googleLabel = $('.login-google-label');
  const emailStep = $<HTMLFormElement>('.login-email-step');
  const codeStep = $<HTMLFormElement>('.login-code-step');
  const emailInput = $<HTMLInputElement>('.login-email-input');
  const codeInput = $<HTMLInputElement>('.login-code-input');
  const sendBtn = $<HTMLButtonElement>('.login-send');
  const verifyBtn = $<HTMLButtonElement>('.login-verify');
  const resendBtn = $<HTMLButtonElement>('.login-resend');
  const backBtn = $<HTMLButtonElement>('.login-back');
  const emailEcho = $('.login-email-echo');
  const configHint = $('.login-config-hint');
  const footer = $('.login-footer');
  const laterBtn = $<HTMLButtonElement>('.login-later');

  let busy = false;
  let sentTo = '';

  if (opts.mode === 'overlay') {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'login-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => hooks.close?.());
    card.prepend(closeBtn); // visually top-right and first in tab order
  } else {
    footer.classList.remove('hidden');
    laterBtn.addEventListener('click', () => opts.onClose?.());
  }

  if (opts.hint) {
    configHint.textContent = opts.hint;
    configHint.classList.remove('hidden');
  }

  function setStatus(message = '', kind?: 'error' | 'success' | 'warn'): void {
    status.textContent = message;
    status.classList.toggle('hidden', !message);
    status.classList.remove('error', 'success', 'warn');
    if (message && kind) status.classList.add(kind);
  }

  function setBusy(value: boolean): void {
    busy = value;
    googleBtn.disabled = value;
    sendBtn.disabled = value;
    verifyBtn.disabled = value;
    resendBtn.disabled = value;
    backBtn.disabled = value;
    googleLabel.textContent = value ? 'Waiting for Google…' : 'Continue with Google';
  }

  async function finish(user: AuthUser): Promise<void> {
    if (opts.mode === 'overlay') {
      setStatus('Logged in', 'success');
      opts.onSignedIn(user);
      setTimeout(() => hooks.close?.(), 700);
      return;
    }
    opts.onSignedIn(user); // page mode — the host navigates away
  }

  googleBtn.addEventListener('click', () => {
    if (busy) return;
    setBusy(true);
    setStatus('');
    void (async () => {
      const res = await sendMessage({ type: 'AUTH_SIGN_IN_GOOGLE' });
      if (!res.ok || !res.user) {
        setStatus(res.error || 'Login failed — try again.', 'error');
        setBusy(false);
        return;
      }
      await finish(res.user);
    })();
  });

  /** Step 1 → email the sign-in link. */
  async function sendLink(): Promise<void> {
    const addr = emailInput.value.trim();
    if (!addr) {
      setStatus('Enter your email address.', 'error');
      emailInput.focus();
      return;
    }
    setBusy(true);
    setStatus('');
    const res = await sendMessage({ type: 'AUTH_SEND_LOGIN_EMAIL', email: addr });
    setBusy(false);
    if (!res.ok) {
      setStatus(res.error || 'Could not send the login link — try again.', 'error');
      return;
    }
    sentTo = addr;
    emailEcho.textContent = addr;
    codeInput.value = '';
    emailStep.classList.add('hidden');
    codeStep.classList.remove('hidden');
    setStatus(`We sent a login link to ${addr}. Paste it below to log in.`, 'success');
    codeInput.focus();
  }

  // Step 2 → redeem the pasted link/code.
  async function verifyCode(): Promise<void> {
    const code = codeInput.value.trim();
    if (!code) {
      setStatus('Paste the login link (or the code) from your email.', 'error');
      codeInput.focus();
      return;
    }
    setBusy(true);
    setStatus('');
    const res = await sendMessage({ type: 'AUTH_LOGIN_WITH_EMAIL', email: sentTo, code });
    if (!res.ok || !res.user) {
      setStatus(res.error || 'That link did not work — send a new one.', 'error');
      setBusy(false);
      return;
    }
    await finish(res.user);
  }

  emailStep.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!busy) void sendLink();
  });
  codeStep.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!busy) void verifyCode();
  });
  resendBtn.addEventListener('click', () => {
    if (busy) return;
    emailInput.value = sentTo;
    codeStep.classList.add('hidden');
    emailStep.classList.remove('hidden');
    setStatus('');
    void sendLink();
  });
  backBtn.addEventListener('click', () => {
    if (busy) return;
    codeStep.classList.add('hidden');
    emailStep.classList.remove('hidden');
    setStatus('');
    emailInput.focus();
  });

  setTimeout(() => emailInput.focus(), 0);
  return card;
}

/** Page mode: render the card into a container (e.g. .login-shell). */
export function mountLoginCard(container: HTMLElement, opts: LoginHostOptions): void {
  container.appendChild(renderCard({ ...opts, mode: 'page' }, {}));
}

/** Overlay mode: open the card as a modal over the host page. */
export function openLoginModal(opts: LoginHostOptions): void {
  const overlay = document.createElement('div');
  overlay.className = 'login-overlay';

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.classList.remove('login-open'); // popup grows back to fit its content
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  overlay.appendChild(renderCard({ ...opts, mode: 'overlay' }, { close }));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  document.body.classList.add('login-open'); // hosts may size the viewport to fit (see popup.css)
  document.addEventListener('keydown', onKey);
}
