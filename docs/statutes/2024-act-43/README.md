# 2024 Act 43 (enacted)

- Official PDF: https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/pdf
- Official HTML (print): https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/print

## Files

| File | What |
|---|---|
| `2024-act-43-enacted.pdf` | Official enacted PDF |
| `2024-act-43-enacted.md` | Poppler `pdftotext -layout` extract — the Irish rules KB's actual parser input (see [`docs/RULES_KB.md`](../../RULES_KB.md)) |
| `2024-act-43-part3-vat.md` | Official HTML → Markdown, Part 3 (VAT) only, ss. 77-88 |
| `SOURCE-REGISTER.md` | Register of binding sources 1.1-1.6 referenced from this folder |
| `audit-report.json` | What the rules KB has extracted so far, from a fresh ingest of both KB sources |

Also in this folder (HTML-derived reference extracts, register items 1.1,
1.3-1.6 — see `SOURCE-REGISTER.md` for scope and known gaps):

- `2010-act-31-s5.md`, `2010-act-31-s46.md`, `2010-act-31-s65.md`, `2010-act-31-s84.md`
- `2010-si-639.md`
- `2012-si-156.md`
- `1997-act-39-ss-885-887.md`
- `2025-si-69.md`

These are curated pointers/summaries, not verbatim statute text, and are
reference material only — they are not parsed by the deterministic KB
pipeline. See `SOURCE-REGISTER.md` for how they relate to the KB's own
verbatim ingestion of the full Finance Act 2024 and VATCA 2010 (the latter
at [`docs/statutes/vatca-2010/`](../vatca-2010/)).

This Act is ingested into the Irish rules knowledge base — see
[`docs/RULES_KB.md`](../../RULES_KB.md) for the architecture, and
[`audit-report.json`](audit-report.json) for what has (and has not) been
extracted from it so far.
