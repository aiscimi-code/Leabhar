---
title: "Source register — binding Irish VAT texts (1.1–1.6)"
source_type: leabhar_implementation_rule
jurisdiction: IE
---

# Binding sources referenced here

Official HTML converted to Markdown (`official-html-plaintext`), not PDF
extracts. **These files are curated pointers/summaries, not verbatim
statute text** — several explicitly say "see official text for the full
list" rather than quoting every sub-paragraph. They are reference material
for a human or an LLM-assisted lookup, not input to the deterministic
`irish_tax_rules` pipeline (see `docs/RULES_KB.md`): that pipeline requires
`provisionText` to be a verbatim, offset-traceable slice of the source
document, which a paraphrase cannot satisfy.

| ID | File | Citation | Official source |
|---|---|---|---|
| 1.1 | `2010-act-31-s5.md`, `2010-act-31-s46.md`, `2010-act-31-s65.md`, `2010-act-31-s84.md` | VATCA 2010 (No. 31) ss. 5, 46, 65, 84 revised | https://revisedacts.lawreform.ie/eli/2010/act/31/front/revised/en/html |
| 1.2 | `2024-act-43-part3-vat.md` | Finance Act 2024 (No. 43), Part 3 (VAT, ss. 77-88) | https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/print |
| 1.3 | `2010-si-639.md` | VAT Regulations 2010 (S.I. 639/2010) | https://www.irishstatutebook.ie/eli/2010/si/639/made/en/print |
| 1.4 | `2025-si-69.md` | European Union (Value-Added Tax) Regulations 2025 (S.I. 69/2025) | https://www.irishstatutebook.ie/eli/2025/si/69/made/en/html |
| 1.5 | `1997-act-39-ss-885-887.md` | TCA 1997 ss. 885-887 (as enacted) | https://www.irishstatutebook.ie/eli/1997/act/39/section/886/enacted/en/html |
| 1.6 | `2012-si-156.md` | Mandatory e-filing Regulations 2012 (S.I. 156/2012) | https://www.irishstatutebook.ie/eli/2012/si/156/made/en/html |

**Known gaps against the original 1.1/1.2 plan**, left as-is rather than
silently claimed complete: 1.1 was scoped to cover VATCA ss. 2, 5, 46, 59,
65, 66 and 84 but only ss. 5, 46, 65 and 84 were ever produced — ss. 2, 59
and 66 have no file here (VATCA s.59 is, however, fully ingested verbatim
into the deterministic KB — see below). 1.2 was scoped to a full official
HTML conversion of the whole Act (`2024-act-43-from-html.md`) plus the
Part 3 VAT extract; only the Part 3 extract was produced.

## Relationship to the deterministic knowledge base

The Irish rules KB (`docs/RULES_KB.md`) ingests the **full verbatim text**
of two sources by a different route — a reviewed PDF-to-Markdown converter,
not this HTML register:

- Finance Act 2024 — `2024-act-43-enacted.md` (below)
- VATCA 2010, all 125 sections — `docs/statutes/vatca-2010/vatca-2010-enacted.md`

Where a file in this register overlaps a KB-ingested section (VATCA ss. 5,
46, 65, 84; Finance Act 2024 Part 3), the KB's own copy is the verbatim,
offset-traceable one and is authoritative for rule extraction. This
register's value is the sources the KB does *not* ingest at all yet
(SI 639/2010, SI 156/2012, SI 69/2025, TCA 1997 ss.885-887) and the pointers
to revised/current text (the KB's VATCA text is the 2010-as-enacted
wording; SI 69/2025 in particular documents specific amendments — s.2, 5,
6, 59, 60, 80 and new ss.92B-92D — made since).

Existing in this folder (pre-ingest):

- `2024-act-43-enacted.pdf` — official eISB PDF
- `2024-act-43-enacted.md` — Poppler `pdftotext -layout` extract; the KB's
  actual Finance Act 2024 parser input (see `docs/RULES_KB.md`)
- `audit-report.json` — current KB extract snapshot

Notes:

- TCA ss.885-887 here are **as enacted**. Later Finance Act amendments are
  not consolidated in the eISB section pages.
- Conversion flattens eISB/LRC chrome; front matter records
  `source_html_sha256` where computed.
