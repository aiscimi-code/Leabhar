# Companies Act 2014 — filing basics

Statutory books, company-size thresholds, and financial-statement filing
obligations — separate from VATCA's own record-keeping duty (VATCA s.84):
a company needs both. `companies-act-2014.md` is a hand-written, paraphrase-
only summary covering s.282 (adequate accounting records), s.280A
(small-company thresholds), s.280D/280E (micro-company regime), s.352
(abridged filing), and ss.358-360 (audit exemption) — it carries no source
hash and backs no curated rule.

**Verbatim capture (issue #135):** `s282.md`, `s280A.md`, `s280D.md`,
`s280E.md`, `s352.md`, `s358.md`, `s359.md`, `s360.md` are the same eight
sections fetched from the LRC-revised Act, each with a real
`source_html_sha256`, via `extract_companies_act_2014()` in
`docs/statutes/scripts/extract_vat_sources.py` — the same per-section LRC
fetch shape `docs/statutes/vatca-2010-revised/` uses. These, not the
paraphrase above, back the size-threshold and filing/audit-exemption rules
curated in `src/domain/rules/companiesAct2014Curation.ts` — see
`docs/RULES_KB.md`'s "Companies Act 2014 size thresholds" section.
