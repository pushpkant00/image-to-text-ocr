import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// manifest (already uses dist-relative paths)
cpSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));

// folders preserved 1:1 (manifest references these dist-relative paths)
for (const dir of ['background', 'content', 'ocr', 'offscreen', 'popup', 'sidepanel', 'shared']) {
  const actualSrc = join(root, 'src', dir);
  if (existsSync(actualSrc)) cpSync(actualSrc, join(dist, dir), { recursive: true });
}
for (const dir of ['libs', 'icons']) {
  const actualSrc = join(root, dir);
  if (existsSync(actualSrc)) cpSync(actualSrc, join(dist, dir), { recursive: true });
}

// ship only the generated icons, not the source art / generator script
for (const file of ['source-icon.png', 'generate.js']) {
  rmSync(join(dist, 'icons', file), { force: true });
}

console.log('Build complete -> dist/');
console.log('Load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> dist/');
