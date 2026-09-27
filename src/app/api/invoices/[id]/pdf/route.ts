import { NextResponse } from 'next/server';
import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { getDb } from '@/db';
import { salesInvoiceDocument } from '@/domain/invoicing/invoiceDocument';
import { renderInvoicePdf } from '@/lib/invoicePdf';

export const dynamic = 'force-dynamic';

/** A sales invoice or credit note as a PDF (issue #395), rendered locally from the posted invoice. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireActor('books.read');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  const { id } = await params;
  let doc;
  try {
    doc = salesInvoiceDocument(getDb(), { companyId: requireCompany().id, invoiceId: id });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
  }
  const bytes = await renderInvoicePdf(doc);
  const name = `${doc.kind === 'credit_note' ? 'credit-note' : 'invoice'}-${(doc.number ?? doc.invoiceId).replace(/[^\w.-]+/g, '_')}`
    + `${doc.missing.length > 0 ? '-DRAFT' : ''}.pdf`;
  return new NextResponse(Buffer.from(bytes), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
  });
}
