import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const iconsDir = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(iconsDir, 'source-icon.png');

async function generateIcon(size) {
  const image = await loadImage(source);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const side = Math.max(image.width, image.height);
  const scale = size / side;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    image,
    (size - image.width * scale) / 2,
    (size - image.height * scale) / 2,
    image.width * scale,
    image.height * scale
  );

  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), canvas.toBuffer('image/png'));
}

const sizes = [16, 48, 128];
for (const size of sizes) {
  await generateIcon(size);
}
console.log(`Icons generated: ${sizes.join(', ')}`);
