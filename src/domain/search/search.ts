import { and, eq, sql, or, like, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, documents, suppliers, customers, invoices, accounts,
  vatEntries, rules, journalEntries, fixedAssets, vatTreatments,
} from '@/db/schema';
import { parseAmount, MoneyError } from '../money';
import { normaliseDescription } from '../banking/fingerprint';

/**
 * Global search (README §36).
 *
 * Searching "Anthropic" should find the supplier, its invoices, its bank
 * transactions, the accounting entries and the rules that mention it — not just
 * one of those. So this searches every entity type and returns a single ranked
 * list, with each result carrying enough context to be acted on without
 * opening it.
 *
 * An all-digits query is also tried as an amount, because "42.17" is a
 * perfectly reasonable thing to search for when reconciling and a text search
 * would never find it.
 */

export type SearchEntityType =
  | 'bank_transaction' | 'document' | 'supplier' | 'customer'
  | 'invoice' | 'account' | 'rule' | 'journal_entry' | 'fixed_asset' | 'vat_treatment';

export interface SearchResult {
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle: string;
  /** Why this matched, so a surprising result explains itself. */
  matchedOn: string;
  href: string;
  date?: string;
  amountMinor?: number;
  currency?: string;
  /** Higher sorts first. */
  score: number;
}

export interface SearchResponse {
  query: string;
  interpretedAsAmount: number | null;
  results: SearchResult[];
  countsByType: Record<string, number>;
  truncated: boolean;
}

const PER_TYPE_LIMIT = 25;

export function search(
  db: AppDatabase,
  params: { companyId: string; query: string; limit?: number },
): SearchResponse {
  const raw = params.query.trim();
  if (raw.length < 2) {
    return {
      query: raw, interpretedAsAmount: null, results: [],
      countsByType: {}, truncated: false,
    };
  }

  const needle = `%${raw.toLowerCase()}%`;
  const results: SearchResult[] = [];

  // An amount query, if it parses as one. Both signs are searched because a
  // user reconciling will type the figure from the statement without its sign.
  const amountMinor = tryParseAmount(raw);

  // ---- Suppliers and customers ----
  for (const supplier of db.select().from(suppliers)
    .where(and(
      eq(suppliers.companyId, params.companyId),
      or(
        sql`LOWER(${suppliers.name}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${suppliers.vatNumber}, '')) LIKE ${needle}`,
        sql`LOWER(${suppliers.matchKey}) LIKE ${needle}`,
      ),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'supplier',
      id: supplier.id,
      title: supplier.name,
      subtitle: [supplier.countryCode, supplier.vatNumber].filter(Boolean).join(' · ')
        || 'Supplier',
      matchedOn: supplier.vatNumber && supplier.vatNumber.toLowerCase().includes(raw.toLowerCase())
        ? 'VAT number' : 'Supplier name',
      href: `/suppliers/${supplier.id}`,
      score: 100,
    });
  }

  for (const customer of db.select().from(customers)
    .where(and(
      eq(customers.companyId, params.companyId),
      or(
        sql`LOWER(${customers.name}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${customers.vatNumber}, '')) LIKE ${needle}`,
      ),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'customer',
      id: customer.id,
      title: customer.name,
      subtitle: [customer.countryCode, customer.vatNumber].filter(Boolean).join(' · ')
        || 'Customer',
      matchedOn: 'Customer name',
      href: '/customers',
      score: 100,
    });
  }

  // ---- Bank transactions ----
  const transactionConditions = [
    sql`LOWER(${bankTransactions.description}) LIKE ${needle}`,
    sql`LOWER(COALESCE(${bankTransactions.bankReference}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${bankTransactions.counterpartyName}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${bankTransactions.counterpartyIban}, '')) LIKE ${needle}`,
  ];
  if (amountMinor !== null) {
    transactionConditions.push(sql`${bankTransactions.amountMinor} IN (${amountMinor}, ${-amountMinor})`);
  }

  for (const transaction of db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, params.companyId), or(...transactionConditions)))
    .orderBy(desc(bankTransactions.transactionDate))
    .limit(PER_TYPE_LIMIT).all()) {
    const byAmount = amountMinor !== null
      && Math.abs(transaction.amountMinor) === Math.abs(amountMinor);
    results.push({
      type: 'bank_transaction',
      id: transaction.id,
      title: transaction.description,
      subtitle: `${transaction.transactionDate} · ${transaction.status}`,
      matchedOn: byAmount ? 'Amount'
        : transaction.bankReference?.toLowerCase().includes(raw.toLowerCase())
          ? 'Bank reference' : 'Description',
      href: `/transactions/${transaction.id}`,
      date: transaction.transactionDate,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      score: byAmount ? 95 : 90,
    });
  }

  // ---- Documents ----
  const documentConditions = [
    sql`LOWER(${documents.originalFilename}) LIKE ${needle}`,
    sql`LOWER(COALESCE(${documents.invoiceNumber}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${documents.notes}, '')) LIKE ${needle}`,
  ];
  if (amountMinor !== null) {
    documentConditions.push(sql`${documents.grossMinor} IN (${amountMinor}, ${-amountMinor})`);
  }

  for (const document of db.select().from(documents)
    .where(and(
      eq(documents.companyId, params.companyId),
      eq(documents.archived, false),
      or(...documentConditions),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'document',
      id: document.id,
      title: document.originalFilename,
      subtitle: [document.invoiceNumber, document.documentDate, document.matchStatus]
        .filter(Boolean).join(' · '),
      matchedOn: document.invoiceNumber?.toLowerCase().includes(raw.toLowerCase())
        ? 'Invoice number' : 'Filename',
      href: `/documents/${document.id}`,
      date: document.documentDate ?? undefined,
      amountMinor: document.grossMinor ?? undefined,
      currency: document.currency ?? undefined,
      score: 85,
    });
  }

  // ---- Invoices ----
  // Invoices are searched by the counterparty's name as well as their own
  // fields. README §36's example is searching a supplier name and expecting
  // their invoices back, and an invoice rarely repeats the supplier's name in
  // any column of its own.
  const invoiceConditions = [
    sql`LOWER(COALESCE(${invoices.invoiceNumber}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${invoices.reference}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${invoices.notes}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${suppliers.name}, '')) LIKE ${needle}`,
    sql`LOWER(COALESCE(${customers.name}, '')) LIKE ${needle}`,
  ];
  if (amountMinor !== null) {
    invoiceConditions.push(sql`${invoices.grossMinor} IN (${amountMinor}, ${-amountMinor})`);
  }

  for (const row of db.select({
    invoice: invoices, supplierName: suppliers.name, customerName: customers.name,
  })
    .from(invoices)
    .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(eq(invoices.companyId, params.companyId), or(...invoiceConditions)))
    .limit(PER_TYPE_LIMIT).all()) {
    const { invoice } = row;
    const partyName = row.supplierName ?? row.customerName;
    const matchedOnParty = partyName?.toLowerCase().includes(raw.toLowerCase()) ?? false;
    results.push({
      type: 'invoice',
      id: invoice.id,
      title: `${invoice.direction === 'sales' ? 'Sales' : 'Purchase'} invoice `
        + `${invoice.invoiceNumber ?? ''}`.trim(),
      subtitle: [partyName, invoice.invoiceDate, invoice.status].filter(Boolean).join(' · '),
      matchedOn: matchedOnParty
        ? (invoice.direction === 'sales' ? 'Customer' : 'Supplier')
        : 'Invoice number',
      href: `/invoices/${invoice.id}`,
      date: invoice.invoiceDate,
      amountMinor: invoice.grossMinor,
      currency: invoice.currency,
      score: 88,
    });
  }

  // ---- Accounts ----
  for (const account of db.select().from(accounts)
    .where(and(
      eq(accounts.companyId, params.companyId),
      or(
        sql`LOWER(${accounts.name}) LIKE ${needle}`,
        sql`LOWER(${accounts.code}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${accounts.description}, '')) LIKE ${needle}`,
      ),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'account',
      id: account.id,
      title: `${account.code} ${account.name}`,
      subtitle: `${account.type}${account.active ? '' : ' · inactive'}`,
      matchedOn: account.code.toLowerCase().includes(raw.toLowerCase())
        ? 'Account code' : 'Account name',
      href: `/reports/account/${account.id}`,
      score: 70,
    });
  }

  // ---- Journal entries ----
  for (const entry of db.select().from(journalEntries)
    .where(and(
      eq(journalEntries.companyId, params.companyId),
      or(
        sql`LOWER(${journalEntries.narrative}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${journalEntries.notes}, '')) LIKE ${needle}`,
      ),
    )).orderBy(desc(journalEntries.entryDate)).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'journal_entry',
      id: entry.id,
      title: `Entry #${entry.entryNumber}: ${entry.narrative}`,
      subtitle: `${entry.entryDate} · ${entry.entryType}`,
      matchedOn: 'Narrative',
      href: entry.sourceType === 'bank_transaction' && entry.sourceId
        ? `/transactions/${entry.sourceId}` : '/audit',
      date: entry.entryDate,
      score: 60,
    });
  }

  // ---- Rules ----
  for (const rule of db.select().from(rules)
    .where(and(
      eq(rules.companyId, params.companyId),
      or(
        sql`LOWER(${rules.name}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${rules.description}, '')) LIKE ${needle}`,
        sql`LOWER(CAST(${rules.conditions} AS TEXT)) LIKE ${needle}`,
      ),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'rule',
      id: rule.id,
      title: rule.name,
      subtitle: rule.enabled ? 'Enabled' : 'Disabled',
      matchedOn: rule.name.toLowerCase().includes(raw.toLowerCase())
        ? 'Rule name' : 'Rule conditions',
      href: '/rules',
      score: 65,
    });
  }

  // ---- Fixed assets ----
  for (const asset of db.select().from(fixedAssets)
    .where(and(
      eq(fixedAssets.companyId, params.companyId),
      or(
        sql`LOWER(${fixedAssets.name}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${fixedAssets.description}, '')) LIKE ${needle}`,
      ),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'fixed_asset',
      id: asset.id,
      title: asset.name,
      subtitle: `${asset.purchaseDate} · ${asset.status}`,
      matchedOn: 'Asset name',
      href: '/assets',
      date: asset.purchaseDate,
      amountMinor: asset.baseCostMinor,
      currency: asset.baseCurrency,
      score: 70,
    });
  }

  // ---- VAT treatments ----
  for (const treatment of db.select().from(vatTreatments)
    .where(and(
      eq(vatTreatments.companyId, params.companyId),
      or(
        sql`LOWER(${vatTreatments.name}) LIKE ${needle}`,
        sql`LOWER(${vatTreatments.code}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${vatTreatments.description}, '')) LIKE ${needle}`,
      ),
    )).limit(PER_TYPE_LIMIT).all()) {
    results.push({
      type: 'vat_treatment',
      id: treatment.id,
      title: treatment.name,
      subtitle: `${treatment.code} · ${treatment.jurisdiction}`,
      matchedOn: 'VAT treatment',
      href: '/settings/rates',
      score: 55,
    });
  }

  // Exact title matches float to the top, then by score, then by recency.
  const lowered = raw.toLowerCase();
  results.sort((a, b) => {
    const exactA = a.title.toLowerCase() === lowered ? 1 : 0;
    const exactB = b.title.toLowerCase() === lowered ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;
    if (a.score !== b.score) return b.score - a.score;
    return (b.date ?? '').localeCompare(a.date ?? '');
  });

  const countsByType: Record<string, number> = {};
  for (const result of results) {
    countsByType[result.type] = (countsByType[result.type] ?? 0) + 1;
  }

  const limit = params.limit ?? 100;
  return {
    query: raw,
    interpretedAsAmount: amountMinor,
    results: results.slice(0, limit),
    countsByType,
    truncated: results.length > limit,
  };
}

/**
 * Try to read the query as a money amount.
 *
 * Only attempted when the query looks numeric, so searching for a supplier
 * called "100" does not silently become an amount search — and the response
 * says when it was interpreted this way, so the user can see why a result
 * appeared.
 */
function tryParseAmount(query: string): number | null {
  const cleaned = query.replace(/[€£$\s]/g, '');
  if (!/^-?\d[\d.,]*$/.test(cleaned)) return null;
  try {
    const parsed = parseAmount(cleaned, 'EUR');
    return parsed === 0 ? null : Math.abs(parsed);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    return null;
  }
}
