document.addEventListener('DOMContentLoaded', async () => {
  const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  const selectBtn = q<HTMLButtonElement>('ocr-select-btn');
  const fileInput = q<HTMLInputElement>('ocr-file');
  const languageSelect = q<HTMLSelectElement>('language-select');
  const removeBreaks = q<HTMLInputElement>('remove-breaks');
  const mergeSpaces = q<HTMLInputElement>('merge-spaces');
  const lastResult = q<HTMLElement>('last-result');
  const lastText = q<HTMLElement>('last-text');
  const copyLastBtn = q<HTMLButtonElement>('copy-last-btn');
  const viewHistoryBtn = q<HTMLButtonElement>('view-history-btn');
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

  // --- select area on page ---
  selectBtn.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'START_SELECTION_POPUP' });
    if (res?.ok) {
      window.close();
    } else if (res?.error === 'BLOCKED_PAGE') {
      setStatus('This page blocks extensions (e.g. chrome:// pages, new tab, web store). Open a normal website and try again.', false);
    } else {
      setStatus('Could not reach the page: ' + (res?.error || 'unknown error') + '. Refresh the tab and retry.', false);
    }
  });

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
      const text: string = res.entry?.text || '';
      setStatus('');
      if (!text) {
        setStatus('No text found in that image.', false);
        return;
      }
      await navigator.clipboard.writeText(text);
      showLast(text);
      setStatus(`Copied ${text.length} chars to clipboard.`, false);
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

  // --- history ---
  function showLast(text: string): void {
    lastResult.classList.remove('hidden');
    lastText.textContent = text.length > 500 ? text.slice(0, 500) + '…' : text;
  }
  copyLastBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastText.textContent || '');
    copyLastBtn.textContent = 'Copied!';
    setTimeout(() => (copyLastBtn.textContent = 'Copy'), 1200);
  });
  viewHistoryBtn.addEventListener('click', async () => {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  });

  async function loadLastResult(): Promise<void> {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    if (res?.ok && res.history.length > 0) showLast(res.history[0].text);
  }

  await loadSettings();
  await loadLastResult();
});
