import { openLoginModal } from '../shared/login.js';

interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  user?: AuthUser | null;
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
  const accountBtn = q<HTMLButtonElement>('account-btn');

  let history: OCRHistoryEntry[] = [];
  let currentDetail: OCRHistoryEntry | null = null;

  async function sendMessage<T = RuntimeResponse>(message: BackgroundRequest): Promise<T> {
    const res = (await chrome.runtime.sendMessage(message)) as T | undefined;
    return res as T;
  }

  // Account: logged in → dashboard tab; logged out → Login modal in place.
  let signedInUser: AuthUser | null = null;

  function applyAccountState(user: AuthUser | null): void {
    signedInUser = user;
    if (user) {
      accountBtn.textContent = (user.email || '?').trim().charAt(0).toUpperCase() || '?';
      accountBtn.classList.add('signed-in');
      accountBtn.title = `${user.email} — open dashboard`;
    } else {
      accountBtn.textContent = 'Login';
      accountBtn.classList.remove('signed-in');
      accountBtn.title = 'Login to sync your history';
    }
  }

  accountBtn.addEventListener('click', async () => {
    if (signedInUser) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('auth/dashboard.html') });
      return;
    }
    openLoginModal({
      onSignedIn: (user) => {
        applyAccountState(user);
        // Merge the cloud copy straight away so the list matches the dashboard.
        void sendMessage({ type: 'SYNC_HISTORY' })
          .then(() => loadHistory())
          .catch(() => {});
      },
    });
  });

  void sendMessage<{ ok?: boolean; user?: AuthUser | null }>({ type: 'AUTH_STATE' }).then((res) =>
    applyAccountState(res?.ok ? res.user ?? null : null),
  );

  async function loadHistory(): Promise<void> {
    const res = await sendMessage<{ ok?: boolean; history?: OCRHistoryEntry[] }>({ type: 'GET_HISTORY' });
    history = res?.ok && res.history ? res.history : [];
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
        await sendMessage({ type: 'DELETE_ENTRY', id: entry.id });
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
    headerTitle.textContent = `Result · ${entry.confidence || 0}% · ${entry.language || ''}`;
  }

  function closeDetail(): void {
    detailPanel.classList.add('hidden');
    historyList.style.display = 'block';
    filters.style.display = 'flex';
    headerTitle.textContent = 'OCR History';
    currentDetail = null;
  }

  searchInput.addEventListener('input', renderHistory);
  filterLanguage.addEventListener('change', renderHistory);
  backBtn.addEventListener('click', closeDetail);
  clearHistoryBtn.addEventListener('click', async () => {
    if (!history.length || !confirm('Clear all OCR history?')) return;
    await sendMessage({ type: 'CLEAR_HISTORY' });
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
});
