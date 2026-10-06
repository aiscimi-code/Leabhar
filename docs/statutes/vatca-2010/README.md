# Value-Added Tax Consolidation Act 2010 (enacted)

The enacted text the knowledge base loads is now in the rules catalogue
(#556): `catalogue/vatca-2010/vatca-2010-enacted.json`, one provision per
section (all 125), with the Irish Statute Book PDF kept beside it
(`vatca-2010-enacted.pdf`, hash-checked by the gate). The Markdown extract and
the PDF that were here are removed. The entry is written by

```
npm run catalogue:extract -- vatca-2010/vatca-2010-enacted
```

which fetches the PDF, converts it with `scripts/convert-statute-pdf.ts`
(the marginal-note layout: each section's heading is re-attached above its
number) and parses it with `vatcaParser.ts`. The conversion stops at the
first `SCHEDULE` heading; the Schedules load from their LRC-revised entries.
It is the text as enacted: later Finance Act amendments are not reflected
(see `docs/RULES_KB.md`, "Limitations").

## Revised-text pointers

`s5-revised.md`, `s46-revised.md`, `s65-revised.md`, `s84-revised.md` are
short, curated summaries (not verbatim) of the *current, LRC-revised* text of
those four sections, sourced from
`https://revisedacts.lawreform.ie/eli/2010/act/31/section/{n}/revised/en/html`.
They exist because the enacted entry above is deliberately the
*2010-as-enacted* text — later amendments (e.g. S.I. 69/2025's changes to
ss. 5, 59, 60, 80 and the new ss. 92B-92D) are not reflected in it. Where the
two disagree, the revised pointer is the more current one, but neither
substitutes for reading the official page directly for anything
consequential. See [`docs/statutes/SOURCE-REGISTER.md`](../SOURCE-REGISTER.md)
(item 1.1) for the full register entry and known gaps (only 4 of the
originally-scoped 7 sections have a pointer file).
