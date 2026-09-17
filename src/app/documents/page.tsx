import Link from 'next/link';
import { documentList, activeCompany } from '@/lib/queries';
import { Page, Panel, Badge, ProvenanceBadge, Empty, Figure } from '@/components/primitives';
import { UploadForm, RematchButton, WatchFolderButton } from '@/components/DocumentActions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Document repository (README §11). */
export default async function DocumentsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const rows = documentList({ status: params['status'], search: params['q'] });
  const company = activeCompany();
  const hasWatchPath = !!(company?.documentWatchPath);

  const unmatched = rows.filter((r) => r.document.matchStatus !== 'matched').length;

  return (
    <Page
      title="Documents"
      subtitle={`${rows.length} stored${unmatched > 0 ? `, ${unmatched} not yet matched to a transaction` : ''}. Originals are never modified.`}
      actions={<RematchButton />}
    >
      <Panel
        title="Add documents"
        description="Invoices, receipts, credit notes and statements. PDFs and images are read
          automatically; nothing is ever written back to the file you upload."
      >
        <div className="px-4 py-3 space-y-3">
          <UploadForm />
          <div className="pt-3 border-t border-line">
            <WatchFolderButton hasWatchPath={hasWatchPath} />
          </div>
        </div>
      </Panel>

      <Panel>
        <form method="get" className="flex items-end gap-2 px-4 py-2.5 border-b border-line">
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Search
            </label>
            <input type="search" name="q" defaultValue={params['q'] ?? ''}
              placeholder="Filename or invoice number"
              className="border border-line-strong rounded px-2 py-1 text-[12px] w-64" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Match status
            </label>
            <select name="status" defaultValue={params['status'] ?? 'all'}
              className="border border-line-strong rounded px-2 py-1 text-[12px]">
              {['all', 'unmatched', 'suggested', 'matched', 'conflict'].map((s) => (
                <option key={s} value={s}>{s === 'all' ? 'All' : label(s)}</option>
              ))}
            </select>
          </div>
          <button type="submit"
            className="px-2.5 py-1 rounded border border-accent bg-accent text-white text-[12px] font-medium">
            Apply
          </button>
          <Link href="/documents" className="text-[12px] text-ink-muted hover:underline px-1">Clear</Link>
        </form>

        {rows.length === 0 ? (
          <Empty title="No documents yet" detail="Upload an invoice or receipt to get started." />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>File</th>
                <th className="w-40">Supplier</th>
                <th className="w-32">Invoice no.</th>
                <th className="w-24">Date</th>
                <th className="w-28 text-right">Net</th>
                <th className="w-24 text-right">VAT</th>
                <th className="w-28 text-right">Total</th>
                <th className="w-40">Matched to</th>
                <th className="w-32">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ document: doc, supplierName, transactionDescription }) => (
                <tr key={doc.id}>
                  <td>
                    <Link href={`/documents/${doc.id}`} className="text-accent hover:underline">
                      {doc.originalFilename}
                    </Link>
                    {doc.isDuplicateOf && (
                      <Badge tone="negative">Duplicate</Badge>
                    )}
                  </td>
                  <td>{supplierName ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="num !text-left">{doc.invoiceNumber ?? '—'}</td>
                  <td className="num !text-left">{date(doc.documentDate)}</td>
                  <td className="text-right num">{money(doc.netMinor, doc.currency ?? 'EUR')}</td>
                  <td className="text-right num">{money(doc.vatMinor, doc.currency ?? 'EUR')}</td>
                  <td className="text-right num">{money(doc.grossMinor, doc.currency ?? 'EUR')}</td>
                  <td>
                    {doc.matchedTransactionId ? (
                      <Link href={`/transactions/${doc.matchedTransactionId}`}
                        className="text-accent hover:underline">
                        {transactionDescription ?? 'Transaction'}
                      </Link>
                    ) : <span className="text-ink-faint">—</span>}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={doc.matchStatus === 'matched' ? 'positive'
                        : doc.matchStatus === 'conflict' ? 'negative'
                        : doc.matchStatus === 'suggested' ? 'accent' : 'caution'}>
                        {label(doc.matchStatus)}
                      </Badge>
                      <ProvenanceBadge status={doc.provenanceStatus} confidence={doc.confidence} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
