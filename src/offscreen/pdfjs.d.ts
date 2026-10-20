// Ambient types for the vendored pdf.js UMD build (libs/pdfjs/pdf.min.js),
// loaded as a classic script by offscreen.html.

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsTextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
}

interface PdfjsTextContent {
  items: PdfjsTextItemLike[];
}

interface PdfjsRenderTask {
  promise: Promise<void>;
}

interface PdfjsPage {
  getViewport(opts: { scale: number }): PdfjsViewport;
  getTextContent(): Promise<PdfjsTextContent>;
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfjsViewport }): PdfjsRenderTask;
}

interface PdfjsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}

declare const pdfjsLib: {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: {
    data: ArrayBuffer | Uint8Array;
    /** Keep pdf.js from building functions at runtime (extension CSP has no unsafe-eval). */
    isEvalSupported?: boolean;
  }): { promise: Promise<PdfjsDocument> };
};
