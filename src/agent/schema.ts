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
  file: z.string(),
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
