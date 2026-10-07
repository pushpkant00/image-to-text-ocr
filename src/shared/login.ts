/** Shared Login card — Buyhatke-style: Continue with Google, or a 6-digit
 *  email OTP ("Continue via OTP Verification" → "Verify Your Email").
 *  Rendered as a centered page (auth/signin.html) or as an overlay modal
 *  inside the toolbar popup / side panel. */

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
  resendAt?: number;
  expiresAt?: number;
  alreadySent?: boolean;
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

const ENVELOPE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="26" height="26">' +
  '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
  '<path d="m3 7 9 6 9-6"/>' +
  '</svg>';

const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="13" height="13">' +
  '<path d="M12 20h9"/>' +
  '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
  '</svg>';

const CARD_HTML = `
  <div class="login-brand">
    <img src="../icons/icon128.png" alt="" class="login-icon" width="48" height="48">
    <h1 class="login-title">Login to Continue</h1>
    <p class="login-sub">Sync your history across your devices</p>
  </div>

  <div class="login-head2 hidden">
    <span class="login-otp-icon">${ENVELOPE_SVG}</span>
    <h1 class="login-title">Verify Your Email</h1>
    <p class="login-sub">Enter the OTP received on <b class="login-email-echo"></b>
      <button type="button" class="login-edit" aria-label="Change email">${PENCIL_SVG}</button>
    </p>
  </div>

  <div class="login-status hidden" role="alert"></div>

  <div class="login-panel1">
    <button type="button" class="login-google">
      ${GOOGLE_SVG}
      <span class="login-google-label">Continue with Google</span>
    </button>

    <div class="login-divider"><span>Or</span></div>

    <form class="login-email-step" novalidate>
      <p class="login-email-title">Continue via OTP Verification</p>
      <input type="email" class="login-input login-email-input" placeholder="Enter Email"
             autocomplete="email" spellcheck="false" aria-label="Email address" required>
      <button type="submit" class="login-primary login-send">Send OTP</button>
    </form>
  </div>

  <form class="login-otp-step hidden" novalidate>
    <input type="text" class="login-input login-otp-input" placeholder="000000"
           inputmode="numeric" pattern="[0-9]*" maxlength="6"
           autocomplete="one-time-code" spellcheck="false" aria-label="6-digit code" required>
    <button type="submit" class="login-primary login-verify" disabled>Continue</button>
    <button type="button" class="login-link login-resend" disabled>Resend Code</button>
  </form>

  <p class="login-hint">Your screenshots never leave your device. Sync is optional and stores only
    recognized text in your own account.</p>

  <p class="login-agree hidden">By continuing, you agree to receive a one-time verification code
    to this email address.</p>

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
  const brandHead = $('.login-brand');
  const head2 = $('.login-head2');
  const panel1 = $('.login-panel1');
  const otpStep = $<HTMLFormElement>('.login-otp-step');
  const emailStep = $<HTMLFormElement>('.login-email-step');
  const googleBtn = $<HTMLButtonElement>('.login-google');
  const googleLabel = $('.login-google-label');
  const emailInput = $<HTMLInputElement>('.login-email-input');
  const otpInput = $<HTMLInputElement>('.login-otp-input');
  const sendBtn = $<HTMLButtonElement>('.login-send');
  const verifyBtn = $<HTMLButtonElement>('.login-verify');
  const resendBtn = $<HTMLButtonElement>('.login-resend');
  const editBtn = $<HTMLButtonElement>('.login-edit');
  const emailEcho = $('.login-email-echo');
  const hint = $('.login-hint');
  const agree = $('.login-agree');
  const configHint = $('.login-config-hint');
  const footer = $('.login-footer');
  const laterBtn = $<HTMLButtonElement>('.login-later');

  const SEND_LABEL = 'Send OTP';
  const VERIFY_LABEL = 'Continue';

  let busy = false;
  let sentTo = '';
  let resendTimer: number | undefined;
  let resendPending = false;

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

  function updateVerifyEnabled(): void {
    verifyBtn.disabled = busy || otpInput.value.replace(/\D/g, '').length !== 6;
  }

  function setBusy(value: boolean): void {
    busy = value;
    googleBtn.disabled = value;
    sendBtn.disabled = value;
    googleLabel.textContent = value ? 'Waiting for Google…' : 'Continue with Google';
    sendBtn.textContent = value ? 'Sending…' : SEND_LABEL;
    verifyBtn.textContent = value ? 'Verifying…' : VERIFY_LABEL;
    if (!resendPending) resendBtn.disabled = value;
    updateVerifyEnabled();
  }

  function stopCountdown(): void {
    if (resendTimer !== undefined) {
      window.clearInterval(resendTimer);
      resendTimer = undefined;
    }
  }

  function startCountdown(until: number): void {
    stopCountdown();
    resendPending = true;
    const tick = (): void => {
      if (!document.contains(resendBtn)) {
        stopCountdown(); // card was removed (overlay closed / page navigated)
        return;
      }
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) {
        resendBtn.disabled = true;
        resendBtn.textContent = `Resend Code in ${left}s`;
        return;
      }
      resendPending = false;
      resendBtn.disabled = busy;
      resendBtn.textContent = 'Resend Code';
      stopCountdown();
    };
    tick();
    resendTimer = window.setInterval(tick, 500);
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

  function goStep2(resendAt: number, alreadySent: boolean): void {
    stopCountdown();
    brandHead.classList.add('hidden');
    panel1.classList.add('hidden');
    hint.classList.add('hidden');
    head2.classList.remove('hidden');
    otpStep.classList.remove('hidden');
    agree.classList.remove('hidden');
    otpInput.value = '';
    updateVerifyEnabled();
    setStatus(alreadySent ? 'A code was already sent to this address.' : 'Code sent — check your inbox.', 'success');
    startCountdown(resendAt);
    setTimeout(() => otpInput.focus(), 0);
  }

  function goStep1(): void {
    stopCountdown();
    resendPending = false;
    resendBtn.disabled = true;
    resendBtn.textContent = 'Resend Code';
    head2.classList.add('hidden');
    otpStep.classList.add('hidden');
    agree.classList.add('hidden');
    brandHead.classList.remove('hidden');
    panel1.classList.remove('hidden');
    hint.classList.remove('hidden');
    setStatus('');
    if (sentTo) emailInput.value = sentTo;
    setTimeout(() => emailInput.focus(), 0);
  }

  /** Step 1 → email a fresh 6-digit code. */
  async function sendOtp(): Promise<void> {
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
      setStatus(res.error || 'Could not send the code — try again.', 'error');
      return;
    }
    sentTo = addr;
    emailEcho.textContent = addr;
    goStep2(res.resendAt ?? Date.now() + 30_000, res.alreadySent === true);
  }

  /** Step 2 → verify the 6-digit code. */
  async function verifyCode(): Promise<void> {
    const code = otpInput.value.replace(/\D/g, '');
    if (code.length !== 6) {
      setStatus('Enter the 6-digit code from your email.', 'error');
      otpInput.focus();
      return;
    }
    setBusy(true);
    setStatus('');
    const res = await sendMessage({ type: 'AUTH_LOGIN_WITH_EMAIL', email: sentTo, code });
    if (!res.ok || !res.user) {
      setStatus(res.error || 'That code did not work — request a new one.', 'error');
      setBusy(false);
      return;
    }
    await finish(res.user);
  }

  emailStep.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!busy) void sendOtp();
  });
  otpStep.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!busy) void verifyCode();
  });
  otpInput.addEventListener('input', () => {
    const clean = otpInput.value.replace(/\D/g, '').slice(0, 6);
    if (clean !== otpInput.value) otpInput.value = clean;
    updateVerifyEnabled();
  });
  resendBtn.addEventListener('click', () => {
    if (busy || resendPending) return;
    void sendOtp();
  });
  editBtn.addEventListener('click', () => {
    if (busy) return;
    goStep1();
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
