# Source audit — issue #591

Date of this pass: 2026-09-29. Checked against the files under `docs/statutes/`
and `src/domain/rules/knowledgeBase.ts`, not against `SOURCE-REGISTER.md` as
ground truth.

This replaces the stub at PR #598 (`docs/statutes/AUDIT-REPORT-591.md`), which
listed three folders, used `...` for the rest, and treated "SHA-256 FAIL" as a
real defect.

## Verdict on the review comments on #591 / PR #598

| Claim | Valid? | Why |
|---|---|---|
| 335 files fail SHA-256 against `source_html_sha256` | **No** | That field is the digest of the *upstream HTML/PDF*. Re-hashing the committed `.md` and comparing it to the HTML digest will almost always fail. `verifyStatuteFile` already re-hashes the `.md` against the SHA stored *at ingest* in `irish_knowledge_sources.sha256`. |
| 28/28 folders pass SHA | **No** | There are 43 statute folders (plus `scripts`). 408 markdown files; 220 carry `source_html_sha256`; 157 have front matter without that field; 31 have no front matter (READMEs and similar). |
| Several ingested files lack `source_html_sha256` | **Yes** | 30 of 98 unique paths `loadStatutoryKnowledgeBase` reads have no HTML digest. Listed in §2. Do not invent a hash. |
| 34 rules dated from retrieval (`DATE_MISMATCH`) | **Partly, already tracked** | That count is the #199 / `docs/trust/rule-traceability-audit.md` finding. `provenance.test.ts` now refuses `effectiveFrom === retrievedAt.slice(0,10)`. Leftovers such as PRSI Class S `effectiveFrom: 2026-09-25` (revised-text retrieval date, because SWCA s.21 does not state when 4.2% began) are known, not a new class. Rule-catalogue work is #592. |
| Empty `transactionDate` falls back to `today()` | **Yes** | `transactionLookup.ts` did `ctx.transactionDate || today()`. That contradicts AGENTS.md #6 (a historical transaction uses the rule in force on *its* date). Fixed in this PR: missing/invalid date → no rules applied, `reviewRequired`. The HTTP parser already required a date (#447). |
| Empty condition list matches everything, against AGENTS.md | **Yes as a documented split, not a silent bug** | AGENTS.md described the *user-authored* engine (`engine.ts`), which matches nothing. Statute lookup documents the opposite default for curated rules (`transactionLookup.ts` header). AGENTS.md now states the split. Changing statute lookup to match-nothing would drop topic-level rate/threshold rules. Out of scope for a source audit. |
| `taxRateId` / `vatTreatmentId` null on KB rows | **By design** | Treatments are produced by rule *bindings* (`vatSuggestion.ts`), not stored on the rule row. Not a source-currency defect. |
| Build `verify-sources` (#293/#443) now | **Not required to close this pass** | A live re-fetch is the only way to know the HTML digest is still current. This pass did not need it to find the real gaps (missing hashes, as-enacted vs revised, empty-date fallback). Build it when EPIC 40 (#344) is next in line. |
| PR #598 report is complete | **No** | 29 lines, ellipses, no folder census. |

Issue #591 forbids silently replacing a stale source. None were replaced.

## 1. Folder register

`_inbox` is working copy, not an ingested source. `scripts` is tooling.
`source_html_sha256` counts below are `.md` files in that folder (not only
the ingested subset).

| Folder | Edition in repo | Hash / md | Currency (this pass) | Action |
|---|---|---|---|---|
| `282-2011` | EU Reg 282/2011 arts.10–13b | 0 / 2 | Current establishment tests | Add HTML hash on next EUR-Lex capture. |
| `_inbox` | Working copies | 85 / 168 | Not ingested | Leave. Official originals live in Drive issue-218-inbox. |
| `companies-act-2014` | LRC revised extracts | 12 / 14 | Current for ingested sections | Keep. |
| `distance-sales` | Revenue guidance | 0 / 1 | Guidance | Re-check Revenue page when #556 touches distance sales. |
| `ebriefs` | Revenue eBrief 168/25 | 0 / 1 | Current 3 Sep 2025 notice | Add HTML hash on next capture. |
| `finance-act-2001` | As-enacted extract | 1 / 1 | Historical overlay | None. |
| `finance-act-2003` | As-enacted s.23 | 1 / 2 | Historical CA overlay | None. |
| `finance-act-2024` | As-enacted Act | 1 / 3 | History except where FA 2025 did not touch the section | Add hash on the ingested full-Act file. |
| `finance-act-2025` | As-enacted Act 18 | 0 / 2 | Current amending Act per `CURRENT-REGISTER.md` | Add front-matter hash on next capture. |
| `frs-102` | Private working copy (FRC copyright) | 0 / 2 | Not public GitHub source of truth | Owner Drive folder only. |
| `immovable-property` | Revenue guidance | 0 / 1 | Guidance | #556 when that topic is next. |
| `import-vat` | Revenue / Customs guidance | 0 / 2 | Current register: s.53A + SI 734/2020 + May 2026 manual | #556. |
| `ntf-2000` | As-enacted s.4 | 1 / 2 | Current for payroll ingest | None. |
| `pos-of-services` | Revenue guidance | 0 / 2 | Guidance | #556. |
| `rct` | Revenue TDMs | 0 / 6 | Guidance. Offsets issue is #199 leftover / #592 | Do not treat TDM as the Act. |
| `si-1-2024` | As-made | 1 / 2 | Current payroll SI | None. |
| `si-156-2012` | As-made | 1 / 1 | Current e-filing regs | None. |
| `si-301-2024` | As-made | 1 / 2 | Current size-criteria SI | None. |
| `si-312-1996` | LRC revised art. 92 | 0 / 1 | Current prescribed amount (€5,000 from 2011-01-01) | Capture HTML hash on next refresh. |
| `si-345-2018` | As-made | 1 / 2 | Current payroll SI | None. |
| `si-510-2018` | As-made | 1 / 2 | Current payroll SI | None. |
| `si-639-2010` | As-made + some amending regs | 1 / 12 | Register already says use as amended (SI 734/2020 etc.) | #556 row, not an inline replace. |
| `si-651-2011` | As-made | 1 / 2 | RCT admin; superseded by SI 576/2012; not live KB | None. |
| `si-69-2025` | As-made | 1 / 1 | In force 6 Mar 2025 | None. |
| `sme-scheme` | Revenue guidance | 0 / 1 | Guidance | #556. |
| `swa-2024` | As-enacted extract | 1 / 2 | Current payroll overlay | None. |
| `swaerss-2025` | As-enacted extract | 1 / 2 | Current payroll overlay | None. |
| `swca-2005` | LRC revised ss.13, 20–23 | 5 / 6 | Current | None. |
| `swmpa-2024` | As-enacted extract | 1 / 2 | Current payroll overlay | None. |
| `tbe-services` | Revenue guidance | 0 / 1 | Guidance | #556. |
| `tca-1997` | As-enacted extracts | 27 / 34 | README still right: no LRC revised TCA 1997 Act page | Overlay later Finance Acts per section. |
| `tca-1997-nfg` | Revenue Notes for Guidance | 0 / 17 | Guidance, not the Act | Re-check Revenue edition when #556 next touches CT. |
| `tdm-04-08-12` | Revenue TDM | 0 / 1 | Guidance | #556. |
| `tdm-11-00-01` | Revenue TDM | 0 / 2 | Guidance (car emissions) | Add hash on next capture. |
| `tdm-38-01-03b` | Revenue TDM | 0 / 4 | Guidance | Add hash on next capture. |
| `tdm-38-03-33` | Revenue TDM | 0 / 2 | Guidance (payroll) | Add hash on next capture. |
| `tdm-ct` | Revenue CT TDM extracts | 0 / 5 | Guidance | #556. |
| `vat-rates` | Revenue table + notes | 0 / 2 | Live rates 23 / 13.5 / 9 / 4.8 / farmer 4.5% from 1 Jan 2026 | Re-fetch Revenue table when rates next move. |
| `vat-thresholds` | Revenue page | 0 / 1 | €85,000 / €42,500 from 1 Jan 2025 | Re-fetch when Revenue updates. |
| `vat3-rtd` | Revenue VAT3 / RTD | 1 / 4 | Current forms guidance | Add hash on RTD file. |
| `vatca-2010` | As-enacted 2010 | 0 / 6 | Superseded for live rates (s.46 still 21%) | Do not ingest as current rates. Already flagged in `CURRENT-REGISTER.md`. |
| `vatca-2010-revised` | LRC revised (preferred) | 74 / 80 | Current register points here. Live LRC page still the canonical URL | Keep. Re-fetch only when LRC updates. |
| `vies` | Official VIES notes | 1 / 2 | Operational, not a rate source | None. |

`SOURCE-REGISTER.md` / `CURRENT-REGISTER.md` are dated 18 September 2026. They
are the live-index policy, not a file-level SHA register.

## 2. Mechanical defects (do not fold into the narrative)

1. **Empty-date fallback** — fixed in `transactionLookup.ts` (this PR). Test in
   `transactionLookup.test.ts`.
2. **Missing `source_html_sha256` on ingested files** — 30 of 98 unique
   `loadStatutoryKnowledgeBase` paths. `sourceInventory.test.ts` pins the list.
   Filling a hash needs the original HTML/PDF bytes.
   - `finance-act-2024/2024-act-43-enacted.md`
   - `finance-act-2025/2025-act-18-enacted.md`
   - `vatca-2010/vatca-2010-enacted.md`
   - `tca-1997/s530.md`, `tca-1997/s284.md`
   - `rct/tdm-18-02-04.md`, `tdm-18-02-05.md`, `tdm-18-02-11.md`
   - `tdm-38-01-03b/38-01-03b.md`
   - `tca-1997-nfg/part{01,02,04,09,11,11c,12,13,15,18,18d,23,36,41a,43}.md`
   - `si-312-1996/art92.md`
   - `vat3-rtd/VAT-RTD-S76.md`
   - `ebriefs/2025/no-168-25.md`
   - `282-2011/articles-10-13b-establishment.md`
   - `tdm-38-03-33/38-03-33.md`
   - `tdm-11-00-01/11-00-01.md`
3. **PRSI Class S rate window starts 2026-09-25** — retrieval date, because
   revised s.21 does not state commencement of 4.2%. Already flagged by the
   computation. Not a new #199 class.
4. **#289-style stale "pending" pointer** — `SOURCE-REGISTER.md` still describes
   several items as partial that the KB now ingests. Cosmetic; do not treat the
   register as the ingested set.

## 3. Replacement list (follow-ups, not this PR)

1. VATCA as-enacted (`vatca-2010/`) — already marked do-not-use-for-live-rates.
2. SI 639/2010 bare 2010 print — use amended text; #556.
3. Any `tca-1997/` section used as current law without a later FA overlay —
   per-section when that rule is curated (#592 / #556).
4. `si-312-1996/art92.md` — add `source_html_sha256` on next official-HTML capture.

## 4. `verify-sources`

Not built here. The one-off pass was enough to separate real defects from the
SHA category error. A live checker is still the right EPIC 40 tool when that
epic is next; it is not what unblocks the empty-date bug or the missing-hash
census.

## 5. Tests added

- `src/domain/rules/sourceInventory.test.ts` — every path
  `loadStatutoryKnowledgeBase` ingests exists; recorded HTML hashes are 64-hex;
  the 30 files still missing a hash are named.
- `src/domain/rules/transactionLookup.test.ts` — empty / non-ISO date does not
  look up against today.
