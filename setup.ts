// One-time setup: bundles the vendored page assets into libs/.
// Run after `npm install`:
//
//   npm run setup
//
// What it does:
//  1. Copies pdf.js (UMD build + worker) for PDF -> text/Word conversion
// Then build with: npm run build
//
// OCR itself runs in the cloud (Gemini vision), so there are no model assets
// to vendor.

import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const pdfLibs = join(root, 'libs', 'pdfjs');

function need(dir: string, hint?: string): void {
  if (!existsSync(dir)) {
    console.error(`Missing ${dir}\nRun \`npm install\` first. ${hint || ''}`);
    process.exit(1);
  }
}

need(join(root, 'node_modules', 'pdfjs-dist'), '');

// pdf.js (UMD build + worker) for PDF conversion — version-locked by package.json
mkdirSync(pdfLibs, { recursive: true });
for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
  cpSync(join(root, 'node_modules', 'pdfjs-dist', 'build', f), join(pdfLibs, f));
  console.log('bundled', f);
}

console.log('\nSetup complete. Build with: npm run build');
