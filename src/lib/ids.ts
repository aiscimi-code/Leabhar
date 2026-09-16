import { randomUUID } from 'node:crypto';

/**
 * Prefixed, sortable-ish identifiers. The prefix makes a foreign key readable
 * in a raw SQLite dump, which matters when the whole promise of the system is
 * that a person can trace where a number came from.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export const ids = {
  company: () => newId('co'),
  officer: () => newId('off'),
  bankAccount: () => newId('ba'),
  account: () => newId('acc'),
  taxRate: () => newId('rate'),
  vatTreatment: () => newId('vt'),
  accountingPeriod: () => newId('ap'),
  vatPeriod: () => newId('vp'),
  journalEntry: () => newId('je'),
  journalLine: () => newId('jl'),
  vatEntry: () => newId('ve'),
  bankTransaction: () => newId('btx'),
  statementImport: () => newId('imp'),
  importProfile: () => newId('prof'),
  document: () => newId('doc'),
  extraction: () => newId('ext'),
  match: () => newId('mat'),
  invoice: () => newId('inv'),
  invoiceLine: () => newId('il'),
  payment: () => newId('pay'),
  allocation: () => newId('alloc'),
  supplier: () => newId('sup'),
  customer: () => newId('cus'),
  rule: () => newId('rule'),
  fixedAsset: () => newId('fa'),
  depreciation: () => newId('dep'),
  reviewItem: () => newId('rev'),
  audit: () => newId('aud'),
  reconciliation: () => newId('rec'),
  fxRate: () => newId('fx'),
  backup: () => newId('bak'),
  user: () => newId('usr'),
  session: () => newId('ses'),
  shareCapital: () => newId('sc'),
  glossary: () => newId('gls'),
};
