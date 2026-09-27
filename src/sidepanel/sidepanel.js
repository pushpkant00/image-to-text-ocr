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

  let history = [];
  let currentDetail = null;

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
    headerTitle.textContent = `Result · ${entry.confidence || 0}% · ${entry.language || ''}`;
  }

  function closeDetail() {
    detailPanel.classList.add('hidden');
    historyList.style.display = 'block';
    document.querySelector('.filters').style.display = 'flex';
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
});
