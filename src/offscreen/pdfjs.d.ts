// Ambient types for the vendored pdf.js UMD build (libs/pdfjs/pdf.min.js),
// loaded as a classic script by offscreen.html — mirrors tesseract.d.ts.

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
  getDocument(src: { data: ArrayBuffer | Uint8Array }): { promise: Promise<PdfjsDocument> };
};
