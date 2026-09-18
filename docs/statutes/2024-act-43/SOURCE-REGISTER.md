---
title: "Source register — binding Irish VAT texts (1.1–1.6)"
source_type: leabhar_implementation_rule
jurisdiction: IE
---

# Binding sources ingested here

Official HTML converted to Markdown (`official-html-plaintext`). Not PDF extracts.

| ID | File | Citation | Official source |
|---|---|---|---|
| 1.1 | `2010-act-31-key-sections.md` | VATCA 2010 (No. 31) ss. 2, 5, 46, 59, 65, 66, 84 revised | https://revisedacts.lawreform.ie/eli/2010/act/31/front/revised/en/html |
| 1.2 | `2024-act-43-from-html.md` + `2024-act-43-part3-vat.md` | Finance Act 2024 (No. 43) | https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/print |
| 1.3 | `2010-si-639.md` | VAT Regulations 2010 (S.I. 639/2010) | https://www.irishstatutebook.ie/eli/2010/si/639/made/en/print |
| 1.4 | `2025-si-69.md` | European Union (Value-Added Tax) Regulations 2025 (S.I. 69/2025) | https://www.irishstatutebook.ie/eli/2025/si/69/made/en/html |
| 1.5 | `1997-act-39-ss-885-887.md` | TCA 1997 ss. 885–887 (as enacted) | https://www.irishstatutebook.ie/eli/1997/act/39/section/886/enacted/en/html |
| 1.6 | `2012-si-156.md` | Mandatory e-filing Regulations 2012 (S.I. 156/2012) | https://www.irishstatutebook.ie/eli/2012/si/156/made/en/html |

Existing in this folder (pre-ingest):

- `2024-act-43-enacted.pdf` — official eISB PDF
- `2024-act-43-enacted.md` — Poppler `pdftotext -layout` (kept; do not use as parser source if HTML MD is present)
- `audit-report.json` — current KB extract from the PDF MD

Notes:

- Full revised VATCA is not in this folder (too large). Key SME/VAT-agent sections only.
- TCA ss.885–887 here are **as enacted**. Later Finance Act amendments are not consolidated in the eISB section pages.
- Conversion flattens eISB/LRC chrome; front matter records `source_html_sha256`.
