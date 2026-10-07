# Taxes Consolidation Act 1997 — reference extracts

There is **no LRC revised Act** for the Taxes Consolidation Act 1997. eISB
only publishes the **1997 as-enacted** section pages. Sections inserted
later (e.g. s.600F/J/M/P, s.835D/DA) are not at
`/eli/1997/act/39/section/…` — that path 404s for them. They must be read
from the Finance Act that inserted them instead.

## How to use these files

1. Read the as-enacted section here.
2. Overlay the later Finance Act that amends it (Finance Act 2024 is at
   [`docs/statutes/finance-act-2024/`](../finance-act-2024/)).
3. Do not treat 1997 text as current law where a later Finance Act
   substituted it — every file here carries `consolidation: as-enacted-1997`
   in its front matter as a standing reminder.

These as-enacted extracts are reference only. The deterministic KB reads the
current Revenue Notes for Guidance instead
([`docs/statutes/tca-1997-nfg/`](../tca-1997-nfg/), `tcaNfgIngestion.ts`),
which supply the corporation tax and income tax rules.

## Files

| File | Role | Status |
|---|---|---|
| `1997-act-39-ss-885-887.md` | Record-keeping and tax-reference-number obligations | Present |
| `s18.md` | Schedule D — Case I/II trading and professional income | Present |
| `s52.md` | Part 4 interpretation (trades) | Present |
| `s81.md` | General rule as to deductions (wholly and exclusively) | Present |
| `s235.md` | Athletic/amateur sports bodies exemption | Present |
| s.284 | Wear and tear allowances (rates superseded — see the source note) | In the rules catalogue: `catalogue/tca-1997/s284.json` (#556) |
| `s288.md` | Balancing allowances and charges | Present |
| `s299.md` | Allowances to lessees | Present |
| `s496.md` | Heavily amended since enactment — see file's own warning | Present |
| s.530 | RCT — relevant contract / relevant operations / construction operations | In the rules catalogue: `catalogue/tca-1997/s530.json` (#556) |
| `s530B.md`–`s530V.md` | RCT sections as inserted by Finance Act 2011 s.20, not yet loaded (ss.530A, E, G, H and I are in the rules catalogue, `catalogue/tca-1997/s530A.json` ..., each with FA 2011 s.20's page beside it) | Present |
| `s613.md` | Miscellaneous CGT exemptions | Present |

## Priority sections not yet added (transaction classification)

Against the KB's own unresolved Finance-Act-2024-to-TCA cross-references
(see `docs/statutes/audit-report.json`), still missing: `s481.md`, `s826.md`.

Inserted later — fetch from the inserting Act, not TCA 1997 (see the
"no LRC revised Act" warning above; also true of s.530A below, not just
the CGT/transfer-pricing sections):

- **s.530A** (who must operate RCT — read with s.530 above) — Finance
  Act 2011 s.20, amended by Finance Act 2025 s.21. No 1997 enacted page
  exists for it; the knowledge base reads it from FA 2011 s.20's page
  (`catalogue/tca-1997/s530A.json`).
- s.600F / 600J / 600M / 600P — CGT reliefs (search later Finance Acts)
- s.835D — FA 2019 transfer-pricing guidelines
- s.835DA — FA 2024 s.45 (OECD Amount B)
- s.653AGA, s.653I, s.653Q — later Finance Act inserts
