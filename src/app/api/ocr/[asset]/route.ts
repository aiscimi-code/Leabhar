import { readFile } from 'node:fs/promises';
import { ocrAssetPath } from '@/lib/ocrAssets';
import { currentUser } from '@/lib/session';
import { MAP_UPSERT_POLYFILL } from '@/lib/mapPolyfill';

export const dynamic = 'force-dynamic';

/** Serve one allow-listed OCR/PDF asset (see `src/lib/ocrAssets.ts`). */
export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }): Promise<Response> {
  if (!(await currentUser())) return new Response('Not signed in.', { status: 401 });
  const { asset } = await params;
  const found = ocrAssetPath(asset);
  if (!found) return new Response('Not found.', { status: 404 });
  try {
    let content = await readFile(found.path);
    // The PDF.js worker needs the same polyfill as the page (see mapPolyfill.ts).
    if (asset === 'pdf.worker.min.mjs') content = Buffer.concat([Buffer.from(MAP_UPSERT_POLYFILL), content]);
    return new Response(new Uint8Array(content), {
      headers: { 'Content-Type': found.type, 'Cache-Control': 'private, max-age=86400' },
    });
  } catch {
    return new Response('This OCR component is not installed. Reinstall the app.', { status: 404 });
  }
}
