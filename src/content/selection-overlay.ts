// Content script: drag-to-select overlay + toasts.
// Only uses content-script-safe APIs (runtime messaging, storage, clipboard).
// Screen capture + OCR happen in background/offscreen; results come back as OCR_DONE.
// NOTE: no `import` here — content scripts are loaded as classic scripts, so this
// file must stay a script (shared types come from src/shared/types.d.ts globals).

interface Window {
  __ocrOverlayInjected?: boolean;
}

(() => {
  const q = <T extends Element>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;

  if (window.__ocrOverlayInjected) return;
  window.__ocrOverlayInjected = true;

  const OVERLAY_ID = 'ocr-selection-overlay';
  let overlay: HTMLDivElement | null = null;
  let rect: HTMLDivElement | null = null;
  let selecting = false;
  let startX = 0;
  let startY = 0;

  function toast(msg: string, ok = true): void {
    document.querySelector('.ocr-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'ocr-toast';
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:${ok ? '#107c10' : '#a4262c'};color:#fff;padding:10px 18px;border-radius:8px;font:13px 'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ok ? 2500 : 4500);
  }

  function progressToast(msg: string): HTMLDivElement {
    document.querySelector('.ocr-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'ocr-toast';
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0078d4;color:#fff;padding:10px 18px;border-radius:8px;font:13px 'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    document.body.appendChild(t);
    return t;
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function removeOverlay(): void {
    overlay?.remove();
    overlay = null;
    rect = null;
    selecting = false;
  }

  function startSelection(): void {
    if (overlay || !document.body) return;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="ocr-sel-toolbar"><span>Drag to select text area &nbsp;•&nbsp; <b>Esc</b> cancels</span><button type="button" class="ocr-sel-cancel">Cancel</button></div>`;
    document.body.appendChild(overlay);
    q<HTMLButtonElement>(overlay, '.ocr-sel-cancel').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      removeOverlay();
    });

    overlay.addEventListener('mousedown', (e) => {
      if ((e.target as Element).closest('.ocr-sel-toolbar')) return;
      e.preventDefault();
      selecting = true;
      startX = e.clientX;
      startY = e.clientY;
      rect = document.createElement('div');
      rect.className = 'ocr-sel-rect';
      overlay?.appendChild(rect);
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!selecting || !rect) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      rect.style.left = x + 'px';
      rect.style.top = y + 'px';
      rect.style.width = Math.abs(e.clientX - startX) + 'px';
      rect.style.height = Math.abs(e.clientY - startY) + 'px';
    });

    overlay.addEventListener('mouseup', async (e) => {
      if (!selecting) return;
      selecting = false;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      removeOverlay();
      if (w < 10 || h < 10) return;
      await runCapture({ x, y, width: w, height: h });
    });
  }

  async function runCapture(area: SelectionArea): Promise<void> {
    const indicator = progressToast('Reading text…');
    try {
      const settings = await chrome.storage.sync.get<SyncStorage>({ language: 'eng', showResultCard: true });
      const res = await chrome.runtime.sendMessage({
        type: 'OCR_CAPTURE',
        area,
        dpr: window.devicePixelRatio || 1,
        language: settings.language || 'eng',
      });
      indicator.remove();
      if (!res?.ok) throw new Error(res?.error || 'OCR failed');
      const text: string = res.entry?.text || '';
      if (!text) {
        toast('No text found in that area', false);
        return;
      }
      if (settings.showResultCard !== false) showResultCard(res.entry);
    } catch (err) {
      indicator.remove();
      toast('OCR failed: ' + (err instanceof Error ? err.message : String(err)), false);
    }
  }

  const EXT_ICON = chrome.runtime.getURL('icons/icon16.png');
  const EYE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const COPY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  function showResultCard(entry: OCRHistoryEntry): void {
    document.querySelector('.ocr-result-card')?.remove();
    const text = entry?.text || '';
    const card = document.createElement('div');
    card.className = 'ocr-result-card';
    card.innerHTML = `
      <div class="ocr-result-header">
        <span class="ocr-result-title"><img class="ocr-card-icon" src="${EXT_ICON}" alt=""><span class="ocr-result-heading">Text extracted</span><span class="ocr-result-confidence"></span></span>
        <button type="button" class="ocr-result-close" title="Close">×</button>
      </div>
      <div class="ocr-result-meta"></div>
      <div class="ocr-result-text" tabindex="0"></div>
      <div class="ocr-result-footer">
        <button type="button" class="ocr-result-preview">${EYE_SVG}<span>Preview</span></button>
        <button type="button" class="ocr-result-copy">${COPY_SVG}<span>Copy</span></button>
      </div>
      <div class="ocr-resize-handle" title="Drag to resize"></div>`;
    const textEl = q<HTMLElement>(card, '.ocr-result-text');
    textEl.textContent = text;
    q<HTMLElement>(card, '.ocr-result-meta').textContent =
      `${text.length} chars · ${entry.confidence || 0}% confidence · ${entry.language || ''}`;
    const confidence = Math.max(0, Math.min(100, Math.round(entry.confidence || 0)));
    const confidenceEl = q<HTMLElement>(card, '.ocr-result-confidence');
    confidenceEl.textContent = `${confidence}% accuracy`;
    confidenceEl.title = `OCR confidence: ${confidence}%`;
    confidenceEl.classList.add(confidence >= 80 ? 'is-high' : confidence >= 50 ? 'is-mid' : 'is-low');
    q<HTMLButtonElement>(card, '.ocr-result-close').addEventListener('click', () => card.remove());

    const heading = q<HTMLElement>(card, '.ocr-result-heading');
    const previewBtn = q<HTMLButtonElement>(card, '.ocr-result-preview');
    const previewLabel = q<HTMLElement>(previewBtn, 'span');
    previewBtn.addEventListener('click', () => {
      const open = card.classList.toggle('ocr-preview-open');
      previewLabel.textContent = open ? 'Hide' : 'Preview';
      if (open) {
        // cap the default size at ~40vh; the card is resizable from there
        const cap = Math.round(window.innerHeight * 0.4);
        card.style.height = Math.min(card.offsetHeight, cap) + 'px';
      } else {
        card.style.height = '';
      }
    });

    // custom resize grip, bottom-left corner (drags the card wider leftward + taller)
    const handle = q<HTMLElement>(card, '.ocr-resize-handle');
    let drag: { x: number; y: number; w: number; h: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, w: card.offsetWidth, h: card.offsetHeight };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      card.style.width = Math.max(200, drag.w + (drag.x - e.clientX)) + 'px';
      card.style.height = Math.max(60, drag.h + (e.clientY - drag.y)) + 'px';
    });
    const endDrag = (): void => {
      drag = null;
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    const copyBtn = q<HTMLButtonElement>(card, '.ocr-result-copy');
    const copyLabel = q<HTMLElement>(copyBtn, 'span');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(text);
      copyLabel.textContent = ok ? 'Copied ✓' : 'Failed';
      if (ok) heading.textContent = '✓ Copied';
      setTimeout(() => (copyLabel.textContent = 'Copy'), 1200);
    });
    document.body.appendChild(card);
  }

  // Background notifies us when OCR finishes (right-click flow shows the card too)
  chrome.runtime.onMessage.addListener((message) => {
    const msg = message as ContentRequest | undefined;
    if (msg?.type === 'START_SELECTION') startSelection();
    if (msg?.type === 'OCR_DONE' && msg.entry?.text) showResultCard(msg.entry);
    if (msg?.type === 'OCR_FAILED') toast('OCR failed: ' + (msg.error || ''), false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeOverlay();
      document.querySelector('.ocr-result-card')?.remove();
    }
  });
})();
