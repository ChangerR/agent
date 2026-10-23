/** 原生缩放下按完整应用内容窗口截图，避免 CDP 按 CSS 尺寸裁切物理像素。 */
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
export async function captureWindow(app, page, path) {
  const window = await app.browserWindow(page);
  const image = await window.evaluate(async (window) => {
    const image = await window.capturePage();
    return {
      png: image.toPNG().toString('base64'),
      content: window.getContentBounds(),
      zoom: window.webContents.getZoomFactor(),
    };
  });
  const buffer = Buffer.from(image.png, 'base64');
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  const pixels = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  assert.ok(
    Math.abs(pixels.width - viewport.width * viewport.dpr) <= 2,
    '完整截图宽度必须匹配整个内容视口物理像素',
  );
  assert.ok(
    Math.abs(pixels.height - viewport.height * viewport.dpr) <= 2,
    '完整截图高度必须匹配整个内容视口物理像素',
  );
  await writeFile(path, buffer);
  return { content: image.content, zoom: image.zoom, viewport, pixels };
}
