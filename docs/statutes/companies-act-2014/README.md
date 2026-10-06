# Companies Act 2014 — filing basics

Statutory books, company-size thresholds, and financial-statement filing
obligations — separate from VATCA's own record-keeping duty (VATCA s.84):
a company needs both. `companies-act-2014.md` is a hand-written, paraphrase-
only summary covering s.282 (adequate accounting records), s.280A
(small-company thresholds), s.280D/280E (micro-company regime), s.352
(abridged filing), and ss.358-360 (audit exemption) — it carries no source
hash and backs no curated rule.

**Verbatim capture (issue #135):** ss.282, 280A, 280D, 280E, 352, 358, 359
and 360 are the same eight sections from the LRC-revised Act. Every section
the knowledge base holds is now a rules catalogue entry,
`catalogue/companies-act-2014/s<N>.json`, with its LRC page beside it
(#556); the statute copies that were here are gone. These, not the
paraphrase above, back the size-threshold and filing/audit-exemption rules
curated in `src/domain/rules/companiesAct2014Curation.ts` — see
`docs/RULES_KB.md`'s "Companies Act 2014 size thresholds" section.

**Accounting records, statutory financial statements and the annual return
(issue #559 / #214):** ss.281, 283–286, 290–293, 343 and 347 join the set,
from the same pages. The curated rules are the s.281 duty to keep adequate
records, the s.282 adequacy test, where and how they are kept and inspected
(ss.283–284), the s.285 six-year retention (also #557), the s.290 duty to
prepare entity financial statements and the s.291 Companies Act form of
those statements, the s.293 group-statements duty, the s.343 56-day annual
return, and the s.347 annexes. s.286 (offences) and s.292 (IFRS entity
statements) are ingested for citability and marked `not_applicable` in the
coverage matrix.

**Company size and formats (issue #554):** ss.280B (small groups), 280C
(the small companies regime) and 280F (medium companies) join the set, from
the same pages. The turnover and balance sheet figures
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
