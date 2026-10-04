interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
  configured?: boolean;
  stats?: SyncStats;
  history?: OCRHistoryEntry[];
}

document.addEventListener('DOMContentLoaded', () => {
  const q = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
  };

  const qs = <T extends HTMLElement>(selector: string): T => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`${selector} not found`);
    return el as T;
  };

  const historyList = q<HTMLDivElement>('history-list');
  const searchInput = q<HTMLInputElement>('search-input');
  const filterLanguage = q<HTMLSelectElement>('filter-language');
  const clearHistoryBtn = q<HTMLButtonElement>('clear-history-btn');
  const detailPanel = q<HTMLDivElement>('detail-panel');
  const detailText = q<HTMLDivElement>('detail-text');
  const copyDetailBtn = q<HTMLButtonElement>('copy-detail-btn');
  const backBtn = q<HTMLButtonElement>('back-btn');
  const headerTitle = qs<HTMLHeadingElement>('.header h2');
  const filters = qs<HTMLElement>('.filters');

  // account / cloud sync
  const accountCard = q<HTMLDivElement>('account-card');
  const signedOutView = q<HTMLDivElement>('signed-out-view');
  const signedInView = q<HTMLDivElement>('signed-in-view');
  const authEmail = q<HTMLInputElement>('auth-email');
  const authPassword = q<HTMLInputElement>('auth-password');
  const authStatus = q<HTMLDivElement>('auth-status');
  const signInBtn = q<HTMLButtonElement>('sign-in-btn');
  const signUpBtn = q<HTMLButtonElement>('sign-up-btn');
  const configHint = q<HTMLDivElement>('config-hint');
  const accountAvatar = q<HTMLSpanElement>('account-avatar');
  const accountEmail = q<HTMLSpanElement>('account-email');
  const syncStatus = q<HTMLDivElement>('sync-status');
  const syncBtn = q<HTMLButtonElement>('sync-btn');
  const signOutBtn = q<HTMLButtonElement>('sign-out-btn');
  const verifyBanner = q<HTMLDivElement>('verify-banner');
  const resendBtn = q<HTMLButtonElement>('resend-btn');
  const verifiedBtn = q<HTMLButtonElement>('verified-btn');
  const deleteAccountBtn = q<HTMLButtonElement>('delete-account-btn');
  const deleteConfirm = q<HTMLDivElement>('delete-confirm');
  const deletePassword = q<HTMLInputElement>('delete-password');
  const deleteStatus = q<HTMLDivElement>('delete-status');
  const deleteConfirmBtn = q<HTMLButtonElement>('delete-confirm-btn');
  const deleteCancelBtn = q<HTMLButtonElement>('delete-cancel-btn');

  let history: OCRHistoryEntry[] = [];
  let currentDetail: OCRHistoryEntry | null = null;
  let currentUser: AuthUser | null = null;
  let busy = false;

  function setStatus(el: HTMLElement, message: string, kind = ''): void {
    el.textContent = message;
    el.classList.remove('hidden', 'error', 'success', 'warn');
    if (message) el.classList.add(kind);
    else el.classList.add('hidden');
  }

  function setBusy(value: boolean): void {
    busy = value;
    [signInBtn, signUpBtn, signOutBtn, resendBtn, verifiedBtn, deleteAccountBtn, deleteConfirmBtn, deleteCancelBtn].forEach(
      (b) => {
        b.disabled = value;
      },
    );
    syncBtn.disabled = value || currentUser?.emailVerified !== true;
  }

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from background' };
  }

  async function refreshAccount(): Promise<AuthUser | null> {
    const res = await sendMessage({ type: 'AUTH_STATE' });
    const user = res?.ok ? res.user ?? null : null;
    currentUser = user;
    signedOutView.classList.toggle('hidden', Boolean(user));
    signedInView.classList.toggle('hidden', !user);
    configHint.classList.toggle('hidden', !(res?.ok && !res.configured));
    verifyBanner.classList.toggle('hidden', !user || user.emailVerified === true);
    syncBtn.disabled = busy || user?.emailVerified !== true;
    if (user) {
      accountEmail.textContent = user.email || '';
      accountAvatar.textContent = (user.email || '?').trim().charAt(0).toUpperCase() || '?';
    }
    return user;
  }

  async function syncNow(showStatus = true): Promise<boolean> {
    const res = await sendMessage({ type: 'SYNC_HISTORY' });
    if (res?.ok && showStatus) {
      const { total = 0, uploaded = 0 } = res.stats || {};
      setStatus(syncStatus, `Synced · ${total} item${total === 1 ? '' : 's'}${uploaded ? ` · ${uploaded} uploaded` : ''}`, 'success');
    } else if (!res?.ok && showStatus) {
      setStatus(syncStatus, res?.error || 'Sync failed', 'error');
    }
    if (res?.ok) await loadHistory();
    return Boolean(res?.ok);
  }

  async function handleAuth(kind: 'AUTH_SIGN_IN' | 'AUTH_SIGN_UP'): Promise<void> {
    if (busy) return;
    const email = authEmail.value.trim();
    const password = authPassword.value;
    if (!email || !password) {
      setStatus(authStatus, 'Enter your email and password.', 'error');
      return;
    }
    if (kind === 'AUTH_SIGN_UP' && password.length < 8) {
      setStatus(authStatus, 'Password must be at least 8 characters.', 'error');
      return;
    }
    setBusy(true);
    try {
      setStatus(authStatus, kind === 'AUTH_SIGN_UP' ? 'Creating account…' : 'Signing in…');
      const res = await sendMessage({ type: kind, email, password });
      if (!res?.ok) {
        setStatus(authStatus, res?.error || 'Sign-in failed', 'error');
        return;
      }
      setStatus(authStatus, '');
      authPassword.value = '';
      const user = await refreshAccount();
      if (user && user.emailVerified !== true) {
        setStatus(
          syncStatus,
          kind === 'AUTH_SIGN_UP'
            ? 'Account created — open the verification email to enable sync.'
            : 'Verify your email to enable sync.',
          'warn',
        );
      } else {
        setStatus(syncStatus, 'Merging history…');
        await syncNow(true);
      }
    } finally {
      setBusy(false);
    }
  }

  signInBtn.addEventListener('click', () => handleAuth('AUTH_SIGN_IN'));
  signUpBtn.addEventListener('click', () => handleAuth('AUTH_SIGN_UP'));
  authPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAuth('AUTH_SIGN_IN');
  });
  syncBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(syncStatus, 'Syncing…');
      await syncNow(true);
    } finally {
      setBusy(false);
    }
  });
  signOutBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await sendMessage({ type: 'AUTH_SIGN_OUT' });
      setStatus(syncStatus, '');
      await refreshAccount();
    } finally {
      setBusy(false);
    }
  });

  resendBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await sendMessage({ type: 'AUTH_RESEND_VERIFY' });
      setStatus(
        syncStatus,
        res?.ok ? 'Verification email resent — check your inbox.' : res?.error || 'Could not send the email.',
        res?.ok ? 'success' : 'error',
      );
    } finally {
      setBusy(false);
    }
  });

  verifiedBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      // AUTH_STATE re-checks with Firebase while the session is unverified.
      const user = await refreshAccount();
      if (user?.emailVerified) {
        setStatus(syncStatus, 'Email verified — sync enabled.', 'success');
        await syncNow(true);
      } else {
        setStatus(syncStatus, 'Not verified yet — click the link in your email, then try again.', 'warn');
      }
    } finally {
      setBusy(false);
    }
  });

  deleteAccountBtn.addEventListener('click', () => {
    deleteConfirm.classList.toggle('hidden');
    setStatus(deleteStatus, '');
    deletePassword.value = '';
    if (!deleteConfirm.classList.contains('hidden')) deletePassword.focus();
  });
  deleteCancelBtn.addEventListener('click', () => {
    deleteConfirm.classList.add('hidden');
    setStatus(deleteStatus, '');
    deletePassword.value = '';
  });

  async function doDeleteAccount(): Promise<void> {
    if (busy || !currentUser) return;
    const password = deletePassword.value;
    if (!password) {
      setStatus(deleteStatus, 'Enter your password to confirm.', 'error');
      return;
    }
    setBusy(true);
    try {
      setStatus(deleteStatus, 'Deleting account…');
      const res = await sendMessage({ type: 'AUTH_DELETE', email: currentUser.email, password });
      if (!res?.ok) {
        setStatus(deleteStatus, res?.error || 'Delete failed', 'error');
        return;
      }
      deletePassword.value = '';
      deleteConfirm.classList.add('hidden');
      setStatus(syncStatus, '');
      currentUser = null;
      await refreshAccount();
      setStatus(authStatus, 'Account and synced history deleted.', 'success');
    } finally {
      setBusy(false);
    }
  }
  deleteConfirmBtn.addEventListener('click', doDeleteAccount);
  deletePassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doDeleteAccount();
  });

  async function loadHistory(): Promise<void> {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    history = res?.ok ? (res.history as OCRHistoryEntry[]) : [];
    renderHistory();
  }

  // Live-update when background saves new entries
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.history) {
      const value = changes.history.newValue;
      history = Array.isArray(value) ? (value as OCRHistoryEntry[]) : [];
      if (detailPanel.classList.contains('hidden')) renderHistory();
    }
  });

  function emptyState(msg: string): void {
    historyList.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.textContent = msg;
    historyList.appendChild(d);
  }

  function renderHistory(): void {
    const query = searchInput.value.trim().toLowerCase();
    const filterLang = filterLanguage.value;
    const filtered = history.filter(
      (e) =>
        (!query || (e.text || '').toLowerCase().includes(query)) &&
        (filterLang === 'all' || e.language === filterLang)
    );
    if (filtered.length === 0) {
      emptyState(history.length === 0 ? 'No OCR results yet. Press Ctrl+Shift+X on any page, or right-click an image.' : 'No results match your search.');
      return;
    }
    historyList.innerHTML = '';
    for (const entry of filtered) {
      const item = document.createElement('div');
      item.className = 'history-item';

      const header = document.createElement('div');
      header.className = 'history-item-header';
      const date = document.createElement('span');
      date.textContent = new Date(entry.timestamp).toLocaleString();
      const lang = document.createElement('span');
      lang.textContent = entry.language || '';
      const conf = document.createElement('span');
      conf.textContent = (entry.confidence || 0) + '%';
      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.textContent = 'Delete';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await chrome.runtime.sendMessage({ type: 'DELETE_ENTRY', id: entry.id });
        history = history.filter((h) => h.id !== entry.id);
        renderHistory();
      });
      header.append(date, lang, conf, del);

      const preview = document.createElement('div');
      preview.className = 'history-item-text';
      const t = entry.text || '';
      preview.textContent = t.length > 140 ? t.slice(0, 140) + '…' : t;

      item.append(header, preview);
      item.addEventListener('click', () => openDetail(entry));
      historyList.appendChild(item);
    }
  }

  function openDetail(entry: OCRHistoryEntry): void {
    currentDetail = entry;
    detailText.textContent = entry.text || '';
    detailPanel.classList.remove('hidden');
    historyList.style.display = 'none';
    filters.style.display = 'none';
    accountCard.style.display = 'none';
    headerTitle.textContent = `Result · ${entry.confidence || 0}% · ${entry.language || ''}`;
  }

  function closeDetail(): void {
    detailPanel.classList.add('hidden');
    historyList.style.display = 'block';
    filters.style.display = 'flex';
    accountCard.style.display = '';
    headerTitle.textContent = 'OCR History';
    currentDetail = null;
  }

  searchInput.addEventListener('input', renderHistory);
  filterLanguage.addEventListener('change', renderHistory);
  backBtn.addEventListener('click', closeDetail);
  clearHistoryBtn.addEventListener('click', async () => {
    if (!history.length || !confirm('Clear all OCR history?')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    history = [];
    renderHistory();
  });
  copyDetailBtn.addEventListener('click', async () => {
    if (!currentDetail) return;
    try {
      await navigator.clipboard.writeText(currentDetail.text || '');
      copyDetailBtn.textContent = 'Copied!';
    } catch {
      copyDetailBtn.textContent = 'Copy failed — select manually';
    }
    setTimeout(() => (copyDetailBtn.textContent = 'Copy Text'), 1500);
  });

  loadHistory();
  refreshAccount().then((user) => {
    if (user?.emailVerified) syncNow(false).catch(() => {});
  });
});
