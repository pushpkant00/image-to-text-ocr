const { createCanvas } = require('canvas');
const fs = require('fs');

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Blue background
  ctx.fillStyle = '#0078d4';
  ctx.fillRect(0, 0, size, size);
  
  // White text icon (T)
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size * 0.5}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', size / 2, size / 2);
  
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(`icons/icon${size}.png`, buffer);
}

[16, 48, 128].forEach(generateIcon);
console.log('Icons generated!');
