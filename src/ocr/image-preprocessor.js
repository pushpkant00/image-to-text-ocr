export function cropImage(imageData, area) {
  const img = new Image();
  img.src = imageData;
  return new Promise((resolve) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = area.width * dpr;
      canvas.height = area.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
      resolve(canvas.toDataURL('image/png'));
    };
  });
}

export function preprocessImage(imageData) {
  const img = new Image();
  img.src = imageData;
  return new Promise((resolve) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 2;
      canvas.width = img.width * dpr;
      canvas.height = img.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, 0, 0);
      const imageDataObj = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageDataObj.data;
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        data[i] = avg;
        data[i + 1] = avg;
        data[i + 2] = avg;
      }
      ctx.putImageData(imageDataObj, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
  });
}
