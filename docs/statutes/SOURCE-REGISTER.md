---
title: "Source register — binding Irish VAT texts (1.1-1.6) plus reference items 5 and 9"
source_type: leabhar_implementation_rule
jurisdiction: IE
---

# Binding sources referenced here

Official HTML converted to Markdown (`official-html-plaintext`), not PDF
extracts. **Most of these files are curated pointers/summaries, not verbatim
statute text** — several explicitly say "see official text for the full
list" rather than quoting every sub-paragraph. They are reference material
for a human or an LLM-assisted lookup, not input to the deterministic
`irish_tax_rules` pipeline (see `docs/RULES_KB.md`): that pipeline requires
`provisionText` to be a verbatim, offset-traceable slice of the source
document, which a paraphrase cannot satisfy. See
[`docs/statutes/README.md`](README.md) for how this folder is laid out.

| ID | Path | Citation | Official source | Status |
|---|---|---|---|---|
| 1.1 | `vatca-2010/s5-revised.md`, `s46-revised.md`, `s65-revised.md`, `s84-revised.md` | VATCA 2010 (No. 31) ss. 5, 46, 65, 84 revised | https://revisedacts.lawreform.ie/eli/2010/act/31/front/revised/en/html | Partial: scoped to ss. 2, 5, 46, 59, 65, 66, 84; only these 4 exist. VATCA s.59 is separately fully ingested verbatim (as-enacted) into the deterministic KB. |
| 1.2 | `finance-act-2024/2024-act-43-part3-vat.md` | Finance Act 2024 (No. 43), Part 3 (VAT, ss. 77-88) | https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/print | Cross-check extract only; the KB's actual parser input is the full-Act `2024-act-43-enacted.md` in the same folder, not this. |
| 1.3 | `si-639-2010/2010-si-639.md` | VAT Regulations 2010 (S.I. 639/2010) | https://www.irishstatutebook.ie/eli/2010/si/639/made/en/print | Partial: regs 20 and 27 only (invoice contents, accounts). |
| 1.4 | `si-69-2025/2025-si-69.md` | European Union (Value-Added Tax) Regulations 2025 (S.I. 69/2025) | https://www.irishstatutebook.ie/eli/2025/si/69/made/en/html | Summary of all substantive amendments (ss. 2, 5, 6, 59, 60, 80, new ss. 92B-92D). |
| 1.5 | `tca-1997/1997-act-39-ss-885-887.md` | TCA 1997 ss. 885-887 (as enacted) | https://www.irishstatutebook.ie/eli/1997/act/39/section/886/enacted/en/html | Complete for these 3 sections. See `tca-1997/` for the broader (separate, Tier 2) transaction-classification effort. |
| 1.6 | `si-156-2012/2012-si-156.md` | Mandatory e-filing Regulations 2012 (S.I. 156/2012) | https://www.irishstatutebook.ie/eli/2012/si/156/made/en/html | Complete. |
| 5 | `tdm-38-01-03b/38-01-03b-p19-36.md` | Revenue TDM Part 38-01-03b — Guidelines for VAT Registration | https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-38/38-01-03b.pdf | Partial: pages 19-36 of 54, paraphrased. |
| 9 | `vat-rates/current-vat-rates.md` | Revenue current VAT rates table | https://www.revenue.ie/en/vat/vat-rates/search-vat-rates/current-vat-rates.aspx | Complete (2020-2026), retrieved 2026-09-18. |

`scripts/extract_vat_sources.py` (and the `workflow_dispatch` GH Actions job
`.github/workflows/extract-vat-docs.yml` that runs it on a network-unrestricted
runner) can fill the "Partial" gaps above — the full VATCA revised corpus
lands under `vatca-2010-revised/` when run, not `vatca-2010/` (which stays
reserved for the as-enacted text and its 4 hand-picked revised pointers).

## Relationship to the deterministic knowledge base

The Irish rules KB (`docs/RULES_KB.md`) ingests the **full verbatim text**
of two sources by a different route — a reviewed PDF-to-Markdown converter,
not this HTML register:

- Finance Act 2024 — `finance-act-2024/2024-act-43-enacted.md`
- VATCA 2010, all 125 sections — `vatca-2010/vatca-2010-enacted.md`

Where a file in this register overlaps a KB-ingested section (VATCA ss. 5,
46, 65, 84; Finance Act 2024 Part 3), the KB's own copy is the verbatim,
offset-traceable one and is authoritative for rule extraction. This
register's value is the sources the KB does *not* ingest at all yet
(SI 639/2010, SI 156/2012, SI 69/2025, TCA 1997) and the pointers to
revised/current text (the KB's VATCA text is the 2010-as-enacted wording;
SI 69/2025 in particular documents specific amendments made since).

Notes:

- TCA ss.885-887 here are **as enacted**. Later Finance Act amendments are
  not consolidated in the eISB section pages. The same applies to any TCA
  1997 section without a "revised" LRC page at all — none exists for TCA
  1997 (unlike VATCA 2010); a section inserted by a later Finance Act (e.g.
  s.600F, s.835DA) must be read from that Finance Act directly, not from
  `/eli/1997/act/39/section/…`, which 404s for it.
- Conversion flattens eISB/LRC chrome; front matter records
  `source_html_sha256` where computed.
