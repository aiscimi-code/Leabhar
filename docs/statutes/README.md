# Irish statute/regulation sources

Every legislative and regulatory reference document used by the Irish rules
knowledge base lives under this one directory, one subfolder per source
instrument. See [`docs/RULES_KB.md`](../RULES_KB.md) for the KB's
architecture and [`SOURCE-REGISTER.md`](SOURCE-REGISTER.md) for the full
1.1-1.6 (+5, +9) binding-source register this folder implements.

**Before citing anything here as current law, read
[`CURRENT-REGISTER.md`](CURRENT-REGISTER.md).** As of September 2026,
Finance Act 2025 (No. 18 of 2025) has superseded Finance Act 2024 as the
latest VAT-amending Act, and VAT rates/thresholds/RCT have moved since —
none of that is reflected in this folder's own deterministically-ingested
text (which is deliberately 2010/2024-as-enacted; see "Two kinds of
content here" below). `CURRENT-REGISTER.md` and
[`CURRENT-REGISTRATION.md`](CURRENT-REGISTRATION.md) track what's now
superseded and what to use instead.

## Two kinds of content here

- **Deterministically ingested** (`finance-act-2024/`, `vatca-2010/`'s
  `vatca-2010-enacted.md`): full verbatim text, parsed into the
  `irish_act_provisions` / `irish_tax_rules` tables by
  `src/domain/rules/*Parser.ts` at ingest time. Every character is
  offset-traceable back to the committed source file. This is the only
  content actually driving the deterministic rule engine.
- **Reference material** (everything else below): curated pointers,
  summaries, or partial extracts sourced from official HTML/PDF. Useful for
  a human or an LLM-assisted lookup to know where to look and what changed,
  but **not parsed by the deterministic pipeline** — several are explicitly
  paraphrased, not verbatim, and are marked as such in their own front
  matter (`conversion: official-html-plaintext` etc.) or body text.

## Layout

| Folder | Source | Kind | Status |
|---|---|---|---|
| `finance-act-2024/` | Finance Act 2024 (No. 43 of 2024) | Deterministic (full Act) + a reference cross-check extract (Part 3 only) | Complete (deterministic); ingested |
| `vatca-2010/` | VATCA 2010 (No. 31 of 2010) | Deterministic (full Act, as-enacted) + 4 reference pointers to current/revised text | Complete (deterministic, all 125 sections); ingested. Revised pointers cover ss. 5, 46, 65, 84 only |
| `vatca-2010-revised/` | VATCA 2010, full LRC-revised corpus (separate from the 4 pointers above) | Reference only | Schedules 2, 3, 4, 5, 6, 9 committed — including the two rate-determining ones (2 zero-rate, 3 reduced-rate); Schedules 1, 7, 8 and individual sections not yet |
| `tca-1997/` | Taxes Consolidation Act 1997 (No. 39 of 1997) | Reference only | 11 sections (885-887, 18, 52, 81, 235, 284, 288, 299, 496, 530, 613). Not ingested into the KB at all yet — see `docs/RULES_KB.md` "Next steps" |
| `si-639-2010/` | VAT Regulations 2010 (S.I. 639/2010) | Reference only | Regs 14, 14A (via S.I. 734/2020), 19-27, 29 covered |
| `si-156-2012/` | Mandatory e-filing Regulations 2012 (S.I. 156/2012) | Reference only | Complete |
| `si-69-2025/` | European Union (VAT) Regulations 2025 (S.I. 69/2025) | Reference only | Summary of all substantive amendments |
| `si-651-2011/` | Income Tax and Corporation Tax (RCT) Regulations 2011 (S.I. 651/2011) | Reference only | eRCT administration mechanics |
| `vat-rates/` | Revenue current VAT rates table (Markdown + machine-readable JSON) + category-move notes | Reference only | Rate history complete (2020-2026, retrieved 2026-09-18); `schedule-moves-2025-2026.md` tracks category reclassifications (e.g. restaurant/hairdressing to 9% from 1 Jul 2026) the headline table alone doesn't show |
| `tdm-38-01-03b/` | Revenue TDM Part 38-01-03b (VAT registration guidelines) | Reference only | Complete — all 54 pages (p01-18, p19-36, p37-54), paraphrased |
| `import-vat/` | Customs Manual on Import VAT (guidance) + VATCA s.3(b)/s.53A pointers | Reference only | One TDM extract; see `import-vat/README.md` on a dropped duplicate |
| `rct/` | Relevant Contracts Tax (TCA 1997 s.530, SI 651/2011) — a withholding regime, not VAT | Reference only | 5 TDM extracts (18-02-01/02/04/05/11); one citation unverified, see `rct/README.md` |
| `vat3-rtd/` | VAT3 / annual RTD box mapping (Revenue guidance) | Reference only | One box-mapping doc |
| `frs-102/` | FRS 102 pointer (not the standard text — FRC copyright) | Reference only (`accounting_standard` rank) | Pointer only, by design |
| `companies-act-2014/` | Companies Act 2014 — records, size thresholds, filing | Reference only | ss. 282, 280A, 280D/280E, 352, 358-360 |
| `scripts/` | `extract_vat_sources.py` — HTML/PDF -> Markdown extractor for the reference sources above | Tooling | Requires network access this repo's own sandboxes don't have; run via `.github/workflows/extract-vat-docs.yml` (`workflow_dispatch`) on a GitHub-hosted runner instead |

Four files live at this top level rather than under a source's own folder,
because they describe the set as a whole, not one instrument:

- [`SOURCE-REGISTER.md`](SOURCE-REGISTER.md) — the binding-source register.
- `audit-report.json` — a fresh-ingest snapshot of what the deterministic KB
  has extracted from `finance-act-2024/` and `vatca-2010/` (see
  `docs/RULES_KB.md` "Audit report" for how to regenerate it).
- [`CURRENT-REGISTER.md`](CURRENT-REGISTER.md) — current-vs-superseded
  status as of a given date (currently 18 September 2026): which sources
  in this folder are now stale relative to live law, and what to use
  instead. Read this before treating anything here as today's answer.
- [`CURRENT-REGISTRATION.md`](CURRENT-REGISTRATION.md) — current VAT
  registration thresholds, dated.

## Known gaps (see `SOURCE-REGISTER.md` for detail on each)

- `tca-1997/` covers 11 sections against 442 unresolved Finance-Act-to-TCA
  cross-references in the audit report — the specific CGT/transfer-pricing
  sections it names most (s.600F, s.835DA, s.653AGA, s.653I, s.653Q, s.481,
  s.826, s.831B, s.600J/M/P) are still untouched, and several of them (like
  s.600F and s.835DA) can never be a plain TCA 1997 file at all — they were
  inserted by later Finance Acts and have no 1997 enacted page to fetch.
- `vatca-2010-revised/` is missing Schedules 1, 7, 8 and all individual
  sections; `si-639-2010/` is missing regs 15-18 and 28 (not confirmed
  present or absent).
- The reference-only folders are not wired into the deterministic pipeline
  at all — see `docs/RULES_KB.md` for what would be needed to change that
  (verbatim, offset-traceable text, not a paraphrase). This includes
  `vat-rates/rates.json`, which is structured and effective-dated and ready
  to load into the app's own `tax_rates` table, but doing so is application
  code, not a documentation change.
