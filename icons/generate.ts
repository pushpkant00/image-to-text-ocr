import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const iconsDir = dirname(fileURLToPath(import.meta.url));
const source = join(iconsDir, 'source-icon.png');
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const jobs: Array<[string, number]> = [
  [join(iconsDir, 'icon16.png'), 16],
  [join(iconsDir, 'icon48.png'), 48],
  [join(iconsDir, 'icon128.png'), 128],
  [join(iconsDir, '..', 'docs', 'assets', 'icon.png'), 128],
];

for (const [out, size] of jobs) {
  await sharp(source)
    .resize(size, size, { fit: 'contain', position: 'centre', background: transparent })
    .png()
    .toFile(out);
}
console.log(`Icons generated: ${jobs.map(([out]) => basename(out)).join(', ')}`);
