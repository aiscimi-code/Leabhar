# Finance Act 2024 (No. 43 of 2024, enacted)

- Official PDF: https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/pdf
- Official HTML (print): https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/print

The enacted text the knowledge base loads is now in the rules catalogue
(#556): `catalogue/finance-act-2024/2024-act-43-enacted.json`, one provision
per section (all 118), with the Irish Statute Book PDF kept beside it
(`2024-act-43-enacted.pdf`, hash-checked by the gate). The `pdftotext -layout`
extract and the PDF that were here are removed. The entry is written by

```
npm run catalogue:extract -- finance-act-2024/2024-act-43-enacted
```

which fetches the PDF, lays it out with Poppler's `pdftotext -layout` and
parses it with `statuteParser.ts`. The excerpts keep that parser's known
defects (#703).

## Files

| File | What |
|---|---|
| `2024-act-43-part3-vat.md` | Official HTML → Markdown, Part 3 (VAT) only, ss. 77-88 — an independently-sourced cross-check of the same text, not the parser's input |

See [`docs/RULES_KB.md`](../../RULES_KB.md) for the architecture, and
[`../audit-report.json`](../audit-report.json) for an early snapshot of what
has (and has not) been extracted.

For the other binding VAT sources referenced alongside this Act (VATCA 2010,
the Regulations, TCA 1997, etc.), see [`docs/statutes/README.md`](../README.md)
and [`docs/statutes/SOURCE-REGISTER.md`](../SOURCE-REGISTER.md).
