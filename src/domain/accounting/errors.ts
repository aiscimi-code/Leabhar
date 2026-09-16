/**
 * Accounting errors are deliberately specific. README §44 requires that the
 * system shows the problem and requires a deliberate action rather than
 * silently repairing financial data, so every failure mode that a user could
 * plausibly cause has its own type and its own message.
 */
export class AccountingError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnbalancedJournalError extends AccountingError {}
export class ImmutableEntryError extends AccountingError {}
export class PeriodLockedError extends AccountingError {}
export class NoPeriodError extends AccountingError {}
export class InvalidLineError extends AccountingError {}
export class MissingAccountError extends AccountingError {}
export class MissingFxRateError extends AccountingError {}
export class CurrencyMismatchError extends AccountingError {}
