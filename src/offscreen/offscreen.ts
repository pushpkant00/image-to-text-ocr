// Offscreen document: has DOM + canvas. Crops screenshots, renders PDF pages
// with pdf.js, and sends each image to the cloud OCR engine (Gemini vision).
// Listens for { type: 'OCR_RUN', payload: OcrRunPayload } and
// { type: 'PDF_RUN', payload: PdfRunPayload }; the background resolves the
// user's Gemini API key and model and attaches them to the payload.
// Loaded as a module (offscreen.html); pdf.js remains a global classic script.

import { itemsToText } from '../convert/pdf-text.js';
import { DEFAULT_VISION_MODEL, MAX_VISION_EDGE, recognizeImage } from '../ocr/vision.js';

(() => {
  /** Shortest edge we hand to the model — below this the encoder rarely
   *  resolves individual glyphs, so small crops are scaled up. Keeping this
   *  low avoids inflating tokens for small selections. */
  const VISION_MIN_EDGE = 384;

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  }

  /** JPEG at high quality: ~5x smaller than PNG for screenshots, so the upload
   *  (which dominates latency) is much shorter. Text stays legible at 0.92. */
  function encode(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  interface PreparedImage {
    dataUrl: string;
    width: number;
    height: number;
  }

  interface EngineOptions {
    model?: string;
    provider?: VisionProviderId;
    apiKey?: string;
    language?: string;
  }

  /**
   * Crop a full-tab screenshot down to the user's selection and size it for
   * the model. area is in CSS px; screenshot pixels = CSS px * dpr.
   */
  async function prepareImage(
    imageData: string,
    area: SelectionArea | undefined,
    dpr: number | undefined,
  ): Promise<PreparedImage> {
    const img = await loadImage(imageData);
    const ratio = dpr || 1;

    let sx = 0;
    let sy = 0;
    let sw = img.width;
    let sh = img.height;
    if (area && area.width >= 2 && area.height >= 2) {
      sx = Math.max(0, Math.round(area.x * ratio));
      sy = Math.max(0, Math.round(area.y * ratio));
      sw = Math.min(img.width - sx, Math.round(area.width * ratio));
      sh = Math.min(img.height - sy, Math.round(area.height * ratio));
    }
    if (sw < 2 || sh < 2) {
      sx = 0;
      sy = 0;
      sw = img.width;
      sh = img.height;
    }

    // Grow small crops so glyphs span more encoder patches, but cap the long
    // edge — bigger images are just more tokens and latency.
    let scale = Math.max(1, VISION_MIN_EDGE / Math.min(sw, sh));
    scale = Math.min(scale, MAX_VISION_EDGE / Math.max(sw, sh));

    const width = Math.max(1, Math.round(sw * scale));
    const height = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: imageData, width: img.width, height: img.height };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    return { dataUrl: encode(canvas), width, height };
  }

  function visionRequest(image: PreparedImage, options: EngineOptions) {
    return {
      imageData: image.dataUrl,
      model: options.model || DEFAULT_VISION_MODEL,
      provider: options.provider || 'google',
      language: options.language,
      apiKey: options.apiKey,
    };
  }

  async function ocrPrepared(
    image: PreparedImage,
    options: EngineOptions,
    onDelta?: (fullText: string) => void,
  ): Promise<RawOcrResult> {
    const result = await recognizeImage(visionRequest(image, options), onDelta);
    return { text: result.text.trim() };
  }

  // ---------- PDF -> text (pdf.js text layer, OCR fallback for scans) ----------

  async function ocrPdfPage(page: PdfjsPage, options: EngineOptions): Promise<string> {
    const base = page.getViewport({ scale: 1 });
    // ~2000px wide keeps small print legible; the long edge never exceeds the
    // model's useful resolution.
    let scale = Math.min(4, Math.max(2, 2000 / base.width));
    scale = Math.min(scale, MAX_VISION_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    await page.render({ canvasContext: ctx, viewport }).promise;

    const result = await recognizeImage(
      visionRequest(
        { dataUrl: encode(canvas), width: canvas.width, height: canvas.height },
        options,
      ),
    );
    return result.text.trim();
  }

  async function extractPdfText(payload: PdfRunPayload): Promise<PdfExtractResponse> {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdfjs/pdf.worker.min.js');
    const doc = await pdfjsLib.getDocument({ data: payload.pdfData, isEvalSupported: false }).promise;
    const total = doc.numPages;
    const options: EngineOptions = {
      model: payload.model,
      provider: payload.provider || 'google',
      apiKey: payload.apiKey,
      language: payload.language,
    };
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
            text = await ocrPdfPage(page, options);
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
        const payload = msg.payload;
        if (!payload?.imageData) throw new Error('No image data');
        const options: EngineOptions = {
          model: payload.model,
          provider: payload.provider || 'google',
          apiKey: payload.apiKey,
          language: payload.language,
        };
        const t0 = performance.now();
        const image = await prepareImage(payload.imageData, payload.area, payload.dpr);
        const t1 = performance.now();
        // Relay streamed text to the tab so the user sees it while the model
        // is still writing. Throttled: one message per ~90ms is plenty.
        let lastSent = 0;
        let firstDelta = 0;
        const onDelta = (fullText: string): void => {
          if (!payload.tabId) return;
          const now = Date.now();
          if (!firstDelta) firstDelta = now;
          if (now - lastSent < 90) return;
          lastSent = now;
          chrome.runtime
            .sendMessage({
              type: 'OCR_PARTIAL',
              tabId: payload.tabId,
              requestId: payload.requestId,
              text: fullText,
            })
            .catch(() => {});
        };
        const result = await ocrPrepared(image, options, onDelta);
        console.info(
          `[ocr] crop ${Math.round(t1 - t0)}ms · first text ${Math.round((firstDelta || t1) - t1)}ms · model ${Math.round(performance.now() - t1)}ms · ${image.width}x${image.height}`,
        );
        sendResponse(result);
      } catch (err) {
        console.error('[ocr] offscreen failed:', err);
        sendResponse({ error: errorMessage(err) } satisfies RawOcrResult);
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
        sendResponse({ error: errorMessage(err) });
      }
    })();
    return true;
  });
})();
