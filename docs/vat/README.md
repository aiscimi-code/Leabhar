# Irish VAT source extracts

Extracts for source-register items 1, 3, 5 and 9 (see
[`docs/statutes/2024-act-43/SOURCE-REGISTER.md`](../statutes/2024-act-43/SOURCE-REGISTER.md)
for the full 1.1-1.6 register). **Only item 9 is complete** — the table
below states what actually exists in this folder today, not the original
plan.

| Item | Path | Source | Status |
|---|---|---|---|
| 1 | (not present here) | LRC revised VATCA 2010 | Instead: four individual revised sections at `docs/statutes/2024-act-43/2010-act-31-s{5,46,65,84}.md`, and the full *as-enacted* 2010 text ingested verbatim at [`docs/statutes/vatca-2010/`](../statutes/vatca-2010/). |
| 3 | (not present here) | eISB print HTML of S.I. 639/2010 | Instead: an extract at `docs/statutes/2024-act-43/2010-si-639.md`. |
| 5 | `tdm-38-01-03b/38-01-03b-p19-36.md` | Revenue TDM Part 38-01-03b (54 pages) | Partial (pages 19-36 only) and paraphrased/summarised, not verbatim. Pages 1-18 and 37-54 are missing. |
| 9 | `vat-rates/current-vat-rates.md` | Revenue current rates table, retrieved 2026-09-18 | Complete. |

`scripts/extract_vat_sources.py` can (re)produce items 1, 3, 5 and 9 given
network access to `revisedacts.lawreform.ie`, `irishstatutebook.ie` and
`revenue.ie` — see `.github/workflows/extract-vat-docs.yml`, a
`workflow_dispatch` job that runs it on a GitHub-hosted runner (which has
that access; local sandboxes used for this KB's other work do not) and
pushes the result. It has not yet been re-run to fill items 1, 3, and the
rest of item 5.

Binding texts (1, 3) would outrank TDM and the rates table (5, 9) once
present — none of this is wired into the deterministic `irish_tax_rules`
pipeline (see `docs/RULES_KB.md`); it is reference material, and item 5 in
particular is paraphrase, not verbatim source text.
