# Current vs superseded (as at 18 September 2026)

The agent answers **today's** transaction. Do not retrieve as-enacted 2010/1997 text as live law. Historical text is a dedicated lookup only if the user asks about a closed period.

## Canonical live sources

| Topic | Use this | Do not use |
|---|---|---|
| VATCA text | LRC revised Act, **updated to 1 January 2026** — https://revisedacts.lawreform.ie/eli/2010/act/31/revised/en/html | `docs/statutes/vatca-2010/vatca-2010-enacted.md` (2010 words; s.46 still 21%) |
| VAT rates (headline) | Revenue table + `docs/vat/vat-rates/` — **23 / 13.5 / 9 / 4.8 / farmer 4.5%** from 1 Jan 2026 | Enacted VATCA s.46; farmer 5.1% (2025 only) |
| Which supplies sit at 9% vs 13.5% | LRC **Schedules 2 and 3** as amended by FA 2025 + SI 725/2024 | 2010 Schedule lists |
| VAT Regulations | SI 639/2010 **as amended** by SI 734/2020 (reg.14A postponed accounting), 735–737/2020, 31/2024 | Bare 2010 print of SI 639 |
| SME scheme / OSS | SI 69/2025 (in force 6 Mar 2025) — VATCA ss.92B–92D | Pre-2025 SME commentary |
| Registration thresholds | Revenue page below — **€85,000 / €42,500** from 1 Jan 2025, confirmed FA 2025 s.68 from 1 Jan 2026 | Old Notes for Guidance quoting €75,000 / €37,500 |
| Import VAT / postponed accounting | VATCA s.53A + SI 734/2020 + Customs Manual May 2026 | Pre-Brexit AEP manuals |
| RCT | TCA ss.530 / 530A as amended by **FA 2025 s.21** + TDM 18-02-02 Feb 2026 | 1997-only definition |
| Income tax deductibility | TCA s.81 **plus later FA overlays** (no LRC revised TCA exists) | 1997 as-enacted as if current |
| Companies size / books | LRC CA 2014 ss.280A, 282, 352 | Repealed s.350 |
| Accounts standard | FRS 102 Sept 2024; Periodic Review 2024 from **1 Jan 2026** | Pre-2024 s.23 revenue |
| Finance Act | **FA 2025 (Act 18/2025)** is the latest VAT amending Act. FA 2024 is history except where FA 2025 did not touch the section. | Treating FA 2024 as the last word |

## Live numbers (do not date-stamp these in prompts without `as_at`)

See `docs/vat/vat-rates/current-vat-rates.md` and `docs/CURRENT-REGISTRATION.md`.

**Headline rates from 1 January 2026:** standard 23%, reduced 13.5%, second reduced 9%, livestock 4.8%, farmer flat-rate addition **4.5%**.

**Category moves the headline table does not show:**

- **1 July 2026:** restaurant, catering, hot takeaway food (not alcohol/soft drinks) and hairdressing move **13.5% → 9%**. Hotel/guest **accommodation stays at 13.5%**. Mixed B&B/package charges must be split. Revenue TDM restaurant/catering updated 15 Jun 2026.
- **8 Oct 2025 → 25 Nov 2025:** supply of qualifying apartments at 9%.
- **26 Nov 2025 → 31 Dec 2030:** supply **and construction** of qualifying apartments / apartment blocks at 9% (FA 2025).
- Gas and electricity: 9% **to 31 Dec 2030**.
- Hotel/guesthouse room hire for **non-accommodation** use (meetings etc.): **23% from 1 Jan 2026**.
- Broiler stock-minding: excluded from farmer flat-rate addition from **1 Sep 2025** (SI 327/2025).
- Waiver of exemption on lettings: cancelled on FA 2025 enactment — do not apply old waiver mechanics.

## What to delete from the live index

These files may stay in git for provenance. They must not be chunked into the default retrieval set:

- `docs/statutes/vatca-2010/vatca-2010-enacted.md` / `.pdf`
- `docs/statutes/2024-act-43/2024-act-43-enacted.md` as a *rate* source (keep only as the amending Act for 2024)
- Any TCA 1997 as-enacted section presented without `consolidation: as-enacted-1997` and an overlay pointer
- Farmer 5.1%, goods threshold €75,000, services €37,500, standard 21%

Historical lookup (closed years only): Revenue rates table rows before 1 Jan 2026; LRC annotations; eISB commencement tables.
