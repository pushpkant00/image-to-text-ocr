interface OcrWorker {
  recognize(image: string): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<void>;
}

declare const Tesseract: {
  createWorker(
    lang: string,
    oem?: number,
    options?: Record<string, unknown>,
  ): Promise<OcrWorker>;
};
