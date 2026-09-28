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

**Company size and formats (issue #554):** `s280B.md` (small groups),
`s280C.md` (the small companies regime) and `s280F.md` (medium companies)
join the set, fetched the same way. The threshold figures in s.280A, s.280D
and s.280F were substituted from 1 July 2024 by S.I. No. 301 of 2024 (regs.
4 and 7), "in effect as per reg. 2" according to the LRC annotation; reg. 2
itself is not captured here, so which financial years the new figures first
apply to is flagged on every size classification rather than assumed.
`schedule-3A.md` is Schedule 3A (accounting principles, form and content of
the entity financial statements of a company in the small companies regime),
fetched from the LRC-revised Act. Its Format 1 headings are quoted verbatim
by `src/domain/reports/schedule3A.ts`, and a test checks each one against this
file.
