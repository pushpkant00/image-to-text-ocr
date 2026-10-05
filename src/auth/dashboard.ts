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

  // header
  const avatar = q<HTMLSpanElement>('avatar');
  const userEmail = q<HTMLSpanElement>('user-email');
  const signOutBtn = q<HTMLButtonElement>('sign-out-btn');

  // account & sync
  const verifyPill = q<HTMLSpanElement>('verify-pill');
  const verifyBanner = q<HTMLDivElement>('verify-banner');
  const resendBtn = q<HTMLButtonElement>('resend-btn');
  const verifiedBtn = q<HTMLButtonElement>('verified-btn');
  const syncStatus = q<HTMLDivElement>('sync-status');
  const syncBtn = q<HTMLButtonElement>('sync-btn');

  // history
  const stats = q<HTMLSpanElement>('stats');
  const searchInput = q<HTMLInputElement>('search-input');
  const filterLanguage = q<HTMLSelectElement>('filter-language');
  const clearHistoryBtn = q<HTMLButtonElement>('clear-history-btn');
  const historyList = q<HTMLDivElement>('history-list');

  // danger zone
  const deleteAccountBtn = q<HTMLButtonElement>('delete-account-btn');
  const deleteConfirm = q<HTMLDivElement>('delete-confirm');
  const deletePassword = q<HTMLInputElement>('delete-password');
  const deleteStatus = q<HTMLDivElement>('delete-status');
  const deleteConfirmBtn = q<HTMLButtonElement>('delete-confirm-btn');
  const deleteCancelBtn = q<HTMLButtonElement>('delete-cancel-btn');

  // detail modal
  const detailModal = q<HTMLDivElement>('detail-modal');
  const detailMeta = q<HTMLSpanElement>('detail-meta');
  const detailText = q<HTMLDivElement>('detail-text');
  const modalClose = q<HTMLButtonElement>('modal-close');
  const copyDetailBtn = q<HTMLButtonElement>('copy-detail-btn');

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
    [
      signOutBtn,
      resendBtn,
      verifiedBtn,
      syncBtn,
      deleteAccountBtn,
      deleteConfirmBtn,
      deleteCancelBtn,
      clearHistoryBtn,
    ].forEach((b) => {
      b.disabled = value;
    });
    syncBtn.disabled = value || currentUser?.emailVerified !== true;
  }

  async function sendMessage(message: BackgroundRequest): Promise<RuntimeResponse> {
    const res = (await chrome.runtime.sendMessage(message)) as RuntimeResponse | undefined;
    return res || { ok: false, error: 'No response from the extension. Reload it and try again.' };
  }

  function goToSignIn(): void {
    window.location.replace('signin.html');
  }

  async function refreshAccount(): Promise<AuthUser | null> {
    const res = await sendMessage({ type: 'AUTH_STATE' });
    const user = res?.ok ? res.user ?? null : null;
    if (!user) {
      goToSignIn();
      return null;
    }
    currentUser = user;
    avatar.textContent = (user.email || '?').trim().charAt(0).toUpperCase() || '?';
    userEmail.textContent = user.email || '';
    const verified = user.emailVerified === true;
    verifyPill.classList.toggle('hidden', verified);
    verifyPill.classList.toggle('warn', !verified);
    verifyPill.textContent = 'Email unverified';
    verifyBanner.classList.toggle('hidden', verified);
    syncBtn.disabled = busy || !verified;
    return user;
  }

  async function syncNow(showStatus = true): Promise<boolean> {
    const res = await sendMessage({ type: 'SYNC_HISTORY' });
    if (res?.ok && showStatus) {
      const { total = 0, uploaded = 0 } = res.stats || {};
      setStatus(
        syncStatus,
        `Synced · ${total} item${total === 1 ? '' : 's'}${uploaded ? ` · ${uploaded} uploaded` : ''}`,
        'success',
      );
    } else if (!res?.ok && showStatus) {
      setStatus(syncStatus, res?.error || 'Sync failed', 'error');
    }
    if (res?.ok) await loadHistory();
    return Boolean(res?.ok);
  }

  // ---------- account actions ----------
  signOutBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await sendMessage({ type: 'AUTH_SIGN_OUT' });
      goToSignIn();
    } finally {
      setBusy(false);
    }
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
      goToSignIn();
    } finally {
      setBusy(false);
    }
  }
  deleteConfirmBtn.addEventListener('click', doDeleteAccount);
  deletePassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doDeleteAccount();
  });

  // ---------- history ----------
  async function loadHistory(): Promise<void> {
    const res = await sendMessage({ type: 'GET_HISTORY' });
    history = res?.ok && res.history ? res.history : [];
    renderHistory();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.history) {
      const value = changes.history.newValue;
      history = Array.isArray(value) ? (value as OCRHistoryEntry[]) : [];
      renderHistory();
    }
  });

  function emptyState(msg: string): void {
    historyList.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.textContent = msg;
    historyList.appendChild(d);
  }

  function renderStats(): void {
    const langs = new Set(history.map((e) => e.language).filter(Boolean));
    const parts = [`${history.length} result${history.length === 1 ? '' : 's'}`];
    if (langs.size) parts.push(`${langs.size} language${langs.size === 1 ? '' : 's'}`);
    stats.textContent = parts.join(' · ');
  }

  function renderHistory(): void {
    renderStats();
    const query = searchInput.value.trim().toLowerCase();
    const filterLang = filterLanguage.value;
    const filtered = history.filter(
      (e) =>
        (!query || (e.text || '').toLowerCase().includes(query)) &&
        (filterLang === 'all' || e.language === filterLang),
    );
    if (filtered.length === 0) {
      emptyState(
        history.length === 0
          ? 'No OCR results yet. Press Ctrl+Shift+X on any page, or right-click an image.'
          : 'No results match your search.',
      );
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
      lang.className = 'lang';
      lang.textContent = entry.language || '';
      const conf = document.createElement('span');
      conf.className = 'conf';
      conf.textContent = (entry.confidence || 0) + '%';
      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.textContent = 'Delete';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await sendMessage({ type: 'DELETE_ENTRY', id: entry.id });
        history = history.filter((h) => h.id !== entry.id);
        renderHistory();
      });
      header.append(date, lang, conf, del);

      const preview = document.createElement('div');
      preview.className = 'history-item-text';
      const t = entry.text || '';
      preview.textContent = t.length > 180 ? t.slice(0, 180) + '…' : t;

      item.append(header, preview);
      item.addEventListener('click', () => openDetail(entry));
      historyList.appendChild(item);
    }
  }

  function openDetail(entry: OCRHistoryEntry): void {
    currentDetail = entry;
    detailMeta.textContent = `${new Date(entry.timestamp).toLocaleString()} · ${entry.language || ''} · ${
      entry.confidence || 0
    }% confidence`;
    detailText.textContent = entry.text || '';
    detailModal.classList.remove('hidden');
  }

  function closeDetail(): void {
    detailModal.classList.add('hidden');
    currentDetail = null;
    copyDetailBtn.textContent = 'Copy Text';
  }

  modalClose.addEventListener('click', closeDetail);
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !detailModal.classList.contains('hidden')) closeDetail();
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

  searchInput.addEventListener('input', renderHistory);
  filterLanguage.addEventListener('change', renderHistory);
  clearHistoryBtn.addEventListener('click', async () => {
    if (!history.length || !confirm('Clear all OCR history?')) return;
    await sendMessage({ type: 'CLEAR_HISTORY' });
    history = [];
    renderHistory();
  });

  // ---------- init ----------
  void (async () => {
    const user = await refreshAccount();
    if (!user) return;
    await loadHistory();
    if (user.emailVerified) syncNow(false).catch(() => {});
  })();
});
