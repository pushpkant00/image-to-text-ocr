import { buildDocx } from '../convert/docx.js';
import { buildPdf } from '../convert/pdf-writer.js';
import { openLoginModal } from '../shared/login.js';

document.addEventListener('DOMContentLoaded', async () => {
  const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  const fileInput = q<HTMLInputElement>('ocr-file');
  const settingsBtn = q<HTMLButtonElement>('settings-btn');
  const lastResult = q<HTMLElement>('last-result');
  const lastText = q<HTMLElement>('last-text');
  const lastAccuracy = q<HTMLElement>('last-accuracy');
  const copyLastBtn = q<HTMLButtonElement>('copy-last-btn');
  const viewHistoryBtn = q<HTMLButtonElement>('view-history-btn');
  const accountBtn = q<HTMLButtonElement>('account-btn');
  const statusEl = q<HTMLElement>('ocr-status');

  function setStatus(msg: string, busy = true): void {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
    statusEl.classList.toggle('busy', busy);
  }

  // --- app settings (edited on the Settings page) ---
  let appSettings: OCRSettings = {
    language: 'eng',
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

  // ==================== convert mode ====================

  const tabOcr = q<HTMLButtonElement>('tab-ocr');
  const tabConvert = q<HTMLButtonElement>('tab-convert');
  const ocrView = q<HTMLElement>('ocr-view');
  const convertView = q<HTMLElement>('convert-view');
  const pills = Array.from(document.querySelectorAll<HTMLButtonElement>('.pill'));
  const convImageLabel = q<HTMLElement>('conv-image-label');
  const convImageFile = q<HTMLInputElement>('conv-image-file');
  const convPdfLabel = q<HTMLElement>('conv-pdf-label');
  const convPdfFile = q<HTMLInputElement>('conv-pdf-file');
  const convTextWrap = q<HTMLElement>('conv-text-wrap');
  const convText = q<HTMLTextAreaElement>('conv-text');
  const convUseLast = q<HTMLButtonElement>('conv-use-last');
  const convStatus = q<HTMLElement>('conv-status');
  const convProgress = q<HTMLElement>('conv-progress');
  const convProgressBar = q<HTMLElement>('conv-progress-bar');
  const convRun = q<HTMLButtonElement>('conv-run');
  const convResult = q<HTMLElement>('conv-result');
  const convResultText = q<HTMLElement>('conv-result-text');
  const convResultMeta = q<HTMLElement>('conv-result-meta');
  const convCopy = q<HTMLButtonElement>('conv-copy');
  const convDownload = q<HTMLButtonElement>('conv-download');

  type ConvertMode = 'img-word' | 'pdf-text' | 'pdf-word' | 'text-pdf' | 'text-word';
  type InputKind = 'image' | 'pdf' | 'text';
  type OutputKind = 'docx' | 'pdf' | 'txt';

  const MODE_CONFIG: Record<ConvertMode, { kind: InputKind; out: OutputKind }> = {
    'img-word': { kind: 'image', out: 'docx' },
    'pdf-text': { kind: 'pdf', out: 'txt' },
    'pdf-word': { kind: 'pdf', out: 'docx' },
    'text-pdf': { kind: 'text', out: 'pdf' },
    'text-word': { kind: 'text', out: 'docx' },
  };

  let currentMode: ConvertMode = 'img-word';
  let lastOutput: { blob: Blob; name: string } | null = null;
  let lastOutputText = '';

  function setConvStatus(msg: string, busy = true): void {
    convStatus.textContent = msg;
    convStatus.classList.toggle('hidden', !msg);
    convStatus.classList.toggle('busy', busy);
  }

  function showTab(which: 'ocr' | 'convert'): void {
    const convert = which === 'convert';
    tabOcr.classList.toggle('active', !convert);
    tabConvert.classList.toggle('active', convert);
    tabOcr.setAttribute('aria-selected', String(!convert));
    tabConvert.setAttribute('aria-selected', String(convert));
    ocrView.classList.toggle('hidden', convert);
    convertView.classList.toggle('hidden', !convert);
  }

  function resetConvertOutput(): void {
    lastOutput = null;
    lastOutputText = '';
    convResult.classList.add('hidden');
    convProgress.classList.add('hidden');
    convProgressBar.style.width = '0';
    setConvStatus('');
  }

  function applyMode(mode: ConvertMode): void {
    currentMode = mode;
    const kind = MODE_CONFIG[mode].kind;
    for (const p of pills) {
      const active = p.dataset.mode === mode;
      p.classList.toggle('active', active);
      p.setAttribute('aria-pressed', String(active));
    }
    convImageLabel.classList.toggle('hidden', kind !== 'image');
    convPdfLabel.classList.toggle('hidden', kind !== 'pdf');
    convTextWrap.classList.toggle('hidden', kind !== 'text');
    convRun.classList.toggle('hidden', kind !== 'text');
    resetConvertOutput();
    convImageFile.value = '';
    convPdfFile.value = '';
  }

  function outName(base: string, ext: string): string {
    const clean = (base || '').replace(/\.[^.]+$/, '').trim();
    return `${clean || 'converted'}.${ext}`;
  }

  function downloadOutput(): void {
    if (!lastOutput) return;
    const url = URL.createObjectURL(lastOutput.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastOutput.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function showResult(blob: Blob, name: string, preview: string, meta: string): void {
    lastOutput = { blob, name };
    lastOutputText = preview;
    convResultText.textContent = preview.length > 600 ? preview.slice(0, 600) + '…' : preview || '(empty)';
    convResultMeta.textContent = meta;
    convResult.classList.remove('hidden');
    if (appSettings.autoDownload) {
      downloadOutput();
      setConvStatus('Ready — downloaded automatically.', false);
    } else {
      setConvStatus('Ready — click Download to save the file.', false);
    }
  }

  function failedMessage(err: unknown): string {
    return 'Failed: ' + (err instanceof Error ? err.message : String(err));
  }

  // Jpg To Word: existing OCR pipeline, then wrap the text in a .docx
  async function convertImage(file: File): Promise<void> {
    resetConvertOutput();
    setConvStatus('Reading text… (first run loads the OCR engine, ~10s)');
    try {
      const imageData = await fileToDataUrl(file);
      const res = await chrome.runtime.sendMessage({ type: 'OCR_IMAGE_DATA', imageData });
      if (!res?.ok) throw new Error(res?.error || 'OCR failed');
      const text = ((res.entry as OCRHistoryEntry | undefined)?.text || '').trim();
      if (!text) {
        setConvStatus('No text found in that image.', false);
        return;
      }
      showResult(buildDocx(text), outName(file.name, 'docx'), text, `${text.length} chars`);
    } catch (err) {
      setConvStatus(failedMessage(err), false);
    }
  }

  // Pdf To Text / Pdf To Word: offscreen does pdf.js extraction + OCR fallback
  async function convertPdf(file: File): Promise<void> {
    const mode = currentMode; // capture — the user can switch pills mid-run
    resetConvertOutput();
    setConvStatus('Reading PDF…');
    try {
      const pdfData = await file.arrayBuffer();
      const settingsRes = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const language = settingsRes?.settings?.language || 'eng';
      const res = await chrome.runtime.sendMessage({
        type: 'PDF_EXTRACT',
        pdfData,
        language,
        mode,
        name: file.name,
      });
      if (!res?.ok) throw new Error(res?.error || 'Conversion failed');
      const text = (res.text || '').trim();
      if (!text) {
        setConvStatus('No text found in this PDF.', false);
        return;
      }
      const pagesMeta = `${res.pages || 0} pages${res.ocrPages ? ` · ${res.ocrPages} OCR` : ''}`;
      const blob =
        MODE_CONFIG[mode].out === 'txt'
          ? new Blob([text], { type: 'text/plain;charset=utf-8' })
          : buildDocx(text);
      showResult(blob, outName(file.name, MODE_CONFIG[mode].out), text, pagesMeta);
      convProgress.classList.add('hidden');
    } catch (err) {
      convProgress.classList.add('hidden');
      setConvStatus(failedMessage(err), false);
    }
  }

  // Text To PDF / Text To Word: pure-JS writers run right in the popup
  function convertText(): void {
    resetConvertOutput();
    const text = convText.value;
    if (!text.trim()) {
      setConvStatus('Type or paste some text first.', false);
      return;
    }
    try {
      const out = MODE_CONFIG[currentMode].out;
      const blob = out === 'pdf' ? buildPdf(text) : buildDocx(text);
      showResult(blob, `document.${out}`, text, `${text.length} chars`);
    } catch (err) {
      setConvStatus(failedMessage(err), false);
    }
  }

  tabOcr.addEventListener('click', () => showTab('ocr'));
  tabConvert.addEventListener('click', () => showTab('convert'));

  for (const pill of pills) {
    pill.addEventListener('click', () => applyMode(pill.dataset.mode as ConvertMode));
  }

  convImageFile.addEventListener('change', async () => {
    const f = convImageFile.files?.[0];
    if (f) await convertImage(f);
    convImageFile.value = '';
  });

  convPdfFile.addEventListener('change', async () => {
    const f = convPdfFile.files?.[0];
    if (f) await convertPdf(f);
    convPdfFile.value = '';
  });

  convRun.addEventListener('click', convertText);

  convUseLast.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
    const history: OCRHistoryEntry[] = res?.ok && Array.isArray(res.history) ? res.history : [];
    if (history.length > 0) {
      convText.value = history[0].text || '';
      setConvStatus('');
    } else {
      setConvStatus('No OCR history yet — run an OCR first.', false);
    }
  });

  convCopy.addEventListener('click', async () => {
    if (!lastOutputText) return;
    await navigator.clipboard.writeText(lastOutputText);
    setLabel(convCopy, 'Copied!');
    setTimeout(() => setLabel(convCopy, 'Copy'), 1200);
  });

  convDownload.addEventListener('click', downloadOutput);

  // per-page progress from the offscreen document (background also responds)
  chrome.runtime.onMessage.addListener((message) => {
    const msg = message as Partial<ConvertProgressMsg> & { type?: string };
    if (msg?.type !== 'CONVERT_PROGRESS' || !msg.total) return;
    const page = msg.page || 0;
    convProgress.classList.remove('hidden');
    convProgressBar.style.width = `${Math.round((page / msg.total) * 100)}%`;
    setConvStatus(msg.ocr ? `OCR page ${page}/${msg.total}…` : `Reading page ${page}/${msg.total}…`);
  });

  // restore a PDF conversion whose popup was closed mid-job (10 min window)
  async function restorePendingConvert(): Promise<void> {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_LAST_CONVERT' });
      const last: LastConvert | null = res?.ok ? res.lastConvert : null;
      if (!last?.text || Date.now() - last.ts > 10 * 60 * 1000) return;
      showTab('convert');
      const mode = (last.mode as ConvertMode) || 'pdf-text';
      applyMode(MODE_CONFIG[mode] ? mode : 'pdf-text');
      const out = MODE_CONFIG[currentMode].out;
      const blob =
        out === 'txt'
          ? new Blob([last.text], { type: 'text/plain;charset=utf-8' })
          : out === 'pdf'
            ? buildPdf(last.text)
            : buildDocx(last.text);
      showResult(blob, outName(last.name || 'document', out), last.text, `${last.pages || 0} pages`);
      setConvStatus(
        appSettings.autoDownload
          ? 'Restored your last conversion — downloaded automatically.'
          : 'Restored your last conversion — click Download to save it.',
        false,
      );
    } catch {
      /* nothing to restore */
    }
  }

  document.addEventListener('paste', async (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (item && file) {
      e.preventDefault();
      if (!convertView.classList.contains('hidden') && MODE_CONFIG[currentMode].kind === 'image') {
        await convertImage(file);
      } else {
        await ocrImageData(await fileToDataUrl(file));
      }
    }
  });

  await loadSettings();
  await loadLastResult();
  await loadAuthState();
  await restorePendingConvert();
});
