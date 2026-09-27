// One-time setup: bundles the on-device OCR assets into libs/tesseract/.
// Run after `npm install`:
//
//   npm run setup
//
// What it does:
//  1. Copies tesseract.min.js + worker.min.js from the npm package
//  2. Copies the Tesseract core (WASM) files for SIMD + non-SIMD devices
//  3. Downloads the English traineddata (~3 MB) for fully offline OCR
// Then build with: npm run build

import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const libs = join(root, 'libs', 'tesseract');
const langDir = join(libs, 'lang-data');

const ENG_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';

function need(dir, hint) {
  if (!existsSync(dir)) {
    console.error(`Missing ${dir}\nRun \`npm install\` first. ${hint || ''}`);
    process.exit(1);
  }
}

need(join(root, 'node_modules', 'tesseract.js'), '');
need(join(root, 'node_modules', 'tesseract.js-core'), '');

mkdirSync(langDir, { recursive: true });

// 1. JS bundles
for (const f of ['tesseract.min.js', 'worker.min.js', 'tesseract.esm.min.js']) {
  cpSync(join(root, 'node_modules', 'tesseract.js', 'dist', f), join(libs, f));
  console.log('bundled', f);
}

// 2. WASM core (SIMD default + non-SIMD fallback)
const core = join(root, 'node_modules', 'tesseract.js-core');
for (const f of [
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
]) {
  cpSync(join(core, f), join(libs, f));
  console.log('bundled', f);
}

// 3. English language data (download once, works offline afterwards)
const dest = join(langDir, 'eng.traineddata.gz');
if (existsSync(dest)) {
  console.log('eng.traineddata.gz already present, skipping download');
} else {
  console.log('downloading eng.traineddata.gz …');
  const res = await fetch(ENG_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import('fs');
  writeFileSync(dest, buf);
  console.log(`saved eng.traineddata.gz (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

console.log('\nSetup complete. Build with: npm run build');
