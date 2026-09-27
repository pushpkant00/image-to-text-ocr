document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const selectBtn = $('ocr-select-btn');
  const fileInput = $('ocr-file');
  const languageSelect = $('language-select');
  const removeBreaks = $('remove-breaks');
  const mergeSpaces = $('merge-spaces');
  const lastResult = $('last-result');
  const lastText = $('last-text');
  const copyLastBtn = $('copy-last-btn');
  const viewHistoryBtn = $('view-history-btn');
  const statusEl = $('ocr-status');

  function setStatus(msg, busy = true) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
    statusEl.classList.toggle('busy', busy);
  }

  // --- settings ---
  async function loadSettings() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const s = res?.settings || {};
    languageSelect.value = s.language || 'eng';
    removeBreaks.checked = s.removeLineBreaks !== false;
    mergeSpaces.checked = s.mergeSpaces !== false;
  }
  async function saveSettings() {
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
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function ocrImageData(imageData) {
    setStatus('Reading text… (first run loads the OCR engine, ~10s)');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE_DATA', imageData });
      if (!res?.ok) throw new Error(res?.error || 'OCR failed');
      const text = res.entry?.text || '';
      setStatus('');
      if (!text) {
        setStatus('No text found in that image.', false);
        return;
      }
      await navigator.clipboard.writeText(text);
      showLast(text);
      setStatus(`Copied ${text.length} chars to clipboard.`, false);
    } catch (err) {
      setStatus('Failed: ' + String(err?.message || err), false);
    }
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) await ocrImageData(await fileToDataUrl(f));
    fileInput.value = '';
  });

  document.addEventListener('paste', async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      await ocrImageData(await fileToDataUrl(item.getAsFile()));
    }
  });

  // --- history ---
  function showLast(text) {
    lastResult.classList.remove('hidden');
    lastText.textContent = text.length > 500 ? text.slice(0, 500) + '…' : text;
  }
  copyLastBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastText.textContent);
    copyLastBtn.textContent = 'Copied!';
    setTimeout(() => (copyLastBtn.textContent = 'Copy'), 1200);
  });
  viewHistoryBtn.addEventListener('click', async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  });

  async function loadLastResult() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    if (res?.ok && res.history.length > 0) showLast(res.history[0].text);
  }

  await loadSettings();
  await loadLastResult();
});
