import { NextResponse } from 'next/server';
import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { getDb } from '@/db';
import { asIsoDate } from '@/domain/dates';
import { customerStatement, type StatementEntry } from '@/domain/invoicing/receivables';
import { renderStatementPdf } from '@/lib/receivablesPdf';
import { toCsv, amountFor, csvResponse, type ExportColumn } from '@/lib/exports';

export const dynamic = 'force-dynamic';

/** A customer's statement of account (issue #405), as PDF or CSV. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireActor('reports.export');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  const { id } = await params;
  const url = new URL(request.url);
  const company = requireCompany();
  let st;
  try {
    st = customerStatement(getDb(), {
      companyId: company.id, customerId: id,
      from: asIsoDate(url.searchParams.get('from') ?? `${new Date().getFullYear()}-01-01`),
      to: asIsoDate(url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10)),
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
  }
  const slug = `statement-${st.customerName.replace(/[^\w.-]+/g, '_')}-${st.to}`;
  if (url.searchParams.get('format') === 'csv') {
    const rows: Array<StatementEntry | { date: string; kind: string; reference: string; amountMinor: number | null; balanceMinor: number }> = [
      { date: st.from, kind: 'opening', reference: 'Balance brought forward', amountMinor: null, balanceMinor: st.openingBalanceMinor },
      ...st.entries,
    ];
    const columns: Array<ExportColumn<(typeof rows)[number]>> = [
      { header: 'Date', value: (r) => r.date },
      { header: 'Type', value: (r) => r.kind },
      { header: 'Reference', value: (r) => r.reference },
      { header: `Amount (${st.currency})`, money: true, value: (r) => amountFor(r.amountMinor, st.currency) },
      { header: `Balance (${st.currency})`, money: true, value: (r) => amountFor(r.balanceMinor, st.currency) },
    ];
    return csvResponse(`${slug}.csv`, toCsv(rows, columns));
  }
  const bytes = await renderStatementPdf(st, {
    name: company.legalName, address: company.principalBusinessAddress ?? company.registeredOffice,
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${slug}.pdf"` },
  });
}
