import { and, eq, gte, lte, sql, isNull, ne, or } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  vatPeriods, vatEntries, bankTransactions, documents, reviewItems,
  auditEvents, vatTreatments, invoices, companies,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { buildVat3Return } from './report';
import { cashBasisFindings } from './cashBasis';
import { capitalGoodsFindings } from './capitalGoods';
import { apportionmentFindings } from './apportionment';

/**
 * VAT period close (README §24).
 *
 * The governing instruction is that the system should say NOT READY rather than
 * let the user assume the return is correct — and that it must never claim a
 * filing is legally compliant merely because internal checks passed. Both are
 * enforced here: the verdict wording is fixed in code, and there is no code
 * path that produces the word "compliant".
 */

export type CheckSeverity = 'blocking' | 'warning' | 'info';

export interface ValidationFinding {
  code: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
  count: number;
  entityType: string;
  entityIds: string[];
}

export interface PeriodValidation {
  vatPeriodId: string;
  periodName: string;
  ready: boolean;
  /** Fixed wording. Never says "compliant". */
  verdict: 'Internal checks passed' | 'NOT READY';
  summary: string;
  findings: ValidationFinding[];
  blockingCount: number;
  warningCount: number;
  checkedAt: string;
  disclaimer: string;
}

const DISCLAIMER =
  'These are this application’s own internal consistency checks. They are not a '
  + 'statement that your VAT return is correct or that you are compliant with Revenue '
  + 'requirements. Review the figures and the supporting documents before filing.';

/**
 * Run every validation for a VAT period.
 *
 * Each check returns the entity ids behind its finding so the review queue can
 * link straight to the thing that needs fixing, per README §20's objective that
 * the user spends time only on exceptions.
 */
export function validateVatPeriod(
  db: AppDatabase,
  params: { companyId: string; vatPeriodId: string },
): PeriodValidation {
  const period = db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.id, params.vatPeriodId),
      eq(vatPeriods.companyId, params.companyId),
    )).get();
  if (!period) throw new Error(`VAT period ${params.vatPeriodId} not found.`);

  const findings: ValidationFinding[] = [];
  const { companyId } = params;
  const inPeriod = and(
    eq(bankTransactions.companyId, companyId),
    gte(bankTransactions.transactionDate, period.startDate),
    lte(bankTransactions.transactionDate, period.endDate),
  );

  // ---- Unclassified transactions ----
  const unclassified = db.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(and(inPeriod, eq(bankTransactions.status, 'unclassified'))).all();
  if (unclassified.length > 0) {
    findings.push({
      code: 'unclassified_transactions',
      severity: 'blocking',
      title: `${unclassified.length} unclassified transaction${plural(unclassified.length)}`,
      detail: 'These transactions have no accounting treatment, so their VAT is not '
        + 'included in this return. Classify them before marking the period ready.',
      count: unclassified.length,
      entityType: 'bank_transaction',
      entityIds: unclassified.map((r) => r.id),
    });
  }

  // ---- Unmatched transactions (no supporting document) ----
  const unmatched = db.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(and(
      inPeriod,
      or(eq(bankTransactions.status, 'classified'), eq(bankTransactions.status, 'posted')),
      sql`NOT EXISTS (SELECT 1 FROM ${documents} d WHERE d.matched_transaction_id = ${bankTransactions.id})`,
    )).all();
  if (unmatched.length > 0) {
    findings.push({
      code: 'missing_documents',
      severity: 'warning',
      title: `${unmatched.length} transaction${plural(unmatched.length)} without a document`,
      detail: 'VAT reclaimed without a supporting invoice can be disallowed on audit. '
        + 'Attach the invoice or receipt, or record why one does not exist.',
      count: unmatched.length,
      entityType: 'bank_transaction',
      entityIds: unmatched.map((r) => r.id),
    });
  }

  // ---- Suspected duplicates ----
  const duplicates = db.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(and(
      inPeriod,
      sql`${bankTransactions.isDuplicateOf} IS NOT NULL`,
      eq(bankTransactions.duplicateConfirmed, false),
    )).all();
  if (duplicates.length > 0) {
    findings.push({
      code: 'suspected_duplicates',
      severity: 'blocking',
      title: `${duplicates.length} suspected duplicate${plural(duplicates.length)}`,
      detail: 'A duplicated purchase would reclaim the same VAT twice. Confirm or '
        + 'dismiss each one.',
      count: duplicates.length,
      entityType: 'bank_transaction',
      entityIds: duplicates.map((r) => r.id),
    });
  }

  // ---- Unresolved AI suggestions ----
  const aiPending = db.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(and(
      inPeriod,
      eq(bankTransactions.source, 'ai'),
      eq(bankTransactions.provenanceStatus, 'ai_suggestion'),
    )).all();
  if (aiPending.length > 0) {
    findings.push({
      code: 'unresolved_ai_suggestions',
      severity: 'blocking',
      title: `${aiPending.length} unconfirmed AI suggestion${plural(aiPending.length)}`,
      detail: 'These classifications were suggested automatically and have not been '
        + 'confirmed by you. A VAT return should rest on decisions you have made.',
      count: aiPending.length,
      entityType: 'bank_transaction',
      entityIds: aiPending.map((r) => r.id),
    });
  }

  const periodEntries = db.select().from(vatEntries)
    .where(and(
      eq(vatEntries.companyId, companyId),
      eq(vatEntries.vatPeriodId, params.vatPeriodId),
    )).all();

  // ---- Arithmetically impossible VAT ----
  const impossible = periodEntries.filter((e) => {
    if (e.netMinor + e.vatMinor !== e.grossMinor && e.grossMinor !== e.netMinor) return true;
    // VAT with the opposite sign to its net amount cannot be right.
    if (e.netMinor > 0 && e.vatMinor < 0) return true;
    if (e.netMinor < 0 && e.vatMinor > 0) return true;
    return Math.abs(e.recoverableVatMinor) > Math.abs(e.vatMinor);
  });
  if (impossible.length > 0) {
    findings.push({
      code: 'impossible_vat',
      severity: 'blocking',
      title: `${impossible.length} VAT entr${impossible.length === 1 ? 'y' : 'ies'} that cannot be right`,
      detail: 'Net plus VAT does not equal gross, the VAT has the opposite sign to the '
        + 'net, or more VAT is being reclaimed than was charged.',
      count: impossible.length,
      entityType: 'vat_entry',
      entityIds: impossible.map((e) => e.id),
    });
  }

  // ---- Missing counterparty VAT numbers where the treatment requires one ----
  const requiringVatNumber = db.select({ id: vatTreatments.id, name: vatTreatments.name })
    .from(vatTreatments)
    .where(and(
      eq(vatTreatments.companyId, companyId),
      eq(vatTreatments.requiresCounterpartyVatNumber, true),
    )).all();
  const requiredIds = new Set(requiringVatNumber.map((t) => t.id));
  const missingVatNumbers = periodEntries.filter(
    (e) => requiredIds.has(e.vatTreatmentId)
      && (!e.counterpartyVatNumber || e.counterpartyVatNumber.trim() === ''),
  );
  if (missingVatNumbers.length > 0) {
    findings.push({
      code: 'missing_counterparty_vat_number',
      severity: 'warning',
      title: `${missingVatNumbers.length} entr${missingVatNumbers.length === 1 ? 'y' : 'ies'} missing a counterparty VAT number`,
      detail: 'The VAT treatment applied to these transactions depends on the other '
        + 'party being VAT-registered in their member state. Record their VAT number, '
        + 'or reconsider the treatment.',
      count: missingVatNumbers.length,
      entityType: 'vat_entry',
      entityIds: missingVatNumbers.map((e) => e.id),
    });
  }

  // ---- Entries whose tax point falls outside the period they are assigned to ----
  const outside = periodEntries.filter(
    (e) => e.taxPointDate < period.startDate || e.taxPointDate > period.endDate,
  );
  if (outside.length > 0) {
    findings.push({
      code: 'entries_outside_period',
      severity: 'blocking',
      title: `${outside.length} entr${outside.length === 1 ? 'y' : 'ies'} dated outside this period`,
      detail: `These entries are assigned to ${period.name} but their tax point falls `
        + 'outside it. Reassign them to the period their tax point belongs to.',
      count: outside.length,
      entityType: 'vat_entry',
      entityIds: outside.map((e) => e.id),
    });
  }

  // ---- Transactions in the period with no VAT period assigned at all ----
  const orphaned = db.select({ id: vatEntries.id }).from(vatEntries)
    .where(and(
      eq(vatEntries.companyId, companyId),
      isNull(vatEntries.vatPeriodId),
      gte(vatEntries.taxPointDate, period.startDate),
      lte(vatEntries.taxPointDate, period.endDate),
    )).all();
  if (orphaned.length > 0) {
    findings.push({
      code: 'unassigned_vat_entries',
      severity: 'blocking',
      title: `${orphaned.length} VAT entr${orphaned.length === 1 ? 'y' : 'ies'} not assigned to any period`,
      detail: 'These entries fall inside this period’s dates but are not assigned '
        + 'to it, so they would be omitted from the return.',
      count: orphaned.length,
      entityType: 'vat_entry',
      entityIds: orphaned.map((e) => e.id),
    });
  }

  // ---- Currency discrepancies: a foreign entry with no conversion ----
  const baseCurrency = db.select({ c: companies.baseCurrency }).from(companies)
    .where(eq(companies.id, companyId)).get()?.c ?? 'EUR';
  const unconverted = periodEntries.filter(
    (e) => e.currency !== baseCurrency && e.baseNetMinor === e.netMinor && e.netMinor !== 0,
  );
  if (unconverted.length > 0) {
    findings.push({
      code: 'currency_discrepancy',
      severity: 'warning',
      title: `${unconverted.length} foreign-currency entr${unconverted.length === 1 ? 'y' : 'ies'} may not be converted`,
      detail: `The ${baseCurrency} amount equals the foreign amount, which suggests an `
        + 'exchange rate of exactly 1.0 was applied. Check the rate used.',
      count: unconverted.length,
      entityType: 'vat_entry',
      entityIds: unconverted.map((e) => e.id),
    });
  }

  // ---- A repayment position is worth a deliberate look ----
  const report = buildVat3Return(db, { companyId, vatPeriodId: params.vatPeriodId });
  if (report.netPositionMinor < 0) {
    findings.push({
      code: 'repayment_position',
      severity: 'info',
      title: 'This period is in a repayment position',
      detail: 'You reclaimed more VAT than you charged. Repayment claims are more '
        + 'likely to be queried, so it is worth checking the larger purchases.',
      count: 1,
      entityType: 'vat_period',
      entityIds: [period.id],
    });
  }

  if (report.entryCount === 0) {
    findings.push({
      code: 'no_entries',
      severity: 'warning',
      title: 'This period contains no VAT entries',
      detail: 'A nil return may be correct, but confirm that transactions for this '
        + 'period have been imported and classified.',
      count: 0,
      entityType: 'vat_period',
      entityIds: [period.id],
    });
  }

  // ---- The cash receipts basis is authorised and its s.80(1) test still met (issue #208) ----
  for (const f of cashBasisFindings(db, { companyId, periodStart: period.startDate, periodEnd: period.endDate })) {
    findings.push({ ...f, severity: 'warning', count: 1, entityType: 'company', entityIds: [companyId] });
  }

  // ---- Capital goods scheme: intervals due and adjustments for this period (issue #208) ----
  for (const f of capitalGoodsFindings(db, { companyId, periodStart: period.startDate, periodEnd: period.endDate })) {
    findings.push({ ...f, severity: 'warning', count: f.entityIds.length, entityType: 'capital_good' });
  }

  // ---- Dual-use inputs of a company making exempt and taxable supplies (s.61, issue #209) ----
  for (const f of apportionmentFindings(db, { companyId, periodEnd: period.endDate })) {
    findings.push({ ...f, severity: 'warning', count: 1, entityType: 'company', entityIds: [companyId] });
  }

  const blockingCount = findings.filter((f) => f.severity === 'blocking').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const ready = blockingCount === 0;

  return {
    vatPeriodId: period.id,
    periodName: period.name,
    ready,
    verdict: ready ? 'Internal checks passed' : 'NOT READY',
    summary: ready
      ? warningCount > 0
        ? `Internal checks passed with ${warningCount} warning${plural(warningCount)} to review.`
        : 'Internal checks passed.'
      : `${blockingCount} issue${plural(blockingCount)} must be resolved before this period `
        + 'can be marked ready.',
    findings,
    blockingCount,
    warningCount,
    checkedAt: nowIso(),
    disclaimer: DISCLAIMER,
  };
}

function plural(n: number): string { return n === 1 ? '' : 's'; }

/** Write validation findings into the review queue (README §20). */
export function syncFindingsToReviewQueue(
  db: AppDatabase,
  params: { companyId: string; vatPeriodId: string; validation: PeriodValidation },
): void {
  db.transaction((tx) => {
    // Supersede previous findings for this period so resolved items disappear.
    tx.update(reviewItems)
      .set({ status: 'superseded' })
      .where(and(
        eq(reviewItems.companyId, params.companyId),
        eq(reviewItems.kind, 'period_validation'),
        eq(reviewItems.vatPeriodId, params.vatPeriodId),
        eq(reviewItems.status, 'open'),
      )).run();

    for (const finding of params.validation.findings) {
      if (finding.severity === 'info') continue;
      tx.insert(reviewItems).values({
        id: ids.reviewItem(),
        companyId: params.companyId,
        kind: 'period_validation',
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        entityType: finding.entityType,
        entityId: finding.entityIds[0] ?? params.vatPeriodId,
        context: { code: finding.code, entityIds: finding.entityIds, count: finding.count },
        vatPeriodId: params.vatPeriodId,
        dedupeKey: `vat_period:${params.vatPeriodId}:${finding.code}`,
        status: 'open',
      }).run();
    }
  });
}

export type VatPeriodStatus = 'open' | 'review' | 'ready' | 'locked' | 'submitted';

const ALLOWED_TRANSITIONS: Record<VatPeriodStatus, VatPeriodStatus[]> = {
  open: ['review'],
  review: ['open', 'ready'],
  ready: ['review', 'locked'],
  locked: ['ready', 'submitted'],
  submitted: [],
};

/**
 * Move a VAT period through its lifecycle (README §24).
 *
 * `ready` is gated on validation: the period cannot be marked ready while a
 * blocking finding stands. Every transition is audited with its reason.
 */
export function transitionVatPeriod(
  db: AppDatabase,
  params: {
    companyId: string;
    vatPeriodId: string;
    to: VatPeriodStatus;
    reason?: string;
    actor?: string;
    submissionReference?: string;
  },
): { status: VatPeriodStatus; validation?: PeriodValidation } {
  const period = db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.id, params.vatPeriodId),
      eq(vatPeriods.companyId, params.companyId),
    )).get();
  if (!period) throw new Error(`VAT period ${params.vatPeriodId} not found.`);

  const from = period.status as VatPeriodStatus;
  if (from === params.to) return { status: from };

  if (!ALLOWED_TRANSITIONS[from].includes(params.to)) {
    throw new Error(
      `A VAT period cannot go from "${from}" to "${params.to}". `
        + `Allowed from "${from}": ${ALLOWED_TRANSITIONS[from].join(', ') || 'nothing'}.`,
    );
  }

  let validation: PeriodValidation | undefined;
  if (params.to === 'ready') {
    validation = validateVatPeriod(db, {
      companyId: params.companyId, vatPeriodId: params.vatPeriodId,
    });
    syncFindingsToReviewQueue(db, {
      companyId: params.companyId, vatPeriodId: params.vatPeriodId, validation,
    });
    if (!validation.ready) {
      throw new Error(
        `NOT READY: ${validation.summary} `
          + validation.findings
            .filter((f) => f.severity === 'blocking')
            .map((f) => f.title)
            .join('; '),
      );
    }
  }

  const timestamp = nowIso();
  const update: Partial<typeof vatPeriods.$inferInsert> = { status: params.to };

  if (params.to === 'locked') {
    update.lockedAt = timestamp;
    update.lockReason = params.reason ?? null;
  }
  if (params.to === 'submitted') {
    // Snapshot the figures as filed, so later edits are visibly later edits.
    const report = buildVat3Return(db, {
      companyId: params.companyId, vatPeriodId: params.vatPeriodId,
    });
    update.submittedAt = timestamp;
    update.submissionReference = params.submissionReference ?? null;
    update.filedT1Minor = report.T1.amountMinor;
    update.filedT2Minor = report.T2.amountMinor;
    update.filedT3Minor = report.T3.amountMinor;
    update.filedT4Minor = report.T4.amountMinor;
  }

  db.transaction((tx) => {
    tx.update(vatPeriods).set(update).where(eq(vatPeriods.id, params.vatPeriodId)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'vat_period',
      entityId: params.vatPeriodId,
      action: params.to === 'locked' ? 'period_locked'
        : params.to === 'open' || params.to === 'review' ? 'period_unlocked'
        : 'updated',
      field: 'status',
      previousValue: from,
      newValue: params.to,
      source: 'user',
      actor: params.actor ?? 'user',
      reason: params.reason ?? null,
    }).run();
  });

  return { status: params.to, validation };
}
