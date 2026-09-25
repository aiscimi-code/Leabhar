import { join } from 'node:path';
import { appRoot } from './paths';

/**
 * The files the browser needs to read text from a scanned page on this
 * computer: the Tesseract worker and engine, the English language data, and
 * the PDF.js worker that turns a PDF page into an image.
 *
 * Served from the app itself, never a CDN, so a document's image never leaves
 * the machine and OCR works offline. Only the names below can be served — the
 * route never builds a path from the request.
 */
export const OCR_ASSETS: Record<string, { path: string; type: string }> = {
  'worker.min.js': { path: 'node_modules/tesseract.js/dist/worker.min.js', type: 'text/javascript' },
  'tesseract-core-simd-lstm.wasm.js': {
    path: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', type: 'text/javascript',
  },
  'tesseract-core-lstm.wasm.js': {
    path: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', type: 'text/javascript',
  },
  'eng.traineddata.gz': {
    path: 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', type: 'application/gzip',
  },
  'pdf.worker.min.mjs': { path: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs', type: 'text/javascript' },
};

export function ocrAssetPath(name: string): { path: string; type: string } | null {
  const asset = Object.hasOwn(OCR_ASSETS, name) ? OCR_ASSETS[name]! : null;
  return asset ? { path: join(appRoot(), asset.path), type: asset.type } : null;
}
