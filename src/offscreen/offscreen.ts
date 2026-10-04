// Offscreen document: has DOM + canvas, hosts Tesseract.js.
// Listens for { type: 'OCR_RUN', payload: { imageData, area?, language?, dpr? } }
// Crops to the selected area (scaling CSS px -> screenshot px), runs OCR, responds.
// NOTE: no `import` here — offscreen.html loads this as a classic script.

(() => {
  const workerPromiseByLang: Record<string, Promise<OcrWorker>> = {};

  function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  }

  // Crop a full-tab screenshot down to the user's selection.
  // area is in CSS px; screenshot pixels = CSS px * dpr.
  async function cropToArea(imageData: string, area?: SelectionArea, dpr?: number): Promise<string> {
    if (!area || area.width < 2 || area.height < 2) return imageData;
    const img = await loadImage(imageData);
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
    if (!ctx) return imageData;
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
    } catch {
      /* canvas taint shouldn't happen for screenshots, ignore */
    }
    return canvas.toDataURL('image/png');
  }

  // Only English ships in the package; other languages are fetched from the
  // jsdelivr CDN (langPath unset -> tesseract.js default). Probe the bundled
  // file first so English keeps working offline.
  async function hasBundledLang(lang: string): Promise<boolean> {
    try {
      const r = await fetch(chrome.runtime.getURL(`libs/tesseract/lang-data/${lang}.traineddata.gz`));
      if (!r.ok) return false;
      await r.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }

  async function getWorker(language?: string): Promise<OcrWorker> {
    const lang = language || 'eng';
    if (!workerPromiseByLang[lang]) {
      workerPromiseByLang[lang] = (async () => {
        const opts: Record<string, unknown> = {
          logger: () => {},
          // Spawn the worker directly from the extension URL. The default
          // blob-worker bootstrap (blob URL running importScripts on the
          // chrome-extension:// file) is blocked with a NetworkError.
          workerBlobURL: false,
          workerPath: chrome.runtime.getURL('libs/tesseract/worker.min.js'),
          corePath: chrome.runtime.getURL('libs/tesseract'),
          cacheMethod: 'none',
          gzip: true,
        };
        if (await hasBundledLang(lang)) {
          opts.langPath = chrome.runtime.getURL('libs/tesseract/lang-data');
        }
        const w = await Tesseract.createWorker(lang, 1, opts);
        return w;
      })().catch((e: unknown) => {
        delete workerPromiseByLang[lang];
        throw e;
      });
    }
    return workerPromiseByLang[lang];
  }

  interface OcrRunResponse {
    text?: string;
    confidence?: number;
    error?: string;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string; payload?: OcrRunPayload } | undefined;
    if (msg?.type !== 'OCR_RUN') return false;
    (async () => {
      try {
        const { imageData, area, language, dpr } = msg.payload || {};
        if (!imageData) throw new Error('No image data');
        const cropped = await cropToArea(imageData, area, dpr);
        const worker = await getWorker(language);
        const { data } = await worker.recognize(cropped);
        const text = (data?.text || '').trim();
        const response: OcrRunResponse = { text, confidence: data?.confidence || 0 };
        sendResponse(response);
      } catch (err) {
        console.error('[ocr] offscreen failed:', err);
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
})();
