import { openLoginModal } from '../shared/login.js';

document.addEventListener('DOMContentLoaded', async () => {
  const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  window.__ocrTheme?.mount(document.getElementById('theme-toggle'));

  const fileInput = q<HTMLInputElement>('ocr-file');
  const settingsBtn = q<HTMLButtonElement>('settings-btn');
  const lastResult = q<HTMLElement>('last-result');
  const lastText = q<HTMLElement>('last-text');
  const copyLastBtn = q<HTMLButtonElement>('copy-last-btn');
  const viewHistoryBtn = q<HTMLButtonElement>('view-history-btn');
  const accountBtn = q<HTMLButtonElement>('account-btn');
  const statusEl = q<HTMLElement>('ocr-status');
  const liveBox = q<HTMLElement>('ocr-live');
  const liveLabel = q<HTMLElement>('live-label');
  const liveText = q<HTMLElement>('live-text');
  const lastMeta = q<HTMLElement>('last-meta');

  function setStatus(msg: string, busy = true): void {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
    statusEl.classList.toggle('busy', busy);
  }

  // --- app settings (edited on the Settings page) ---
  let appSettings: OCRSettings = {
    language: 'eng',
    visionModel: 'google:gemini-3.5-flash',
    removeLineBreaks: true,
    mergeSpaces: true,
    showResultCard: true,
    openHistoryAfterOcr: true,
    autoDownload: false,
  };
  async function loadSettings(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res?.settings) appSettings = res.settings as OCRSettings;
    } catch {
      /* keep defaults */
    }
  }
  settingsBtn.addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('auth/settings.html') });
    window.close();
  });

  // --- live progress: streamed text + elapsed time (milliseconds) ---
  let liveTicker = 0;
  let liveStarted = 0;

  function formatElapsed(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function startLive(label = 'Reading text'): void {
    stopLive();
    liveStarted = Date.now();
    liveBox.classList.remove('hidden');
    liveText.textContent = '';
    liveLabel.textContent = `${label}… ${formatElapsed(0)}`;
    // tick every 100ms so the readout has real millisecond resolution
    liveTicker = window.setInterval(() => {
      liveLabel.textContent = `${label}… ${formatElapsed(Date.now() - liveStarted)}`;
    }, 100);
  }

  function updateLive(text: string): void {
    if (liveBox.classList.contains('hidden')) return;
    liveText.textContent = text;
    liveText.scrollTop = liveText.scrollHeight;
  }

  function stopLive(): void {
    window.clearInterval(liveTicker);
    liveTicker = 0;
    liveBox.classList.add('hidden');
    liveText.textContent = '';
  }

  // --- OCR from file / paste ---
  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('Could not read file'));
      r.readAsDataURL(file);
    });
  }

  async function ocrImageData(imageData: string): Promise<void> {
    const started = Date.now();
    setStatus('Reading text…');
    startLive('Reading text');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE_DATA', imageData });
      if (!res?.ok) throw new Error(res?.error || 'OCR failed');
      const entry = res.entry as OCRHistoryEntry | undefined;
      setStatus('');
      if (!entry?.text) {
        stopLive();
        setStatus('No text found in that image.', false);
        return;
      }
      const ms = Date.now() - started;
      stopLive();
      showLast(entry, ms);
      setStatus(`Extracted ${entry.text.length} chars in ${formatElapsed(ms)} — copy below.`, false);
    } catch (err) {
      stopLive();
      setStatus('Failed: ' + (err instanceof Error ? err.message : String(err)), false);
    }
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) await ocrImageData(await fileToDataUrl(f));
    fileInput.value = '';
  });

  // --- last result (first line + copy only) ---
  let lastFullText = '';

  function setLabel(btn: HTMLButtonElement, text: string): void {
    const span = btn.querySelector('span');
    if (span) span.textContent = text;
  }

  function showLast(entry: OCRHistoryEntry, ms?: number): void {
    const text = (entry.text || '').trim();
    lastFullText = text;
    lastResult.classList.remove('hidden');
    lastText.textContent = text || 'No text';
    const parts = [`${text.length} chars`];
    if (entry.language) parts.push(entry.language);
    if (ms !== undefined) parts.push(formatElapsed(ms));
    lastMeta.textContent = parts.join(' · ');
  }

  copyLastBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastFullText);
    setLabel(copyLastBtn, 'Copied!');
    setTimeout(() => setLabel(copyLastBtn, 'Copy'), 1200);
  });
  viewHistoryBtn.addEventListener('click', async () => {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  });

  // --- account entry: Login opens as an in-popup modal; the dashboard opens in a tab ---
  let signedIn = false;
  function markSignedIn(): void {
    signedIn = true;
    accountBtn.title = 'Account';
    accountBtn.setAttribute('aria-label', 'Account');
    accountBtn.classList.add('signed-in');
  }
  async function loadAuthState(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AUTH_STATE' });
      if (res?.ok && res.user) markSignedIn();
    } catch {
      /* stay in logged-out state */
    }
  }
  accountBtn.addEventListener('click', async () => {
    if (signedIn) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('auth/dashboard.html') });
      window.close();
      return;
    }
    openLoginModal({ onSignedIn: markSignedIn });
  });

  async function loadLastResult(): Promise<void> {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    const history: OCRHistoryEntry[] = res?.ok && Array.isArray(res.history) ? res.history : [];
    if (history.length > 0) showLast(history[0]);
  }

  // ==================== live OCR updates from the background ====================

  // The background broadcasts OCR_START / OCR_LIVE / OCR_RESULT so the popup
  // shows the text while it is being read, even when the capture was started
  // from the page (right-click, Ctrl+Shift+X).
  chrome.runtime.onMessage.addListener((message) => {
    const msg = message as OcrBroadcast;
    if (!msg?.type) return;
    if (msg.type === 'OCR_START') {
      startLive('Reading text');
    } else if (msg.type === 'OCR_LIVE' && typeof msg.text === 'string') {
      updateLive(msg.text);
    } else if (msg.type === 'OCR_RESULT' && msg.entry) {
      stopLive();
      showLast(msg.entry, msg.ms);
      setStatus(`Extracted ${msg.entry.text?.length || 0} chars in ${formatElapsed(msg.ms ?? 0)} — copy below.`, false);
    }
  });

  document.addEventListener('paste', async (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (item && file) {
      e.preventDefault();
      await ocrImageData(await fileToDataUrl(file));
    }
  });

  await loadSettings();
  await loadLastResult();
  await loadAuthState();
});
