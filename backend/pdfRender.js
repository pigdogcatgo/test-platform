/**
 * Renders PDF pages to PNG images. Used for extracting diagrams during import.
 * Requires: pdfjs-dist, canvas
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from 'canvas';

/**
 * Render a PDF page to a PNG buffer.
 * @param {Buffer} pdfBuffer - Raw PDF buffer
 * @param {number} pageNum - 1-based page number
 * @param {object} [crop] - Optional normalized crop { x, y, w, h } in 0-1 range
 * @param {number} [scale=2] - Scale factor for resolution
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderPdfPageToPng(pdfBuffer, pageNum, crop = null, scale = 2) {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBuffer) });
  const pdfDoc = await loadingTask.promise;
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  let outCanvas = canvas;
  if (crop && typeof crop.x === 'number' && typeof crop.y === 'number' && typeof crop.w === 'number' && typeof crop.h === 'number') {
    const x = Math.max(0, Math.min(1, crop.x)) * viewport.width;
    const y = Math.max(0, Math.min(1, crop.y)) * viewport.height;
    const maxW = viewport.width - x;
    const maxH = viewport.height - y;
    const w = Math.max(1, Math.min(maxW, crop.w * viewport.width));
    const h = Math.max(1, Math.min(maxH, crop.h * viewport.height));
    const cropCanvas = createCanvas(Math.round(w), Math.round(h));
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    outCanvas = cropCanvas;
  }

  return outCanvas.toBuffer('image/png');
}
