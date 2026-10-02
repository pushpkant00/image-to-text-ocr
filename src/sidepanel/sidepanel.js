document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const historyList = $('history-list');
  const searchInput = $('search-input');
  const filterLanguage = $('filter-language');
  const clearHistoryBtn = $('clear-history-btn');
  const detailPanel = $('detail-panel');
  const detailText = $('detail-text');
  const copyDetailBtn = $('copy-detail-btn');
  const backBtn = $('back-btn');
  const headerTitle = document.querySelector('.header h2');

  // account / cloud sync
  const accountCard = document.getElementById('account-card');
  const signedOutView = document.getElementById('signed-out-view');
  const signedInView = document.getElementById('signed-in-view');
  const authEmail = document.getElementById('auth-email');
  const authPassword = document.getElementById('auth-password');
  const authStatus = document.getElementById('auth-status');
  const signInBtn = document.getElementById('sign-in-btn');
  const signUpBtn = document.getElementById('sign-up-btn');
  const configHint = document.getElementById('config-hint');
  const accountAvatar = document.getElementById('account-avatar');
  const accountEmail = document.getElementById('account-email');
  const syncStatus = document.getElementById('sync-status');
  const syncBtn = document.getElementById('sync-btn');
  const signOutBtn = document.getElementById('sign-out-btn');

  let history = [];
  let currentDetail = null;
  let busy = false;

  function setStatus(el, message, kind = '') {
    el.textContent = message;
    el.classList.remove('hidden', 'error', 'success');
    if (message) el.classList.add(kind);
    else el.classList.add('hidden');
  }

  function setBusy(value) {
    busy = value;
    [signInBtn, signUpBtn, syncBtn, signOutBtn].forEach((b) => (b.disabled = value));
  }

  async function sendMessage(message) {
    return (await chrome.runtime.sendMessage(message)) || { ok: false, error: 'No response from background' };
  }

  async function refreshAccount() {
    const res = await sendMessage({ type: 'AUTH_STATE' });
    const user = res?.ok ? res.user : null;
    signedOutView.classList.toggle('hidden', Boolean(user));
    signedInView.classList.toggle('hidden', !user);
    configHint.classList.toggle('hidden', !(res?.ok && !res.configured));
    if (user) {
      accountEmail.textContent = user.email || '';
      accountAvatar.textContent = (user.email || '?').trim().charAt(0).toUpperCase() || '?';
    }
    return user;
  }

  async function syncNow(showStatus = true) {
    const res = await sendMessage({ type: 'SYNC_HISTORY' });
    if (res?.ok && showStatus) {
      const { total = 0, uploaded = 0 } = res.stats || {};
      setStatus(syncStatus, `Synced · ${total} item${total === 1 ? '' : 's'}${uploaded ? ` · ${uploaded} uploaded` : ''}`, 'success');
    } else if (!res?.ok && showStatus) {
      setStatus(syncStatus, res?.error || 'Sync failed', 'error');
    }
    if (res?.ok) await loadHistory();
    return res?.ok;
  }

  async function handleAuth(kind) {
    if (busy) return;
    const email = authEmail.value.trim();
    const password = authPassword.value;
    if (!email || !password) {
      setStatus(authStatus, 'Enter your email and password.', 'error');
      return;
    }
    if (kind === 'AUTH_SIGN_UP' && password.length < 6) {
      setStatus(authStatus, 'Password must be at least 6 characters.', 'error');
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
      await refreshAccount();
      setStatus(syncStatus, 'Merging history…');
      await syncNow(true);
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

  async function loadHistory() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    history = res?.ok ? res.history : [];
    renderHistory();
  }

  // Live-update when background saves new entries
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.history) {
      history = changes.history.newValue || [];
      if (detailPanel.classList.contains('hidden')) renderHistory();
    }
  });

  function emptyState(msg) {
    historyList.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.textContent = msg;
    historyList.appendChild(d);
  }

  function renderHistory() {
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

  function openDetail(entry) {
    currentDetail = entry;
    detailText.textContent = entry.text || '';
    detailPanel.classList.remove('hidden');
    historyList.style.display = 'none';
    document.querySelector('.filters').style.display = 'none';
    accountCard.style.display = 'none';
    headerTitle.textContent = `Result · ${entry.confidence || 0}% · ${entry.language || ''}`;
  }

  function closeDetail() {
    detailPanel.classList.add('hidden');
    historyList.style.display = 'block';
    document.querySelector('.filters').style.display = 'flex';
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
    if (user) syncNow(false).catch(() => {});
  });
});
