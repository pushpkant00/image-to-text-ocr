document.addEventListener('DOMContentLoaded', async () => {
  const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  const fileInput = q<HTMLInputElement>('ocr-file');
  const languageSelect = q<HTMLSelectElement>('language-select');
  const removeBreaks = q<HTMLInputElement>('remove-breaks');
  const mergeSpaces = q<HTMLInputElement>('merge-spaces');
  const lastResult = q<HTMLElement>('last-result');
  const lastText = q<HTMLElement>('last-text');
  const lastAccuracy = q<HTMLElement>('last-accuracy');
  const copyLastBtn = q<HTMLButtonElement>('copy-last-btn');
  const viewHistoryBtn = q<HTMLButtonElement>('view-history-btn');
  const accountBtn = q<HTMLButtonElement>('account-btn');
  const accountLabel = q<HTMLElement>('account-label');
  const statusEl = q<HTMLElement>('ocr-status');

  function setStatus(msg: string, busy = true): void {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
    statusEl.classList.toggle('busy', busy);
  }

  // --- settings ---
  async function loadSettings(): Promise<void> {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const s: Partial<OCRSettings> = res?.settings || {};
    languageSelect.value = s.language || 'eng';
    removeBreaks.checked = s.removeLineBreaks !== false;
    mergeSpaces.checked = s.mergeSpaces !== false;
  }
  async function saveSettings(): Promise<void> {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: {
        language: languageSelect.value,
        removeLineBreaks: removeBreaks.checked,
        mergeSpaces: mergeSpaces.checked,
      },
    });
  }
  languageSelect.addEventListener('change', saveSettings);
  removeBreaks.addEventListener('change', saveSettings);
  mergeSpaces.addEventListener('change', saveSettings);

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
    setStatus('Reading text… (first run loads the OCR engine, ~10s)');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE_DATA', imageData });
      if (!res?.ok) throw new Error(res?.error || 'OCR failed');
      const entry = res.entry as OCRHistoryEntry | undefined;
      setStatus('');
      if (!entry?.text) {
        setStatus('No text found in that image.', false);
        return;
      }
      showLast(entry);
      setStatus(`Extracted ${entry.text.length} chars — copy below.`, false);
    } catch (err) {
      setStatus('Failed: ' + (err instanceof Error ? err.message : String(err)), false);
    }
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) await ocrImageData(await fileToDataUrl(f));
    fileInput.value = '';
  });

  document.addEventListener('paste', async (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (item && file) {
      e.preventDefault();
      await ocrImageData(await fileToDataUrl(file));
    }
  });

  // --- last result (accuracy + first line, copy only) ---
  let lastFullText = '';

  function setLabel(btn: HTMLButtonElement, text: string): void {
    const span = btn.querySelector('span');
    if (span) span.textContent = text;
  }

  function showLast(entry: OCRHistoryEntry): void {
    const text = (entry.text || '').trim();
    lastFullText = text;
    lastResult.classList.remove('hidden');

    const confidence = Math.max(0, Math.min(100, Math.round(entry.confidence || 0)));
    lastAccuracy.textContent = `${confidence}% accuracy`;
    lastAccuracy.classList.remove('is-high', 'is-mid', 'is-low');
    lastAccuracy.classList.add(confidence >= 80 ? 'is-high' : confidence >= 50 ? 'is-mid' : 'is-low');

    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) || 'No text';
    lastText.textContent = firstLine;
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

  // --- account entry (direct sign-in from the popup, like other extensions) ---
  let accountPage = 'auth/signin.html';
  async function loadAuthState(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AUTH_STATE' });
      if (res?.ok && res.user) {
        accountPage = 'auth/dashboard.html';
        accountLabel.textContent = 'Account';
        accountBtn.title = 'Account';
        accountBtn.classList.add('signed-in');
      }
    } catch {
      /* stay in signed-out state */
    }
  }
  accountBtn.addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(accountPage) });
    window.close();
  });

  async function loadLastResult(): Promise<void> {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    const history: OCRHistoryEntry[] = res?.ok && Array.isArray(res.history) ? res.history : [];
    if (history.length > 0) showLast(history[0]);
  }

  await loadSettings();
  await loadLastResult();
  await loadAuthState();
});
