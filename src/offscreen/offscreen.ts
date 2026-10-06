// Offscreen document: has DOM + canvas, hosts Tesseract.js and pdf.js.
// Listens for { type: 'OCR_RUN', payload: { imageData, area?, language?, dpr? } }
// and { type: 'PDF_RUN', payload: { pdfData, language? } }.
// Crops to the selected area, runs OCR, responds. PDFs get text-layer
// extraction with per-page OCR fallback for scanned pages.
// Loaded as a module (offscreen.html) so it can import shared helpers;
// Tesseract/pdfjs remain globals from the classic scripts loaded before it.

import { itemsToText } from '../convert/pdf-text.js';

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
    grayscale(ctx, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  // Light preprocessing: grayscale + contrast stretch helps Tesseract
  function grayscale(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    try {
      const id = ctx.getImageData(0, 0, width, height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      ctx.putImageData(id, 0, 0);
    } catch {
      /* canvas taint shouldn't happen for extension pages, ignore */
    }
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

  // ---------- PDF -> text (pdf.js text layer, OCR fallback for scans) ----------
  // Payload/response types come from the shared ambient types (shared/types.d.ts).

  async function ocrPdfPage(page: PdfjsPage, language?: string): Promise<string> {
    const base = page.getViewport({ scale: 1 });
    // Aim for ~1600px wide so Tesseract gets enough pixels, capped at 3x.
    const scale = Math.min(3, Math.max(2, 1600 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    await page.render({ canvasContext: ctx, viewport }).promise;
    grayscale(ctx, canvas.width, canvas.height);
    const worker = await getWorker(language);
    const { data } = await worker.recognize(canvas.toDataURL('image/png'));
    return (data?.text || '').trim();
  }

  async function extractPdfText({ pdfData, language }: PdfRunPayload): Promise<PdfExtractResponse> {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdfjs/pdf.worker.min.js');
    const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const total = doc.numPages;
    const parts: string[] = [];
    let ocrPages = 0;
    try {
      for (let p = 1; p <= total; p++) {
        const page = await doc.getPage(p);
        let text = '';
        try {
          text = itemsToText((await page.getTextContent()).items).trim();
        } catch (err) {
          console.warn('[pdf] getTextContent failed on page', p, err);
        }
        // Fewer than 10 non-space chars -> treat the page as a scan and OCR it.
        let didOcr = false;
        if (text.replace(/\s/g, '').length < 10) {
          try {
            text = await ocrPdfPage(page, language);
            didOcr = true;
            ocrPages++;
          } catch (err) {
            console.warn('[pdf] page OCR failed on page', p, err);
          }
        }
        parts.push(text);
        chrome.runtime
          .sendMessage({ type: 'CONVERT_PROGRESS', page: p, total, ocr: didOcr })
          .catch(() => {});
      }
    } finally {
      await doc.destroy().catch(() => {});
    }
    return { text: parts.join('\n\n'), pages: total, ocrPages };
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string; payload?: PdfRunPayload } | undefined;
    if (msg?.type !== 'PDF_RUN') return false;
    (async () => {
      try {
        const payload = msg.payload;
        if (!payload?.pdfData) throw new Error('No PDF data');
        sendResponse(await extractPdfText(payload));
      } catch (err) {
        console.error('[pdf] offscreen failed:', err);
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
})();
