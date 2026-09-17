import { z } from 'zod';

/**
 * Input schemas for the CLI commands.
 *
 * Each command validates its arguments with one of these before any domain
 * function is called, so a bad flag produces a clean error message rather than
 * a stack trace from inside the accounting engine.
 */

export const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  'Dates must be ISO format: YYYY-MM-DD',
);

export const listAccountsInput = z.object({
  companyId: z.string(),
});

export const listReconciliationsInput = z.object({
  companyId: z.string(),
});

export const importInput = z.object({
  companyId: z.string(),
  accountId: z.string(),
  file: z.string(),
});

export const autoClassifyInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string(),
});

export const reconcileInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string(),
  from: isoDate,
  to: isoDate,
  signOff: z.boolean().default(false),
  acceptDifference: z.string().optional(),
  statementClosingBalance: z
    .union([z.number(), z.string().transform((v) => Number(v))])
    .optional(),
});

export const runPipelineInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string(),
  file: z.string().optional(),
  from: isoDate,
  to: isoDate,
  statementClosingBalance: z
    .union([z.number(), z.string().transform((v) => Number(v))])
    .optional(),
  signOff: z.boolean().default(false),
  acceptDifference: z.string().optional(),
});

export type ListAccountsInput = z.infer<typeof listAccountsInput>;
export type ListReconciliationsInput = z.infer<typeof listReconciliationsInput>;
export type ImportInput = z.infer<typeof importInput>;
export type AutoClassifyInput = z.infer<typeof autoClassifyInput>;
export type ReconcileInput = z.infer<typeof reconcileInput>;
export type RunPipelineInput = z.infer<typeof runPipelineInput>;

export const matchInput = z.object({
  companyId: z.string(),
});

export const listMatchesInput = z.object({
  companyId: z.string(),
  decision: z.string().optional(),
});

export const acceptMatchInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  bankTransactionId: z.string(),
  reason: z.string().optional(),
});

export const linkInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  bankTransactionId: z.string(),
  reason: z.string().optional(),
});

export const rejectMatchInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  bankTransactionId: z.string(),
  reason: z.string().optional(),
});

export const unmatchInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  reason: z.string(),
});

export const createSupplierInput = z.object({
  companyId: z.string(),
  name: z.string(),
  countryCode: z.string().optional(),
  vatNumber: z.string().optional(),
  documentId: z.string().optional(),
});

export type MatchInput = z.infer<typeof matchInput>;
export type ListMatchesInput = z.infer<typeof listMatchesInput>;
export type AcceptMatchInput = z.infer<typeof acceptMatchInput>;
export type LinkInput = z.infer<typeof linkInput>;
export type RejectMatchInput = z.infer<typeof rejectMatchInput>;
export type UnmatchInput = z.infer<typeof unmatchInput>;
export type CreateSupplierInput = z.infer<typeof createSupplierInput>;

export const classifyTxnInput = z.object({
  companyId: z.string(),
  bankTransactionId: z.string(),
  accountId: z.string(),
  vatTreatmentId: z.string(),
  supplierId: z.string().optional(),
  fxRateNumerator: z.number().optional(),
  fxRateDenominator: z.number().optional(),
  notes: z.string().optional(),
});

export const createRuleCliInput = z.object({
  companyId: z.string(),
  name: z.string(),
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.string(),
    value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()]),
  })),
  actions: z.array(z.object({
    field: z.string(),
    value: z.union([z.string(), z.null()]),
  })),
  autoApply: z.boolean().optional(),
  priority: z.number().optional(),
});

export const setFxInput = z.object({
  companyId: z.string(),
  bankTransactionId: z.string(),
  baseAmount: z.union([z.number(), z.string().transform((v) => Number(v))]).optional(),
  fxRateNumerator: z.union([z.number(), z.string().transform((v) => Number(v))]).optional(),
  fxRateDenominator: z.union([z.number(), z.string().transform((v) => Number(v))]).optional(),
});

export type ClassifyTxnInput = z.infer<typeof classifyTxnInput>;
export type CreateRuleCliInput = z.infer<typeof createRuleCliInput>;
export type SetFxInput = z.infer<typeof setFxInput>;
