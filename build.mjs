import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// manifest (already uses dist-relative paths)
cpSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));

// Copy page assets (html/css) from src — TypeScript sources are compiled
// into dist/ by `tsc` right after this script (see package.json "build").
function copyAssets(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyAssets(src, dst);
    else if (/\.(html|css)$/.test(entry.name)) cpSync(src, dst);
  }
}

for (const dir of ['background', 'content', 'ocr', 'offscreen', 'popup', 'sidepanel', 'shared']) {
  copyAssets(join(root, 'src', dir), join(dist, dir));
}

for (const dir of ['libs', 'icons']) {
  const actualSrc = join(root, dir);
  if (existsSync(actualSrc)) cpSync(actualSrc, join(dist, dir), { recursive: true });
}

// ship only the generated icons, not the source art / generator script
for (const file of ['source-icon.png', 'generate.js']) {
  rmSync(join(dist, 'icons', file), { force: true });
}

console.log('Assets copied -> dist/');
