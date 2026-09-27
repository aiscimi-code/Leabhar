import { NextResponse } from 'next/server';
import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { getDb } from '@/db';
import { purchaseOrderDocument } from '@/domain/invoicing/purchaseOrders';
import { renderPurchaseOrderPdf } from '@/lib/purchaseOrderPdf';

export const dynamic = 'force-dynamic';

/** A purchase order (issue #411) as a PDF to send to the supplier. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireActor('books.read');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  const { id } = await params;
  let docu;
  try {
    docu = purchaseOrderDocument(getDb(), { companyId: requireCompany().id, purchaseOrderId: id });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
  }
  const bytes = await renderPurchaseOrderPdf(docu);
  return new NextResponse(Buffer.from(bytes), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${docu.order.number}.pdf"` },
  });
}
