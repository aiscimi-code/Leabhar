# TCA 1997 — Revenue Notes for Guidance (Finance Act 2025 edition)

Revenue's section-by-section notes on the Taxes Consolidation Act 1997, as
amended to Finance Act 2025. There is no LRC revised TCA 1997 (see
`../tca-1997/README.md`), so these notes are the current consolidated
statement of each section's effect. They are Revenue guidance and rank below
the Act; every rule derived from them says so.

Each `partNN.pdf` is the file as downloaded; `partNN.md` is its pdftotext
conversion (`SOURCES.txt` has the URLs; `../_inbox/MANIFEST.sha256` the hashes).

- `src/domain/rules/tcaNfgParser.ts` cuts one section's note out of a part.
- `src/domain/rules/corporationTaxCuration.ts` lists the sections ingested
  (`NFG_SECTIONS`) and the rules quoted from them (issue #211).

Part 11 (ss.373–380, capital allowances and expenses for certain road
vehicles) was added on 2026-09-27, from the same Finance Act 2025 edition.
Its s.373(2) specified amounts restrict a motor car's wear and tear and
balancing adjustments (s.374); the computation applies them in
`src/domain/corporationTax/computation.ts` (issue #313). The Part's NfG sets
out cost limits only — it states no emissions-based limit, so none is
applied.
