import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { documents } from '@/db/schema';
import { requireCompany } from '@/lib/queries';
import { currentUser } from '@/lib/session';
import { storageRoot } from '@/domain/documents/storage';

export const dynamic = 'force-dynamic';

/**
 * The stored file, for the review screen's page image. Read-only: documents are
 * never modified (AGENTS.md #5). Served inline with a sandboxing policy so a
 * hostile PDF or SVG cannot run script in the app's origin.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await currentUser())) return new Response('Not signed in.', { status: 401 });
  const { id } = await params;
  const company = requireCompany();
  const doc = getDb().select().from(documents)
    .where(and(eq(documents.id, id), eq(documents.companyId, company.id))).get();
  if (!doc) return new Response('Not found.', { status: 404 });

  const root = resolve(storageRoot());
  const path = resolve(root, doc.storagePath);
  if (!path.startsWith(root + sep)) return new Response('Not found.', { status: 404 });

  let content: Buffer;
  try {
    content = await readFile(path);
  } catch {
    return new Response('The stored file is missing.', { status: 404 });
  }
  return new Response(new Uint8Array(content), {
    headers: {
      'Content-Type': doc.mimeType ?? 'application/octet-stream',
      'Content-Disposition': `inline; filename="${doc.originalFilename.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
