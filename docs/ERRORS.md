# Error-handling conventions

Written down in issue #296. The typed errors already existed
(`src/domain/accounting/errors.ts` and the per-module subclasses); this page
is the convention they follow. New code that disagrees with this page is a
bug in the new code.

## The principle

AGENTS.md #7: **nothing is silently repaired.** An error is either thrown
with enough specificity that a person can act on it, or it becomes a review
item. There is no third option, and there is no catch-and-guess.

## Domain layer: throw typed, specific errors

1. **Every failure mode a user can plausibly cause gets its own class.**
   The base is `AccountingError`
   (`src/domain/accounting/errors.ts`), which sets
   `this.name = new.target.name` so the subclass name survives
   transpilation, and carries an optional `detail` record for structured
   context. A module that has user-facing failure modes defines its subclass
   next to the code that throws it (`InvoicingError`,
   `ClassificationError`, `ConfigurationError`, …).

   ```ts
   export class UnbalancedJournalError extends AccountingError {}
   ```

   Plain `Error` is reserved for defects ("this cannot happen") and for
   low-level modules with no accounting semantics (`MoneyError`,
   `DateError`). If a caller might need to distinguish it, it gets a class.

2. **The message says what is wrong and what to do.**
   `'Choose both an account and a VAT treatment.'` — not `'invalid input'`,
   not `'ERR_402'`. The person reading it is an accountant, not a developer.

3. **Check before writing, not after.** Posting paths call
   `assertAccountingPeriodOpen` for every date they will touch *before* any
   write, and every VAT write calls `assertVatPeriodWritable` first, so a
   multi-step path fails at step zero instead of half-posted. A path that
   posts more than one thing runs inside `atomically()`
   (`src/domain/accounting/journal.ts`), so a late throw leaves nothing
   behind.

4. **Detected problems become review items, not repairs.** When the system
   *finds* something wrong rather than *rejecting* an action (a mismatch, a
   missing document, an anomaly), it writes a review-queue row
   (`src/domain/review/anomalies.ts`,
   `src/domain/documents/review.ts`) and stops. It never fixes data on the
   user's behalf, and never falls back to a guess.

5. **Empty results are not errors.** A query with no matches returns an
   empty list; only a *state that cannot proceed* throws. Missing
   configuration that a write depends on (an FX rate, an account) is an
   exception, never an assumed value.

## Action layer: catch at the boundary

Server actions (`src/app/actions.ts`) wrap domain calls in `try/catch` and
return `{ ok: false, error: message }` (see `docs/API.md`). They never throw
to the client and never add their own error taxonomy — the message the domain
wrote is the message the user sees. Validation of form-shaped mistakes
(missing fields, malformed numbers) happens in the action, before the domain
is called, with an instructive message.

## CLI/agent layer: exit codes, same errors

`src/cli/` and `src/agent/` catch the same typed errors and print the
message plus context (the transaction id, the document id) to stderr, then
exit non-zero. They do not translate the message, and they do not continue
past a failure that left the books untouched only because `atomically()`
held.

## What this forbids

- `catch (e) {}` or `catch { /* ignore */ }` anywhere. If a call can fail, the
  failure is handled or surfaced; if it truly cannot, say why in a comment.
  The accepted pattern is a catch that names the case it expects, where that
  case is not an error. The three in the code today are:
  - `src/domain/extraction/anthropicProvider.ts`: falls through to sending the
    document itself;
  - `src/domain/consolidation/suggest.ts`: no rate is configured on that date,
    so no suggestion is made;
  - `src/domain/backup/backup.ts`: a database without WAL needs no checkpoint.
- Turning a domain error into a generic `500` string at an intermediate
  layer. Conversion to a user message happens once, at the boundary.
- String matching on error messages (`if (e.message.includes('locked'))`).
  The class is the contract; if two failure modes need different handling,
  they get different classes.
- Logging as a substitute for handling. A swallowed-then-logged invariant
  violation is still swallowed.
