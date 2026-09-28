/**
 * Cash flow forecast domain (epic #333, issues #565–#570).
 *
 * A forecast is a view beside the ledger — it never posts, never writes
 * journals, never changes an invoice or bank line.
 */

export * from './types';
export * from './engine';
export * from './taxOutflows';
export * from './payrollForecast';
export * from './recurringPatterns';
export * from './budget';
export * from './scenarios';
