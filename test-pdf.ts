import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';

class NodeCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    const canvas = createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d")
    };
  }
  reset(canvasAndContext: any, width: number, height: number) {
    if (!canvasAndContext.canvas) {
      throw new Error("Canvas is not specified");
    }
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size");
    }
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: any) {
    if (!canvasAndContext.canvas) {
      throw new Error("Canvas is not specified");
    }
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function test() {
  try {
    const data = new Uint8Array(fs.readFileSync('test.pdf'));
    const loadingTask = pdfjsLib.getDocument({ 
      data,
      standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
      disableFontFace: true,
      CanvasFactory: NodeCanvasFactory as any
    });
    const pdfDocument = await loadingTask.promise;
    console.log('numPages:', pdfDocument.numPages);
    
    const page = await pdfDocument.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as any, viewport, canvasFactory: new NodeCanvasFactory() } as any).promise;
    const imgBuffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
    console.log('imgBuffer length:', imgBuffer.length);
  } catch (e) {
    console.error('Error:', e);
  }
}

test();
