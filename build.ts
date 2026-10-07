// Assembles the extension into dist/: copies page assets from src/,
// then `tsc` emits the compiled TypeScript into dist/ (see package.json "build").
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import type { Dirent } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// manifest (already uses dist-relative paths)
cpSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));

// Copy page assets (html/css) from src — TypeScript sources are compiled
// into dist/ by `tsc` right after this script (see package.json "build").
function copyAssets(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true }) as Dirent[]) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyAssets(src, dst);
    else if (/\.(html|css)$/.test(entry.name)) cpSync(src, dst);
  }
}

for (const dir of ['background', 'content', 'ocr', 'offscreen', 'popup', 'sidepanel', 'auth', 'shared']) {
  copyAssets(join(root, 'src', dir), join(dist, dir));
}

for (const dir of ['libs', 'icons']) {
  const actualSrc = join(root, dir);
  if (existsSync(actualSrc)) cpSync(actualSrc, join(dist, dir), { recursive: true });
}

// ship only the generated icons, not the source art / generator script
for (const file of ['source-icon.png', 'generate.ts']) {
  rmSync(join(dist, 'icons', file), { force: true });
}

console.log('Assets copied -> dist/');

// ---------- fixed extension id ----------
// Chrome derives an unpacked extension's id deterministically from its
// folder path: mapToAP(hex(SHA256(UTF-16LE(absolute Windows path))[:32])).
// The id is therefore fixed forever as long as dist/ stays at its canonical
// location — every build verifies that and warns if the path drifted.
const EXPECTED_ID = 'gmniehaogkjbpbjdncmpoimcdgknkopg';

function computeExtensionId(distWinPath: string): string {
  const hex = createHash('sha256').update(Buffer.from(distWinPath, 'utf16le')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function toWindowsPath(p: string): string | null {
  const mnt = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(p);
  if (mnt) return `${mnt[1].toUpperCase()}:\\${mnt[2].split('/').join('\\')}`;
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.split('/').join('\\');
  return null;
}

const distWin = toWindowsPath(dist);
if (distWin) {
  const id = computeExtensionId(distWin);
  if (id === EXPECTED_ID) {
    console.log(`Extension ID: ${id} (fixed for this path)`);
  } else {
    console.warn(
      `WARNING: extension id changed!\n` +
        `  expected ${EXPECTED_ID}\n` +
        `  current  ${id}\n` +
        `  Chrome derives the id from the dist folder path — keep dist/ at\n` +
        `  C:\\Users\\pushp\\OneDrive\\Pushpkant\\project\\ocr-extension\\dist to retain it.`,
    );
  }
} else {
  console.log(`Extension id computed on Windows paths only (expected ${EXPECTED_ID}).`);
}
