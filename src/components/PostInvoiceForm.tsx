'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Select } from './primitives';
import { postDocumentAction, type ActionResult } from '@/app/actions';
import { parseAmount, type Minor } from '@/domain/money';

/**
 * Post a confirmed document as an invoice (issue #203).
 *
 * One row per line of the document, with the figures as confirmed. For each,
 * the person picks the account and the VAT treatment. Every treatment offered
 * shows why it is offered; one is pre-selected only when every source agrees,
 * and otherwise the row is flagged until the person chooses.
 */

export interface PostingLine {
  number: number;
  description: string;
  netMinor: number;
  vatMinor: number | null;
  rateBasisPoints: number | null;
  options: Array<{ treatmentId: string; code: string; name: string; reasons: string[]; ruleKeys: string[] }>;
  preselectedTreatmentId: string | null;
  accountId: string | null;
  accountReason: string | null;
  flags: string[];
  /** The s.60(2)(a) rule that blocks deducting this line's VAT (issue #616). */
  deductionBlocked: { ruleKey: string; ruleName: string; provision: string } | null;
}

/** The customs declaration's figures for one IMPORT_PA line, as typed (issue #629). */
interface ValuationText { customsValue: string; customsDuty: string; otherCharges: string; freight: string; mrn: string }
const NO_VALUATION: ValuationText = { customsValue: '', customsDuty: '', otherCharges: '', freight: '', mrn: '' };
const VALUATION_FIELDS: Array<[keyof Omit<ValuationText, 'mrn'>, string]> = [
  ['customsValue', 'Customs value (CIF)'], ['customsDuty', 'Customs duty'],
  ['otherCharges', 'Excise and other charges'], ['freight', 'Freight to Ireland'],
];

/** Nothing typed: the line posts on the invoice net and is flagged. Typed: every figure must parse and the customs value be set. */
function parseValuation(v: ValuationText, base: string) {
  if (Object.values(v).every((x) => x.trim() === '')) return { ok: true as const, valuation: undefined };
  const amount = (text: string): Minor | null => {
    if (text.trim() === '') return 0 as Minor;
    try { return parseAmount(text, base); } catch { return null; }
  };
  const customsValueMinor = amount(v.customsValue);
  const customsDutyMinor = amount(v.customsDuty);
  const otherChargesMinor = amount(v.otherCharges);
  const freightToIrelandMinor = amount(v.freight);
  if (customsValueMinor === null || customsDutyMinor === null || otherChargesMinor === null || freightToIrelandMinor === null
      || customsValueMinor <= 0 || customsDutyMinor < 0 || otherChargesMinor < 0 || freightToIrelandMinor < 0) {
    return { ok: false as const };
  }
  return {
    ok: true as const,
    valuation: {
      customsValueMinor, customsDutyMinor, otherChargesMinor, freightToIrelandMinor,
      ...(v.mrn.trim() ? { declarationReference: v.mrn.trim() } : {}),
    },
  };
}

const money = (minor: number | null, currency: string) =>
  minor === null ? '—' : `${(minor / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export function PostInvoiceForm({ documentId, direction, currency, baseCurrency, lines, accounts, treatments, missingParticulars = [] }: {
  documentId: string;
  /** What the purchase invoice lacks for its VAT to be deducted (issue #209). */
  missingParticulars?: string[];
  direction: 'sales' | 'purchase';
  currency: string;
  baseCurrency: string;
  lines: PostingLine[];
  accounts: Array<{ id: string; code: string; name: string; type: string }>;
  treatments: Array<{ id: string; code: string; name: string }>;
}) {
  const router = useRouter();
  const [accountIds, setAccountIds] = useState<Array<string>>(lines.map((l) => l.accountId ?? ''));
  const [treatmentIds, setTreatmentIds] = useState<Array<string>>(lines.map((l) => l.preselectedTreatmentId ?? ''));
  const [fx, setFx] = useState('');
  const [lateDate, setLateDate] = useState('');
  const [holdVat, setHoldVat] = useState(false);
  // A matched s.60(2)(a) block applies unless the person unticks it (a qualifying vehicle, stock-in-trade).
  const [blocked, setBlocked] = useState<boolean[]>(lines.map((l) => !!l.deductionBlocked));
  const [valuations, setValuations] = useState<ValuationText[]>(lines.map(() => NO_VALUATION));
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const foreign = currency !== baseCurrency;
  const relevantAccounts = accounts.filter((a) => (direction === 'sales'
    ? a.type === 'income' : ['expense', 'asset'].includes(a.type)));
  const codeOf = (treatmentId: string | undefined) => treatments.find((t) => t.id === treatmentId)?.code
    ?? lines.flatMap((l) => l.options).find((o) => o.treatmentId === treatmentId)?.code;
  const isImportPa = (i: number) => direction === 'purchase' && codeOf(treatmentIds[i]) === 'IMPORT_PA';
  const valuationsValid = lines.every((_, i) => !isImportPa(i) || parseValuation(valuations[i]!, baseCurrency).ok);
  const complete = valuationsValid && accountIds.every(Boolean) && treatmentIds.every(Boolean) && (!foreign || /^\d+(\.\d+)?$/.test(fx.trim()))
    && (missingParticulars.length === 0 || holdVat);

  const post = () => startTransition(async () => {
    let fxRate: { numerator: number; denominator: number; source: string } | undefined;
    if (foreign) {
      // "0.912345" base per unit of the document's currency, as an exact fraction.
      const [whole = '0', frac = ''] = fx.trim().split('.');
      const denominator = 10 ** frac.length;
      fxRate = { numerator: Number(whole) * denominator + Number(frac || '0'), denominator, source: 'user_supplied' };
    }
    const r = await postDocumentAction({
      documentId,
      coding: lines.map((l, i) => {
        const chosen = l.options.find((o) => o.treatmentId === treatmentIds[i]);
        return {
          accountId: accountIds[i]!, vatTreatmentId: treatmentIds[i]!, vatRuleKeys: chosen?.ruleKeys ?? [],
          blockedDeductionRuleKey: l.deductionBlocked && blocked[i] ? l.deductionBlocked.ruleKey : undefined,
          importValuation: isImportPa(i) ? parseValuation(valuations[i]!, baseCurrency).valuation : undefined,
        };
      }),
      fxRate,
      vatDeclarationDate: lateDate || undefined,
      holdVat: missingParticulars.length > 0 && holdVat,
    });
    setResult(r);
    if (r.ok) router.refresh();
  });

  return (
    <div className="px-4 py-3 space-y-3">
      {lines.map((line, i) => {
        const offered = new Set(line.options.map((o) => o.treatmentId));
        const unresolved = !treatmentIds[i];
        return (
          <div key={line.number} className={`border rounded p-3 ${unresolved ? 'border-caution/50 bg-caution-soft/30' : 'border-line'}`}>
            <div className="flex justify-between gap-3 text-[12.5px]">
              <span className="font-medium">{line.number}. {line.description}</span>
              <span className="num whitespace-nowrap">
                net {money(line.netMinor, currency)}
                {line.rateBasisPoints !== null && ` · ${line.rateBasisPoints / 100}%`}
                {' · VAT '}{money(line.vatMinor, currency)}
              </span>
            </div>
            {line.flags.map((f) => <p key={f} className="text-[11.5px] text-caution mt-1">{f}</p>)}

            <div className="mt-2 space-y-1.5">
              {line.options.map((o) => (
                <label key={o.treatmentId} className="flex gap-2 items-start text-[12px]">
                  <input type="radio" name={`t-${line.number}`} className="mt-0.5" checked={treatmentIds[i] === o.treatmentId}
                    onChange={() => setTreatmentIds((ts) => ts.map((t, j) => (j === i ? o.treatmentId : t)))} />
                  <span>
                    <strong>{o.name}</strong> <span className="text-ink-faint">({o.code})</span>
                    <ul className="text-ink-muted text-[11.5px] list-disc ml-4">
                      {o.reasons.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  </span>
                </label>
              ))}
              <div className="flex gap-2 items-center text-[12px]">
                <span className="text-ink-faint w-28 shrink-0">Other treatment</span>
                <Select value={offered.has(treatmentIds[i]!) ? '' : treatmentIds[i]}
                  onChange={(e) => setTreatmentIds((ts) => ts.map((t, j) => (j === i ? e.target.value : t)))}>
                  <option value="">—</option>
                  {treatments.filter((t) => !offered.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}
                </Select>
              </div>
              <div className="flex gap-2 items-center text-[12px]">
                <span className="text-ink-faint w-28 shrink-0">Account</span>
                <Select value={accountIds[i]} onChange={(e) => setAccountIds((as) => as.map((a, j) => (j === i ? e.target.value : a)))}>
                  <option value="">Choose…</option>
                  {relevantAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </Select>
              </div>
              {line.deductionBlocked && (
                <label className="flex gap-2 items-start text-[12px]">
                  <input type="checkbox" className="mt-0.5" checked={blocked[i]}
                    onChange={(e) => setBlocked((bs) => bs.map((b, j) => (j === i ? e.target.checked : b)))} />
                  <span>
                    VAT not deductible: {line.deductionBlocked.ruleName} ({line.deductionBlocked.provision}).
                    <span className="text-ink-muted"> The treatment above still applies, and a reverse charge is still
                      accounted for; only the T2 claim is withheld. Untick for an exception the provision allows.</span>
                  </span>
                </label>
              )}
              {isImportPa(i) && (
                <div className="text-[12px] border border-line rounded p-2 space-y-1.5">
                  <p className="font-medium">Customs declaration, in {baseCurrency}</p>
                  <p className="text-ink-muted text-[11.5px]">Import VAT is charged on the customs value plus duty, other charges and
                    freight to Ireland, and PA1 reports the customs value plus duty: both from the declaration, not this
                    invoice. Leave these blank to post on the invoice net; the line is then flagged for review.</p>
                  <div className="grid grid-cols-2 gap-2">
                    {VALUATION_FIELDS.map(([key, label]) => (
                      <label key={key} className="flex flex-col gap-0.5">
                        <span className="text-ink-faint">{label}</span>
                        <Input inputMode="decimal" value={valuations[i]![key]}
                          onChange={(e) => setValuations((vs) => vs.map((v, j) => (j === i ? { ...v, [key]: e.target.value } : v)))} />
                      </label>
                    ))}
                    <label className="flex flex-col gap-0.5 col-span-2">
                      <span className="text-ink-faint">Declaration reference (MRN)</span>
                      <Input value={valuations[i]!.mrn}
                        onChange={(e) => setValuations((vs) => vs.map((v, j) => (j === i ? { ...v, mrn: e.target.value } : v)))} />
                    </label>
                  </div>
                  {!parseValuation(valuations[i]!, baseCurrency).ok && (
                    <p className="text-negative text-[11.5px]">Enter the customs value and whole amounts of {baseCurrency}, or clear them all.</p>
                  )}
                </div>
              )}
              {line.accountReason && accountIds[i] === line.accountId && (
                <p className="text-[11px] text-ink-faint ml-[7.5rem]">{line.accountReason}</p>
              )}
            </div>
          </div>
        );
      })}

      {foreign && (
        <div className="flex gap-2 items-center text-[12px]">
          <span className="text-ink-faint">{baseCurrency} per 1 {currency}</span>
          <Input className="!w-32" placeholder="e.g. 0.9123" value={fx} onChange={(e) => setFx(e.target.value)} />
          <span className="text-ink-faint">The rate on the invoice date. It is recorded as you enter it.</span>
        </div>
      )}

      <details className="text-[12px]">
        <summary className="cursor-pointer text-ink-muted">The VAT return for this invoice&apos;s date is locked or filed?</summary>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <Input type="date" className="!w-44" value={lateDate} onChange={(e) => setLateDate(e.target.value)} />
          <span className="text-ink-faint">Declare its VAT in the open VAT period covering this date. A filed return is
            never changed; this is recorded and flagged for your accountant.</span>
        </div>
      </details>

      {missingParticulars.length > 0 && (
        <div className="border border-caution/50 bg-caution-soft/30 rounded p-3 text-[12px]">
          <p className="font-medium text-caution">This invoice does not show:</p>
          <ul className="list-disc ml-5 text-ink-muted">{missingParticulars.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="text-ink-muted mt-1">Input VAT is deducted only on an invoice with these particulars (VATCA s.59(2)(a),
            S.I. 639/2010 reg.20(2)). Reopen the document to add them from the page, or post it with the VAT held back.</p>
          <label className="flex items-center gap-2 mt-2">
            <input type="checkbox" checked={holdVat} onChange={(e) => setHoldVat(e.target.checked)} />
            Post with the VAT held back from recovery until a valid invoice is obtained
          </label>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={pending || !complete} onClick={post}>
          {pending ? 'Posting…' : `Post as ${direction === 'sales' ? 'sales' : 'purchase'} invoice`}
        </Button>
        {!complete && <span className="text-[11.5px] text-ink-muted">Choose a treatment and an account for every line.</span>}
      </div>
      {result && (
        <p className={`text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>{result.ok ? result.message : result.error}</p>
      )}
    </div>
  );
}
