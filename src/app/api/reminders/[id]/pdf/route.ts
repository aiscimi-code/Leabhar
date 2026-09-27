import { NextResponse } from 'next/server';
import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { getDb } from '@/db';
import { reminderLetter } from '@/domain/invoicing/receivables';
import { renderReminderPdf } from '@/lib/receivablesPdf';

export const dynamic = 'force-dynamic';

/** A recorded payment reminder letter (issue #405), produced again exactly as it was. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireActor('books.read');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  const { id } = await params;
  let letter;
  try {
    letter = reminderLetter(getDb(), { companyId: requireCompany().id, letterId: id });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
  }
  const bytes = await renderReminderPdf(letter);
  const name = `reminder-${letter.level}-${letter.customer.name.replace(/[^\w.-]+/g, '_')}-${letter.asOf}.pdf`;
  return new NextResponse(Buffer.from(bytes), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
  });
}
