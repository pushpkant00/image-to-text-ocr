export function cleanText(text: string, settings: Partial<OCRSettings> = {}): string {
  let cleaned = text;
  if (settings.removeLineBreaks) {
    cleaned = cleaned.replace(/\n+/g, '\n').trim();
  }
  if (settings.mergeSpaces) {
    cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/(\n) /g, '$1');
  }
  return cleaned.trim();
}
