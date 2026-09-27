import type { documents } from '@/db/schema';

export type DocumentType = NonNullable<typeof documents.$inferInsert['documentType']>;

/**
 * The vault side of the document repository (issue #427).
 *
 * Leabhar reads transaction evidence — invoices, receipts, statements, credit
 * notes — and every one of those is a draft until a person confirms it. But a
 * book also holds documents that are not evidence of a supply at all: a
 * contract, a Revenue notice, a grant letter, a payslip, the incorporation
 * certificate. Nothing about them is extracted, matched or posted; they are
 * kept because the file itself is the record.
 *
 * These are the vault types. A person filing a document as one of them says
 * what it is — that declaration is the confirmation; there are no figures to
 * check against the page. The invoice reader is not run on them, and they
 * never enter the review queue.
 */
export const VAULT_DOCUMENT_TYPES = [
  'contract', 'tax_document', 'grant_document', 'payroll_document', 'company_document',
] as const satisfies readonly DocumentType[];

export type VaultDocumentType = (typeof VAULT_DOCUMENT_TYPES)[number];

export function isVaultDocumentType(type: string): type is VaultDocumentType {
  return (VAULT_DOCUMENT_TYPES as readonly string[]).includes(type);
}

export const VAULT_TYPE_LABELS: Record<VaultDocumentType, string> = {
  contract: 'Contract or agreement',
  tax_document: 'Revenue / tax document',
  grant_document: 'Grant letter or agreement',
  payroll_document: 'Payroll document',
  company_document: 'Company document',
};

/** Every type the repository can hold, for filters and pickers. */
export const ALL_DOCUMENT_TYPES: DocumentType[] = [
  'supplier_invoice', 'sales_invoice', 'receipt', 'credit_note', 'bank_statement',
  'sales_record', 'proforma', 'contract', 'tax_document', 'grant_document',
  'payroll_document', 'company_document', 'other', 'unknown',
];
