import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, CanvasRenderingContext2D } from 'canvas';
import { Path2D, applyPath2DToCanvasRenderingContext } from 'path2d';
import fs from 'fs';

(global as any).Path2D = Path2D;
applyPath2DToCanvasRenderingContext(CanvasRenderingContext2D as any);

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext: any, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: any) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function run({ disableFontFace }: { disableFontFace: boolean }) {
  const data = new Uint8Array(fs.readFileSync('test.pdf'));
  const loadingTask = pdfjsLib.getDocument({ 
    data,
    disableFontFace,
    standardFontDataUrl: './node_modules/pdfjs-dist/standard_fonts/',
  });
  const pdfDocument = await loadingTask.promise;
  const page = await pdfDocument.getPage(1);
  const viewport = page.getViewport({ scale: 1.0 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context as any, viewport, canvasFactory: new NodeCanvasFactory() } as any).promise;
  fs.writeFileSync(`test_${disableFontFace}.jpg`, canvas.toBuffer('image/jpeg'));
  console.log(`done ${disableFontFace}`);
}

async function main() {
  await run({ disableFontFace: true });
  await run({ disableFontFace: false });
}
main().catch(console.error);
