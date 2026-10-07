interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
  configured?: boolean;
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

  // sync (silent — only errors surface)
  const syncError = q<HTMLDivElement>('sync-error');
  const syncErrorText = q<HTMLSpanElement>('sync-error-text');
  const syncRetryBtn = q<HTMLButtonElement>('sync-retry-btn');

  // history
  const stats = q<HTMLSpanElement>('stats');
  const searchInput = q<HTMLInputElement>('search-input');
  const filterLanguage = q<HTMLSelectElement>('filter-language');
  const clearHistoryBtn = q<HTMLButtonElement>('clear-history-btn');
  const historyList = q<HTMLDivElement>('history-list');

  // detail modal
  const detailModal = q<HTMLDivElement>('detail-modal');
  const detailMeta = q<HTMLSpanElement>('detail-meta');
  const detailText = q<HTMLDivElement>('detail-text');
  const modalClose = q<HTMLButtonElement>('modal-close');
  const copyDetailBtn = q<HTMLButtonElement>('copy-detail-btn');

  let history: OCRHistoryEntry[] = [];
  let currentDetail: OCRHistoryEntry | null = null;
  let busy = false;

  function setBusy(value: boolean): void {
    busy = value;
    [signOutBtn, clearHistoryBtn, syncRetryBtn].forEach((b) => {
      b.disabled = value;
    });
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
    avatar.textContent = (user.email || '?').trim().charAt(0).toUpperCase() || '?';
    userEmail.textContent = user.email || '';
    return user;
  }

  function showSyncError(message: string): void {
    syncErrorText.textContent = message;
    syncError.classList.remove('hidden');
  }

  // Merge local + cloud history. Silent on success — only failures surface.
  async function runSync(): Promise<boolean> {
    const res = await sendMessage({ type: 'SYNC_HISTORY' });
    if (res?.ok) {
      syncError.classList.add('hidden');
      await loadHistory();
      return true;
    }
    showSyncError(res?.error || 'Sync failed — history stays only on this device.');
    return false;
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

  syncRetryBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runSync();
    } finally {
      setBusy(false);
    }
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

  // Signed in → history lives in the database; reload when it changes there.
  chrome.runtime.onMessage.addListener((message) => {
    const msg = message as { type?: string };
    if (msg?.type === 'HISTORY_UPDATED') void loadHistory();
  });

  function emptyState(kind: 'initial' | 'nomatch'): void {
    historyList.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';

    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/>' +
      '<path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/>' +
      '<path d="M8 10.5h8"/><path d="M8 13.5h5"/></svg>';

    const title = document.createElement('div');
    title.className = 'empty-title';
    const hint = document.createElement('div');
    hint.className = 'empty-hint';

    if (kind === 'initial') {
      title.textContent = 'No OCR results yet';
      hint.innerHTML =
        'Press <kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">Shift</kbd> + <kbd class="kbd">X</kbd> on any page, ' +
        'or right-click an image to extract its text.';
    } else {
      title.textContent = 'No results match your search';
      hint.textContent = 'Try a different word, or set the language filter back to All Languages.';
    }

    wrap.append(icon, title, hint);
    historyList.appendChild(wrap);
  }

  function renderStats(): void {
    if (history.length === 0) {
      stats.textContent = '';
      return;
    }
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
      emptyState(history.length === 0 ? 'initial' : 'nomatch');
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
    // Sync first (flushes staging entries to the database and reloads the
    // list); fall back to a direct read if it fails — only failures surface.
    const synced = await runSync().catch((err: unknown) => {
      showSyncError(err instanceof Error ? err.message : 'Sync failed');
      return false;
    });
    if (!synced) await loadHistory();
  })();
});
