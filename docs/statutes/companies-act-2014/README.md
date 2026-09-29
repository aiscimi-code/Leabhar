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

**Accounting records, statutory financial statements and the annual return
(issue #559 / #214):** `s281.md`, `s283.md`–`s286.md`, `s290.md`–`s293.md`,
`s343.md` and `s347.md` join the set, fetched the same way. No HTML original
is committed (#293); each file's front matter holds the LRC URL and
`source_html_sha256`. The curated rules are the s.281 duty to keep adequate
records, the s.282 adequacy test, where and how they are kept and inspected
(ss.283–284), the s.285 six-year retention (also #557), the s.290 duty to
prepare entity financial statements and the s.291 Companies Act form of
those statements, the s.293 group-statements duty, the s.343 56-day annual
return, and the s.347 annexes. s.286 (offences) and s.292 (IFRS entity
statements) are ingested for citability and marked `not_applicable` in the
coverage matrix.

**Company size and formats (issue #554):** `s280B.md` (small groups),
`s280C.md` (the small companies regime) and `s280F.md` (medium companies)
join the set, fetched the same way. The turnover and balance sheet figures
in s.280A, s.280D and s.280F were substituted from 1 July 2024 by S.I. No. 301
of 2024 (`../si-301-2024/`). Its reg. 9 inserts s.280I, under which the
company elects whether the new figures apply to financial years beginning on
or after 1 January 2024 or 1 January 2023 (issue #555); the figures they
replaced are quoted from the S.I. The employee limbs date from the 2017
insertion and were not amended.
`schedule-3A.md` is Schedule 3A (accounting principles, form and content of
the entity financial statements of a company in the small companies regime),
fetched from the LRC-revised Act. Its Format 1 headings are quoted verbatim
by `src/domain/reports/schedule3A.ts`, and a test checks each one against this
file.
