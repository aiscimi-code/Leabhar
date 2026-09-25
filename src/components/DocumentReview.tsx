'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Select, Textarea } from './primitives';
import {
  checkDocumentValues, type DocumentCheck, type ReviewedDocumentValues,
} from '@/domain/documents/checks';
import { parseAmount, parseRate, formatAmount, formatRate } from '@/domain/money';
import { installMapUpsertPolyfill } from '@/lib/mapPolyfill';
import {
  confirmDocumentAction, rejectDocumentAction, reopenDocumentAction, readRecognisedTextAction,
  type ActionResult,
} from '@/app/actions';

/**
 * The document review screen (issue #202).
 *
 * The page itself, at a size that fits beside the sheet, and every value read
 * from it in editable form. The person compares the two, corrects or adds what
 * is wrong or missing, and confirms. Until then nothing downstream uses the
 * document. The checks shown are the same pure function the server re-runs at
 * confirmation, so what passes here passes there.
 */

type Option = { id: string; name: string };

interface LineText {
  description: string; quantity: string; unitPrice: string; net: string; rate: string; vat: string; gross: string;
}
interface VatTotalText { rate: string; label: string; net: string; vat: string }
interface HeaderText {
  documentType: ReviewedDocumentValues['documentType'];
  invoiceNumber: string; documentDate: string; dueDate: string; supplyDate: string; currency: string;
  supplierNameStated: string; supplierAddress: string; supplierVatNumber: string; supplierCountry: string;
  customerNameStated: string; customerAddress: string; customerVatNumber: string; customerCountry: string;
  vatLegends: string; paymentTerms: string; originalDocumentNumber: string;
  net: string; vat: string; gross: string;
}

const DOCUMENT_TYPES: Array<[ReviewedDocumentValues['documentType'], string]> = [
  ['supplier_invoice', 'Supplier invoice'], ['receipt', 'Receipt'], ['credit_note', 'Credit note'],
  ['sales_invoice', 'Sales invoice'], ['sales_record', 'Sales record (till/Z report)'],
  ['proforma', 'Pro-forma (not a VAT invoice)'], ['tax_document', 'Revenue / tax document'], ['company_document', 'Company document'],
  ['contract', 'Contract'], ['bank_statement', 'Bank statement'], ['other', 'Other'], ['unknown', 'Not yet known'],
];

const amountText = (minor: number | null, currency: string) =>
  minor === null ? '' : formatAmount(minor, currency || 'EUR');
const rateText = (bp: number | null) => (bp === null ? '' : formatRate(bp).replace('%', ''));

function toText(v: ReviewedDocumentValues, fallbackCurrency: string): { header: HeaderText; lines: LineText[]; vatTotals: VatTotalText[] } {
  const c = v.currency ?? fallbackCurrency;
  return {
    header: {
      documentType: v.documentType,
      invoiceNumber: v.invoiceNumber ?? '', documentDate: v.documentDate ?? '', dueDate: v.dueDate ?? '',
      supplyDate: v.supplyDate ?? '', currency: v.currency ?? '',
      supplierNameStated: v.supplierNameStated ?? '', supplierAddress: v.supplierAddress ?? '',
      supplierVatNumber: v.supplierVatNumber ?? '', supplierCountry: v.supplierCountry ?? '',
      customerNameStated: v.customerNameStated ?? '', customerAddress: v.customerAddress ?? '',
      customerVatNumber: v.customerVatNumber ?? '', customerCountry: v.customerCountry ?? '',
      vatLegends: v.vatLegends.join('\n'), paymentTerms: v.paymentTerms ?? '',
      originalDocumentNumber: v.originalDocumentNumber ?? '',
      net: amountText(v.netMinor, c), vat: amountText(v.vatMinor, c), gross: amountText(v.grossMinor, c),
    },
    lines: v.lines.map((l) => ({
      description: l.description, quantity: l.quantity ?? '', unitPrice: amountText(l.unitPriceMinor, c),
      net: amountText(l.netMinor, c), rate: rateText(l.vatRateBasisPoints), vat: amountText(l.vatMinor, c),
      gross: amountText(l.grossMinor, c),
    })),
    vatTotals: v.vatTotals.map((t) => ({
      rate: rateText(t.rateBasisPoints), label: t.label ?? '', net: amountText(t.netMinor, c), vat: amountText(t.vatMinor, c),
    })),
  };
}

/** Parse the sheet back into values, collecting any field that is not a valid amount, rate or quantity. */
function fromText(h: HeaderText, lines: LineText[], totals: VatTotalText[]): { values: ReviewedDocumentValues; parseErrors: DocumentCheck[] } {
  const errors: DocumentCheck[] = [];
  const currency = h.currency.trim().toUpperCase() || 'EUR';
  const amount = (s: string, where: string): number | null => {
    if (!s.trim()) return null;
    try { return parseAmount(s, currency); } catch {
      errors.push({ code: `parse_${where}`, severity: 'error', message: `${where}: "${s}" is not an amount.` });
      return null;
    }
  };
  const rate = (s: string, where: string): number | null => {
    if (!s.trim()) return null;
    try { return parseRate(s); } catch {
      errors.push({ code: `parse_${where}`, severity: 'error', message: `${where}: "${s}" is not a VAT rate.` });
      return null;
    }
  };
  const text = (s: string) => (s.trim() ? s.trim() : null);
  const values: ReviewedDocumentValues = {
    documentType: h.documentType,
    invoiceNumber: text(h.invoiceNumber), documentDate: text(h.documentDate), dueDate: text(h.dueDate),
    supplyDate: text(h.supplyDate), currency: text(h.currency)?.toUpperCase() ?? null,
    supplierNameStated: text(h.supplierNameStated), supplierAddress: text(h.supplierAddress),
    supplierVatNumber: text(h.supplierVatNumber)?.replace(/\s/g, '').toUpperCase() ?? null,
    supplierCountry: text(h.supplierCountry)?.toUpperCase() ?? null,
    customerNameStated: text(h.customerNameStated), customerAddress: text(h.customerAddress),
    customerVatNumber: text(h.customerVatNumber)?.replace(/\s/g, '').toUpperCase() ?? null,
    customerCountry: text(h.customerCountry)?.toUpperCase() ?? null,
    vatLegends: h.vatLegends.split('\n').map((s) => s.trim()).filter(Boolean),
    paymentTerms: text(h.paymentTerms), originalDocumentNumber: text(h.originalDocumentNumber),
    netMinor: amount(h.net, 'Net'), vatMinor: amount(h.vat, 'VAT'), grossMinor: amount(h.gross, 'Total'),
    lines: lines.map((l, i) => {
      const q = l.quantity.trim();
      if (q && !/^\d+(\.\d+)?$/.test(q)) {
        errors.push({ code: `parse_line_${i + 1}_qty`, severity: 'error', message: `Line ${i + 1}: quantity "${q}" is not a number.` });
      }
      return {
        description: l.description, quantity: q || null,
        unitPriceMinor: amount(l.unitPrice, `Line ${i + 1} unit price`), netMinor: amount(l.net, `Line ${i + 1} net`),
        vatRateBasisPoints: rate(l.rate, `Line ${i + 1} rate`), vatMinor: amount(l.vat, `Line ${i + 1} VAT`),
        grossMinor: amount(l.gross, `Line ${i + 1} total`),
      };
    }),
    vatTotals: totals.map((t, i) => ({
      rateBasisPoints: rate(t.rate, `VAT total ${i + 1} rate`), label: text(t.label),
      netMinor: amount(t.net, `VAT total ${i + 1} net`), vatMinor: amount(t.vat, `VAT total ${i + 1} VAT`),
    })),
  };
  return { values, parseErrors: errors };
}

export function DocumentReview(props: {
  documentId: string;
  filename: string;
  mimeType: string;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  reviewedBy: string | null;
  reviewNote: string | null;
  inUse: boolean;
  values: ReviewedDocumentValues;
  baseCurrency: string;
  /** Per-field confidence from the latest read, 0–100, for highlighting. */
  confidence: Record<string, number>;
  observations: string[];
  supplierId: string | null;
  customerId: string | null;
  supplierOptions: Option[];
  customerOptions: Option[];
}) {
  const router = useRouter();
  const initial = useMemo(() => toText(props.values, props.baseCurrency), [props.values, props.baseCurrency]);
  const [header, setHeader] = useState<HeaderText>(initial.header);
  const [lines, setLines] = useState<LineText[]>(initial.lines);
  const [totals, setTotals] = useState<VatTotalText[]>(initial.vatTotals);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [supplierChoice, setSupplierChoice] = useState<string>(props.supplierId ?? '__new');
  const [customerChoice, setCustomerChoice] = useState<string>(props.customerId ?? '__new');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const locked = props.reviewStatus !== 'unreviewed';

  // A fresh read (OCR, re-extraction) arrives as new props: start again from it.
  useEffect(() => {
    setHeader(initial.header); setLines(initial.lines); setTotals(initial.vatTotals); setAcknowledged(new Set());
  }, [initial]);

  const { values, parseErrors } = fromText(header, lines, totals);
  const checks = [...parseErrors, ...checkDocumentValues(values)];
  const errors = checks.filter((c) => c.severity === 'error');
  const warnings = checks.filter((c) => c.severity === 'warning');
  const unacknowledged = warnings.filter((w) => !acknowledged.has(w.code));
  const isSale = values.documentType === 'sales_invoice' || values.documentType === 'sales_record';

  const set = (key: keyof HeaderText) => (e: { target: { value: string } }) =>
    setHeader((h) => ({ ...h, [key]: e.target.value }));
  // A value was read, but with low confidence. Empty fields are handled by the checks.
  const low = (key: string) => {
    const c = props.confidence[key];
    return !locked && c !== undefined && c > 0 && c < 60;
  };

  const run = (fn: () => Promise<ActionResult>) => startTransition(async () => {
    const r = await fn();
    setResult(r);
    if (r.ok) router.refresh();
  });

  const confirm = () => run(() => confirmDocumentAction({
    documentId: props.documentId, values, acknowledgedCheckCodes: [...acknowledged],
    supplierId: supplierChoice && supplierChoice !== '__new' && supplierChoice !== '__none' ? supplierChoice : null,
    customerId: customerChoice && customerChoice !== '__new' && customerChoice !== '__none' ? customerChoice : null,
    createSupplier: !isSale && supplierChoice === '__new' && !!values.supplierNameStated,
    createCustomer: isSale && customerChoice === '__new' && !!values.customerNameStated,
    note: note.trim() || null,
  }));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4 items-start">
      <PageViewer
        documentId={props.documentId} mimeType={props.mimeType} filename={props.filename}
        canRead={!locked}
        onRecognised={(text) => run(() => readRecognisedTextAction(props.documentId, text))}
      />

      <div className="border border-line rounded bg-surface">
        <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-[13px]">
              {props.reviewStatus === 'confirmed' ? 'Confirmed' : props.reviewStatus === 'rejected' ? 'Rejected' : 'Check and confirm'}
            </div>
            <div className="text-[11.5px] text-ink-muted">
              {props.reviewStatus === 'unreviewed'
                ? 'Compare each value with the page. Correct anything wrong, fill in anything missing. Nothing uses this document until you confirm it.'
                : `By ${props.reviewedBy ?? 'unknown'}${props.reviewNote ? ` — ${props.reviewNote}` : ''}`}
            </div>
          </div>
        </div>

        {props.observations.length > 0 && !locked && (
          <ul className="px-4 py-2 bg-caution-soft border-b border-caution/30 text-[11.5px] text-caution space-y-0.5">
            {props.observations.map((o) => <li key={o}>{o}</li>)}
          </ul>
        )}

        <fieldset disabled={locked || pending} className="px-4 py-3 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Labelled label="Type">
              <Select value={header.documentType} onChange={set('documentType')}>
                {DOCUMENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Labelled>
            <Labelled label="Number" low={low('invoiceNumber')}><Input value={header.invoiceNumber} onChange={set('invoiceNumber')} /></Labelled>
            <Labelled label="Currency" low={low('currency')}><Input value={header.currency} onChange={set('currency')} placeholder="EUR" maxLength={3} /></Labelled>
            <Labelled label="Date" low={low('documentDate')}><Input type="date" value={header.documentDate} onChange={set('documentDate')} /></Labelled>
            <Labelled label="Date of supply"><Input type="date" value={header.supplyDate} onChange={set('supplyDate')} /></Labelled>
            <Labelled label="Due" low={low('dueDate')}><Input type="date" value={header.dueDate} onChange={set('dueDate')} /></Labelled>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Party title="Supplier (who issued it)" prefix="supplier" header={header} set={set} low={low}
              chooser={!isSale ? { value: supplierChoice, onChange: setSupplierChoice, options: props.supplierOptions } : undefined} />
            <Party title="Customer (who it was issued to)" prefix="customer" header={header} set={set} low={low}
              chooser={isSale ? { value: customerChoice, onChange: setCustomerChoice, options: props.customerOptions } : undefined} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-faint">Lines</span>
              <Button variant="ghost" onClick={() => setLines((ls) => [...ls, { description: '', quantity: '', unitPrice: '', net: '', rate: '', vat: '', gross: '' }])}>+ Add line</Button>
            </div>
            <table className="w-full text-[12px]">
              <thead className="text-ink-faint text-[10.5px] uppercase">
                <tr><th className="text-left">Description</th><th className="w-12">Qty</th><th className="w-20">Unit</th><th className="w-20">Net</th><th className="w-14">Rate %</th><th className="w-20">VAT</th><th className="w-20">Total</th><th className="w-6" /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const cell = (k: keyof LineText, cls = '') => (
                    <Input className={`!px-1 ${cls}`} value={l[k]} aria-label={`Line ${i + 1} ${k}`}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
                  );
                  return (
                    <tr key={i}>
                      <td>{cell('description')}</td><td>{cell('quantity', 'text-right')}</td><td>{cell('unitPrice', 'text-right')}</td>
                      <td>{cell('net', 'text-right')}</td><td>{cell('rate', 'text-right')}</td><td>{cell('vat', 'text-right')}</td>
                      <td>{cell('gross', 'text-right')}</td>
                      <td><Button variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</Button></td>
                    </tr>
                  );
                })}
                {lines.length === 0 && (
                  <tr><td colSpan={8} className="text-ink-muted py-1.5">No lines were read. Add each line from the document.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-faint">VAT analysis (per rate, as printed)</span>
              <Button variant="ghost" onClick={() => setTotals((ts) => [...ts, { rate: '', label: '', net: '', vat: '' }])}>+ Add rate</Button>
            </div>
            <table className="w-full text-[12px]">
              <tbody>
                {totals.map((t, i) => {
                  const cell = (k: keyof VatTotalText, ph: string) => (
                    <Input className="!px-1" placeholder={ph} value={t[k]} aria-label={`VAT total ${i + 1} ${k}`}
                      onChange={(e) => setTotals((ts) => ts.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
                  );
                  return (
                    <tr key={i}>
                      <td className="w-16">{cell('rate', 'Rate %')}</td><td>{cell('label', 'Label')}</td>
                      <td className="w-24">{cell('net', 'Net')}</td><td className="w-24">{cell('vat', 'VAT')}</td>
                      <td className="w-6"><Button variant="ghost" onClick={() => setTotals((ts) => ts.filter((_, j) => j !== i))}>×</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Labelled label="Net" low={low('netMinor')}><Input className="text-right" value={header.net} onChange={set('net')} /></Labelled>
            <Labelled label="VAT" low={low('vatMinor')}><Input className="text-right" value={header.vat} onChange={set('vat')} /></Labelled>
            <Labelled label="Total" low={low('grossMinor')}><Input className="text-right font-semibold" value={header.gross} onChange={set('gross')} /></Labelled>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Labelled label="VAT wording on the document (one per line)">
              <Textarea rows={2} value={header.vatLegends} onChange={set('vatLegends')} placeholder="e.g. Reverse charge — Article 196" />
            </Labelled>
            <div className="space-y-2">
              <Labelled label="Payment terms"><Input value={header.paymentTerms} onChange={set('paymentTerms')} /></Labelled>
              {values.documentType === 'credit_note' && (
                <Labelled label="Invoice this credits"><Input value={header.originalDocumentNumber} onChange={set('originalDocumentNumber')} /></Labelled>
              )}
            </div>
          </div>
        </fieldset>

        {!locked && (
          <div className="px-4 py-3 border-t border-line space-y-2">
            {checks.length === 0 ? (
              <p className="text-[12px] text-positive">The figures agree with each other.</p>
            ) : (
              <ul className="space-y-1">
                {errors.map((c) => (
                  <li key={c.code} className="text-[12px] text-negative">✕ {c.message}</li>
                ))}
                {warnings.map((c) => (
                  <li key={c.code} className="text-[12px] text-caution flex gap-2 items-start">
                    <input type="checkbox" className="mt-0.5" checked={acknowledged.has(c.code)}
                      onChange={(e) => setAcknowledged((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(c.code); else n.delete(c.code);
                        return n;
                      })} />
                    <span>{c.message} <span className="text-ink-faint">Tick if the document really says this.</span></span>
                  </li>
                ))}
              </ul>
            )}
            <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="primary" disabled={pending || errors.length > 0 || unacknowledged.length > 0} onClick={confirm}>
                {pending ? 'Saving…' : 'Confirm these details'}
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => {
                const reason = window.prompt('Why is this document being rejected? (e.g. not ours, duplicate, unreadable)');
                if (reason) run(() => rejectDocumentAction(props.documentId, reason));
              }}>Reject</Button>
            </div>
          </div>
        )}
        {locked && (
          <div className="px-4 py-3 border-t border-line flex items-center gap-2">
            <Button disabled={pending || props.inUse} onClick={() => {
              const reason = window.prompt('What needs correcting?');
              if (reason) run(() => reopenDocumentAction(props.documentId, reason));
            }}>Reopen to correct</Button>
            {props.inUse && <span className="text-[11.5px] text-ink-muted">Unlink it from its transaction or invoice first.</span>}
          </div>
        )}
        {result && (
          <div className={`px-4 py-2 border-t border-line text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>
            {result.ok ? result.message : result.error}
          </div>
        )}
      </div>
    </div>
  );
}

function Labelled({ label, low, children }: { label: string; low?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={`block text-[10.5px] uppercase tracking-wide font-semibold mb-0.5 ${low ? 'text-caution' : 'text-ink-faint'}`}>
        {label}{low && ' · check'}
      </span>
      {children}
    </label>
  );
}

function Party({ title, prefix, header, set, low, chooser }: {
  title: string;
  prefix: 'supplier' | 'customer';
  header: HeaderText;
  set: (key: keyof HeaderText) => (e: { target: { value: string } }) => void;
  low: (key: string) => boolean;
  chooser?: { value: string; onChange: (v: string) => void; options: Option[] };
}) {
  const k = (s: string) => `${prefix}${s}` as keyof HeaderText;
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-ink-faint">{title}</div>
      <Labelled label="Name as printed" low={low(`${prefix}Name`)}><Input value={header[k('NameStated')] as string} onChange={set(k('NameStated'))} /></Labelled>
      <Labelled label="Address"><Textarea rows={2} value={header[k('Address')] as string} onChange={set(k('Address'))} /></Labelled>
      <div className="grid grid-cols-[1fr_4rem] gap-1.5">
        <Labelled label="VAT number" low={low(`${prefix}VatNumber`)}><Input value={header[k('VatNumber')] as string} onChange={set(k('VatNumber'))} /></Labelled>
        <Labelled label="Country" low={low(`${prefix}Country`)}><Input value={header[k('Country')] as string} onChange={set(k('Country'))} maxLength={2} /></Labelled>
      </div>
      {chooser && (
        <Labelled label={`Record in the books as`}>
          <Select value={chooser.value} onChange={(e) => chooser.onChange(e.target.value)}>
            <option value="__new">A new {prefix} with the name above</option>
            {chooser.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Labelled>
      )}
    </div>
  );
}

/**
 * The page, at a size that fits beside the sheet, with zoom. PDFs are drawn
 * with PDF.js and images shown directly; either can be run through OCR on this
 * computer when it has no readable text.
 */
function PageViewer({ documentId, mimeType, filename, canRead, onRecognised }: {
  documentId: string; mimeType: string; filename: string; canRead: boolean;
  onRecognised: (text: string) => void;
}) {
  const url = `/api/documents/${documentId}/file`;
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const isPdf = mimeType === 'application/pdf';
  const isImage = /^image\/(png|jpeg|gif|webp|bmp)$/.test(mimeType);
  const isText = mimeType.startsWith('text/');

  useEffect(() => {
    let cancelled = false;
    if (isText) {
      fetch(url).then((r) => r.text()).then((t) => { if (!cancelled) setText(t); })
        .catch(() => { if (!cancelled) setStatus('The file could not be loaded.'); });
    }
    if (isPdf) {
      (async () => {
        try {
          installMapUpsertPolyfill();
          const pdfjs = await import('pdfjs-dist');
          pdfjs.GlobalWorkerOptions.workerSrc = '/api/ocr/pdf.worker.min.mjs';
          const pdf = await pdfjs.getDocument({ url }).promise;
          const host = pagesRef.current;
          if (!host || cancelled) return;
          host.replaceChildren();
          const count = Math.min(pdf.numPages, 10);
          for (let n = 1; n <= count; n++) {
            const page = await pdf.getPage(n);
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width; canvas.height = viewport.height;
            canvas.className = 'w-full mb-2 border border-line bg-white';
            host.appendChild(canvas);
            await page.render({ canvas, viewport }).promise;
          }
          if (pdf.numPages > count) setStatus(`Showing the first ${count} of ${pdf.numPages} pages.`);
        } catch (error) {
          if (!cancelled) {
            setStatus(`The PDF could not be drawn (${error instanceof Error ? error.message : String(error)}). `
              + 'Open it in a new tab to compare.');
          }
        }
      })();
    }
    return () => { cancelled = true; };
  }, [url, isPdf, isText]);

  const recognise = async () => {
    try {
      setStatus('Loading the text recogniser (runs on this computer)…');
      const { createWorker } = await import('tesseract.js');
      const base = `${window.location.origin}/api/ocr`;
      const worker = await createWorker('eng', 1, {
        workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => setStatus(`${m.status} ${Math.round(m.progress * 100)}%`),
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
      const sources: Array<HTMLCanvasElement | string> = isPdf
        ? Array.from(pagesRef.current?.querySelectorAll('canvas') ?? [])
        : [url];
      const parts: string[] = [];
      for (const source of sources) {
        const { data } = await worker.recognize(source);
        parts.push(data.text);
      }
      await worker.terminate();
      setStatus(null);
      onRecognised(parts.join('\n'));
    } catch (error) {
      setStatus(`Text recognition failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="border border-line rounded bg-surface sticky top-2">
      <div className="px-3 py-2 border-b border-line flex items-center gap-1.5 flex-wrap">
        <span className="text-[12px] font-medium truncate flex-1 min-w-0" title={filename}>{filename}</span>
        <Button variant="ghost" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out">−</Button>
        <span className="text-[11px] text-ink-muted w-10 text-center">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoom in">+</Button>
        <a href={url} target="_blank" rel="noreferrer" className="text-[12px] text-accent hover:underline">Open</a>
        {canRead && (isPdf || isImage) && (
          <Button onClick={recognise} title="Recognise the text in the page image on this computer, then read it again">
            Read text from the image (OCR)
          </Button>
        )}
      </div>
      {status && <div className="px-3 py-1.5 text-[11.5px] text-ink-muted border-b border-line">{status}</div>}
      <div className="max-h-[75vh] overflow-auto bg-surface-sunken p-2">
        <div style={{ width: `${zoom * 100}%` }}>
          {isImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={`Page image of ${filename}`} className="w-full border border-line bg-white" />
          )}
          {isPdf && <div ref={pagesRef} />}
          {isText && <pre className="text-[11.5px] whitespace-pre-wrap bg-white border border-line p-3">{text ?? 'Loading…'}</pre>}
          {!isImage && !isPdf && !isText && (
            <p className="text-[12px] text-ink-muted p-3">
              This file type cannot be shown here. Open it to compare, or convert it to PDF or an image.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
