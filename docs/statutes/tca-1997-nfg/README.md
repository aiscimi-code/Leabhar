# TCA 1997 — Revenue Notes for Guidance (Finance Act 2025 edition)

Revenue's section-by-section notes on the Taxes Consolidation Act 1997, as
amended to Finance Act 2025. There is no LRC revised TCA 1997 (see
`../tca-1997/README.md`), so these notes are the current consolidated
statement of each section's effect. They are Revenue guidance and rank below
the Act; every rule derived from them says so.

The parts the rules read are rules catalogue entries
(`catalogue/tca-1997-nfg/partNN.json`, #556), each with Revenue's PDF beside
it; the excerpts are its `pdftotext -layout` conversion. The PDFs and their
Markdown conversions were kept here until the port. `SOURCES.txt` has the
URLs; the introduction, not read by any rule, stays here.

- `src/domain/rules/tcaNfgParser.ts` cuts one section's note out of a part.
- `src/domain/rules/corporationTaxCuration.ts` lists the sections ingested
  (`NFG_SECTIONS`) and the rules quoted from them (issue #211).

Part 11 (ss.373–380, capital allowances and expenses for certain road
vehicles) was added on 2026-09-27, from the same Finance Act 2025 edition.
Its s.373(2) specified amounts restrict a motor car's wear and tear and
balancing adjustments (s.374); the computation applies them in
`src/domain/corporationTax/computation.ts` (issue #313). This file covers
ss.373–380 only.

Part 11C (ss.380K–380P, the emissions-based limits for cars, inserted by Finance
Act 2008 s.31) was added on 2026-09-27, from the
same Finance Act 2025 edition (issue #466). Its notes set out the schemes for
expenditure from 2021 and from 2027. The 2008 scheme, for expenditure from July
2008 to 2020, is quoted from Revenue's TDM Part 11-00-01 (`../tdm-11-00-01/`).
The computation applies the scheme to a car whose CO2 emissions are recorded on
the fixed asset register; a car without them is flagged.
