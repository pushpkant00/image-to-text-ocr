// Content script: drag-to-select overlay + toasts.
// Only uses content-script-safe APIs (runtime messaging, storage, clipboard).
// Screen capture + OCR happen in background/offscreen; results come back as OCR_DONE.
(() => {
  if (window.__ocrOverlayInjected) return;
  window.__ocrOverlayInjected = true;

  const OVERLAY_ID = 'ocr-selection-overlay';
  let overlay = null;
  let rect = null;
  let selecting = false;
  let startX = 0;
  let startY = 0;

  function toast(msg, ok = true) {
    document.querySelector('.ocr-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'ocr-toast';
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:${ok ? '#107c10' : '#a4262c'};color:#fff;padding:10px 18px;border-radius:8px;font:13px 'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ok ? 2500 : 4500);
  }

  function progressToast(msg) {
    document.querySelector('.ocr-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'ocr-toast';
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0078d4;color:#fff;padding:10px 18px;border-radius:8px;font:13px 'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    document.body.appendChild(t);
    return t;
  }

  async function copyText(text) {
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

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
    rect = null;
    selecting = false;
  }

  function startSelection() {
    if (overlay || !document.body) return;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="ocr-sel-toolbar"><span>Drag to select text area &nbsp;•&nbsp; <b>Esc</b> cancels</span><button type="button" class="ocr-sel-cancel">Cancel</button></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.ocr-sel-cancel').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      removeOverlay();
    });

    overlay.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ocr-sel-toolbar')) return;
      e.preventDefault();
      selecting = true;
      startX = e.clientX;
      startY = e.clientY;
      rect = document.createElement('div');
      rect.className = 'ocr-sel-rect';
      overlay.appendChild(rect);
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

  async function runCapture(area) {
    const indicator = progressToast('Reading text…');
    try {
      const settings = await chrome.storage.sync.get({ language: 'eng' });
      const res = await chrome.runtime.sendMessage({
        type: 'OCR_CAPTURE',
        area,
        dpr: window.devicePixelRatio || 1,
        language: settings.language || 'eng',
      });
      indicator.remove();
      if (!res?.ok) throw new Error(res?.error || 'OCR failed');
      const text = res.entry?.text || '';
      if (!text) {
        toast('No text found in that area', false);
        return;
      }
      await copyText(text);
      showResultCard(res.entry);
    } catch (err) {
      indicator.remove();
      toast('OCR failed: ' + String(err?.message || err), false);
    }
  }

  function showResultCard(entry) {
    document.querySelector('.ocr-result-card')?.remove();
    const text = entry?.text || '';
    const card = document.createElement('div');
    card.className = 'ocr-result-card';
    card.innerHTML = `
      <div class="ocr-result-header"><span>✓ Copied</span><button type="button" class="ocr-result-close" title="Close">×</button></div>
      <div class="ocr-result-meta"></div>
      <div class="ocr-result-text" tabindex="0"></div>
      <div class="ocr-result-footer"><button type="button" class="ocr-result-copy">Copy</button></div>`;
    card.querySelector('.ocr-result-text').textContent = text;
    card.querySelector('.ocr-result-meta').textContent =
      `${text.length} chars · ${entry.confidence || 0}% confidence · ${entry.language || ''}`;
    card.querySelector('.ocr-result-close').addEventListener('click', () => card.remove());
    const copyBtn = card.querySelector('.ocr-result-copy');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(text);
      copyBtn.textContent = ok ? 'Copied ✓' : 'Failed';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    });
    document.body.appendChild(card);
  }

  // Background notifies us when OCR finishes (right-click flow copies here too)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'START_SELECTION') startSelection();
    if (message?.type === 'OCR_DONE' && message.entry?.text) {
      copyText(message.entry.text).then((ok) => {
        if (ok) showResultCard(message.entry);
        else toast('Text extracted (copy manually from side panel)', false);
      });
    }
    if (message?.type === 'OCR_FAILED') toast('OCR failed: ' + (message.error || ''), false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeOverlay();
      document.querySelector('.ocr-result-card')?.remove();
    }
  });
})();
