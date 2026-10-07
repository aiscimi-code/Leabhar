# Finance Act 2025 (No. 18 of 2025, enacted 23 December 2025)

- Official PDF: https://www.irishstatutebook.ie/eli/2025/act/18/enacted/en/pdf
- Official HTML (print): https://www.irishstatutebook.ie/eli/2025/act/18/enacted/en/print

The enacted text the knowledge base loads is now in the rules catalogue
(#556): `catalogue/finance-act-2025/2025-act-18-enacted.json`, one provision
per section (all 107), with the Irish Statute Book PDF kept beside it
(`2025-act-18-enacted.pdf`, hash-checked by the gate). The `pdftotext -layout`
extract and the PDF that were here are removed; the copies collected for
issue #218 remain in `docs/statutes/_inbox/A/` (SHA-256s in
`docs/statutes/_inbox/MANIFEST.sha256`). The entry is written by

```
npm run catalogue:extract -- finance-act-2025/2025-act-18-enacted
```

which fetches the PDF, lays it out with Poppler's `pdftotext -layout` and
parses it with `statuteParser.ts`. The excerpts keep that parser's known
defects, among them s.70's missing heading (#703).

The rules KB cites Part 3's VAT rate sections (issue #205):

- s.69: (caa) electricity and gas at 9% extended to 31 December 2030, from 8 October 2025;
- s.70: (cab) and (cac), apartments at 9%, and Sch.3 paras 9A and 9B;
- s.71: from 1 July 2026, (cb) becomes 9% for Sch.3 paras 3(1), 3(3) and 13(3) (food and drink,
  catering, hairdressing), with no end date.

The LRC revised s.46 now shows s.71 (retrieved 2026-10-06, footnote F106), and the rules catalogue entry (`catalogue/vatca-2010-revised/s046.json`) is that page since #688; the rules still date the new (cb) from s.71 (1 July 2026), not from the page.
