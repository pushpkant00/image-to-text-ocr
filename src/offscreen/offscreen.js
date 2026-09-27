// Offscreen document: has DOM + canvas, hosts Tesseract.js.
// Listens for { type: 'OCR_RUN', payload: { imageData, area?, language?, dpr? } }
// Crops to the selected area (scaling CSS px -> screenshot px), runs OCR, responds.

let workerPromiseByLang = {};

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Crop a full-tab screenshot down to the user's selection.
// area is in CSS px; screenshot pixels = CSS px * dpr.
async function cropToArea(imageData, area, dpr) {
  if (!area || area.width < 2 || area.height < 2) return imageData;
  const img = await loadImage(imageData);
  const scaleX = img.width / window.innerWidth / (1); // fallback if sizes mismatch
  const sx = Math.max(0, Math.round(area.x * (dpr || 1)));
  const sy = Math.max(0, Math.round(area.y * (dpr || 1)));
  const sw = Math.min(img.width - sx, Math.round(area.width * (dpr || 1)));
  const sh = Math.min(img.height - sy, Math.round(area.height * (dpr || 1)));
  if (sw < 2 || sh < 2) return imageData;

  // Upscale tiny selections so Tesseract has enough pixels
  const targetH = Math.max(sh, 120);
  const k = targetH / sh;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  // Light preprocessing: grayscale + contrast stretch helps Tesseract
  try {
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(id, 0, 0);
  } catch (_) {
    /* canvas taint shouldn't happen for screenshots, ignore */
  }
  void scaleX;
  return canvas.toDataURL('image/png');
}

async function getWorker(language) {
  const lang = language || 'eng';
  if (!workerPromiseByLang[lang]) {
    workerPromiseByLang[lang] = (async () => {
      const w = await Tesseract.createWorker(lang, 1, {
        logger: () => {},
        // Spawn the worker directly from the extension URL. The default
        // blob-worker bootstrap (blob URL running importScripts on the
        // chrome-extension:// file) is blocked with a NetworkError.
        workerBlobURL: false,
        workerPath: chrome.runtime.getURL('libs/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('libs/tesseract'),
        langPath: chrome.runtime.getURL('libs/tesseract/lang-data'),
        cacheMethod: 'none',
        gzip: true,
      });
      return w;
    })().catch((e) => {
      delete workerPromiseByLang[lang];
      throw e;
    });
  }
  return workerPromiseByLang[lang];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'OCR_RUN') return false;
  (async () => {
    try {
      const { imageData, area, language, dpr } = message.payload || {};
      if (!imageData) throw new Error('No image data');
      const cropped = await cropToArea(imageData, area, dpr);
      const worker = await getWorker(language);
      const { data } = await worker.recognize(cropped);
      const text = (data?.text || '').trim();
      // Copy straight to clipboard here (offscreen has DOM + clipboard permission)
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          /* background/content will copy as fallback */
        }
      }
      sendResponse({ text, confidence: data?.confidence || 0 });
    } catch (err) {
      console.error('[ocr] offscreen failed:', err);
      sendResponse({ error: String(err?.message || err) });
    }
  })();
  return true;
});
