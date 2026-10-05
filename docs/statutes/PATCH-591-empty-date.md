# Empty-date lookup hunk — #591

`transactionLookup.ts` on this branch still has `ctx.transactionDate || today()`.
Replace that block with the following. Do not change any other line of the file.

## Import

```ts
import { isIsoDate } from '../dates';
```

(drop `today` from that import.)

## `lookupTransactionRules` opener

Replace:

```ts
  const ctx = normaliseTransactionContext(params.transaction);
  const topics = identifyTopics(ctx);
  const asOf = ctx.transactionDate || today();
```

with:

```ts
  const ctx = normaliseTransactionContext(params.transaction);
  const topics = identifyTopics(ctx);
  // AGENTS.md #6 / #591: a missing date must not silently become today —
  // that would apply current rates to a transaction whose period is unknown.
  if (!isIsoDate(ctx.transactionDate ?? '')) {
    return {
      transactionContext: ctx,
      identifiedTopics: topics,
      candidateCount: 0,
      applicableRules: [],
      unresolvedFields: ['transactionDate'],
      possibleTreatment: { accounting: [], tax: [], vat: [], reporting: [] },
      reviewRequired: true,
      reviewReasons: [
        'transactionDate is not a valid ISO date; rules are not looked up against today. Supply YYYY-MM-DD.',
      ],
    };
  }
  const asOf = ctx.transactionDate;
```

The existing `#136` test already expects `/not a valid ISO date/` for `not-a-date`.
Add two cases: `transactionDate: ''` and `transactionDate: '18/09/2026'` both yield
`applicableRules === []` and `unresolvedFields` contains `transactionDate`.
