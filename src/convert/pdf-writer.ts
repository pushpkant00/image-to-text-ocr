// Text -> .pdf (minimal PDF 1.4 writer). Plain-text output with Helvetica,
// accurate word-wrap from the standard AFM width table, automatic pagination.
// Latin-script text renders correctly; other scripts fall back to '?' (use the
// .docx path for full Unicode).

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 72;
const FONT_SIZE = 11;
const LINE_H = 14;
const TOP_Y = PAGE_H - MARGIN;
const BOTTOM_Y = MARGIN;
const MAX_TEXT_W = PAGE_W - MARGIN * 2;
// Baselines from TOP_Y down to BOTTOM_Y inclusive.
const LINES_PER_PAGE = Math.floor((TOP_Y - BOTTOM_Y) / LINE_H) + 1;

// Helvetica advance widths (Adobe AFM), ASCII 32..126, units of 1/1000 em.
const HELV: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// Extra CP1252 positions for common punctuation not present in Latin-1.
const WINANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9d, 0x017e: 0x9e, 0x0178: 0x9f,
};

function charWidth(cp: number): number {
  if (cp >= 32 && cp <= 126) return HELV[cp - 32];
  return 556; // approximate unknown glyphs as '?'
}

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) as number);
  return (w * FONT_SIZE) / 1000;
}

function toWinAnsi(cp: number): number {
  if (cp < 128) return cp;
  const extra = WINANSI_EXTRA[cp];
  if (extra !== undefined) return extra;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return 0x3f; // '?'
}

function escapePdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const b = toWinAnsi(ch.codePointAt(0) as number);
    if (b === 0x5c || b === 0x28 || b === 0x29) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + ((b >> 6) & 7).toString(8) + ((b >> 3) & 7).toString(8) + (b & 7).toString(8);
    else out += String.fromCharCode(b);
  }
  return out;
}

// Greedy wrap preserving whitespace: tokens are space-runs or non-space words.
function wrapLine(line: string): string[] {
  const tokens = line.match(/ +|[^ ]+/g);
  if (!tokens) return [''];

  const out: string[] = [];
  let cur = '';

  const pushCur = (): void => {
    out.push(cur);
    cur = '';
  };

  for (const token of tokens) {
    if (token[0] === ' ') {
      if (textWidth(cur + token) <= MAX_TEXT_W) cur += token;
      else {
        // whitespace overflow — break and drop the run at the edge
        pushCur();
      }
      continue;
    }
    if (textWidth(cur + token) <= MAX_TEXT_W) {
      cur += token;
      continue;
    }
    if (cur.trim()) pushCur();
    if (textWidth(token) <= MAX_TEXT_W) {
      cur = token;
      continue;
    }
    // Word longer than a full line — hard-split by characters.
    let chunk = '';
    for (const ch of token) {
      if (textWidth(chunk + ch) > MAX_TEXT_W && chunk) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    cur = chunk;
  }
  if (cur) out.push(cur);
  if (out.length === 0) out.push('');
  return out;
}

function pageContent(lines: string[]): string {
  let ops = `BT\n/F1 ${FONT_SIZE} Tf\n${LINE_H} TL\n${MARGIN} ${TOP_Y} Td\n`;
  for (const line of lines) {
    ops += `(${escapePdfString(line)}) Tj\nT*\n`;
  }
  return ops + 'ET\n';
}

export function buildPdf(text: string): Blob {
  // Split into paragraphs/lines, then wrap each into visual lines.
  const source = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const visual: string[] = [];
  for (const line of source) visual.push(...wrapLine(line));

  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, visual.length); i += LINES_PER_PAGE) {
    pages.push(visual.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push(['']);

  const pageCount = pages.length;
  // Object layout: 1 catalog, 2 pages, 3 font, then page k -> 4+2k / 5+2k.
  const objectCount = 3 + pageCount * 2;

  const bodies: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    3: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  };
  const kids: string[] = [];
  for (let k = 0; k < pageCount; k++) {
    const pageNum = 4 + k * 2;
    const contentNum = 5 + k * 2;
    kids.push(`${pageNum} 0 R`);
    bodies[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const ops = pageContent(pages[k]);
    bodies[contentNum] = `<< /Length ${ops.length} >>\nstream\n${ops}endstream`;
  }
  bodies[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let pos = 0;
  const push = (data: string | Uint8Array): void => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(b);
    pos += b.length;
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

  const offsets: number[] = [];
  for (let n = 1; n <= objectCount; n++) {
    offsets[n] = pos;
    push(`${n} 0 obj\n${bodies[n]}\nendobj\n`);
  }

  const xrefPos = pos;
  push(`xref\n0 ${objectCount + 1}\n`);
  push('0000000000 65535 f \n');
  for (let n = 1; n <= objectCount; n++) {
    push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const file = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    file.set(p, at);
    at += p.length;
  }
  return new Blob([file], { type: 'application/pdf' });
}
