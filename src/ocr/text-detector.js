export function cleanText(text, settings = {}) {
  let cleaned = text;
  if (settings.removeLineBreaks) {
    cleaned = cleaned.replace(/\n+/g, '\n').trim();
  }
  if (settings.mergeSpaces) {
    cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/(\n) /g, '$1');
  }
  return cleaned.trim();
}

export function reconstructText(words) {
  if (!words || words.length === 0) return '';
  const lines = {};
  words.forEach(w => {
    const lineKey = Math.round(w.top / 10) * 10;
    if (!lines[lineKey]) lines[lineKey] = [];
    lines[lineKey].push({ ...w, lineKey });
  });
  const sortedLines = Object.keys(lines).sort((a, b) => a - b);
  return sortedLines.map(lineKey => {
    const lineWords = lines[lineKey].sort((a, b) => a.left - b.left);
    return lineWords.map(w => w.text).join(' ');
  }).join('\n');
}

export function deduplicateLines(lines) {
  const seen = new Set();
  return lines.filter(line => {
    const trimmed = line.trim();
    if (seen.has(trimmed) || trimmed.length < 2) return false;
    seen.add(trimmed);
    return true;
  });
}
