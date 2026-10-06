// Pure helper: assemble a text string from pdf.js TextContent items.
// Lives outside offscreen.ts so it can be unit-tested in Node.

export function itemsToText(items: PdfjsTextItemLike[]): string {
  let out = '';
  let lastEndX: number | null = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue; // skip TextMarkedContent etc.
    const s = item.str;
    const x = typeof item.transform?.[4] === 'number' ? item.transform[4] : null;
    const w = typeof item.width === 'number' ? item.width : null;

    if (s) {
      if (out && !/\s$/.test(out) && !/^\s/.test(s)) {
        if (lastEndX != null && x != null && w != null) {
          // Real gap after the previous item -> word space; abutting items are
          // mid-word splits (kerning) and must stay joined.
          if (x > lastEndX + 0.5) out += ' ';
        } else {
          out += ' '; // no geometry available — assume separate words
        }
      }
      out += s;
    }

    lastEndX = x != null && w != null ? x + w : null;
    if (item.hasEOL) {
      out += '\n';
      lastEndX = null;
    }
  }
  return out;
}
