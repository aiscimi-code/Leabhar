# Irish statute/regulation sources

Every legislative and regulatory reference document used by the Irish rules
knowledge base lives under this one directory, one subfolder per source
instrument. See [`docs/RULES_KB.md`](../RULES_KB.md) for the KB's
architecture and [`SOURCE-REGISTER.md`](SOURCE-REGISTER.md) for the full
1.1-1.6 (+5, +9) binding-source register this folder implements.

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
| `vatca-2010-revised/` | VATCA 2010, full LRC-revised corpus (separate from the 4 pointers above) | Reference only | Schedules 4, 5, 6, 9 only so far; individual sections not yet started |
| `tca-1997/` | Taxes Consolidation Act 1997 (No. 39 of 1997) | Reference only | ss. 885-887, 18, 52, 81 (record-keeping + Case I/II + deductibility). Not ingested into the KB at all yet — see `docs/RULES_KB.md` "Next steps" |
| `si-639-2010/` | VAT Regulations 2010 (S.I. 639/2010) | Reference only | Partial: regs 14, 19, 20, 23, 24, 27, 29 + 14A (via S.I. 734/2020); missing 21, 22, 25, 26 |
| `si-156-2012/` | Mandatory e-filing Regulations 2012 (S.I. 156/2012) | Reference only | Complete |
| `si-69-2025/` | European Union (VAT) Regulations 2025 (S.I. 69/2025) | Reference only | Summary of all substantive amendments |
| `vat-rates/` | Revenue current VAT rates table (Markdown + machine-readable JSON) | Reference only | Complete, dated (2020-2026 history, retrieved 2026-09-18) |
| `tdm-38-01-03b/` | Revenue TDM Part 38-01-03b (VAT registration guidelines) | Reference only | Partial: pages 19-36 of 54, paraphrased |
| `import-vat/` | Customs Manual on Import VAT (guidance) + VATCA s.3(b)/s.53A pointers | Reference only | One TDM extract |
| `rct/` | Relevant Contracts Tax (TCA 1997 ss.530/530A, SI 651/2011) — a withholding regime, not VAT | Reference only | 2 TDM extracts (18-02-01, 18-02-02); one citation unverified, see `rct/README.md` |
| `vat3-rtd/` | VAT3 / annual RTD box mapping (Revenue guidance) | Reference only | One box-mapping doc |
| `frs-102/` | FRS 102 pointer (not the standard text — FRC copyright) | Reference only (`accounting_standard` rank) | Pointer only, by design |
| `companies-act-2014/` | Companies Act 2014 — records, size thresholds, filing | Reference only | ss. 282, 280A, 280D/280E, 352, 358-360 |
| `scripts/` | `extract_vat_sources.py` — HTML/PDF -> Markdown extractor for the reference sources above | Tooling | Requires network access this repo's own sandboxes don't have; run via `.github/workflows/extract-vat-docs.yml` (`workflow_dispatch`) on a GitHub-hosted runner instead |

Two files live at this top level rather than under a source's own folder,
because they describe the set as a whole, not one instrument:

- [`SOURCE-REGISTER.md`](SOURCE-REGISTER.md) — the binding-source register.
- `audit-report.json` — a fresh-ingest snapshot of what the deterministic KB
  has extracted from `finance-act-2024/` and `vatca-2010/` (see
  `docs/RULES_KB.md` "Audit report" for how to regenerate it).

## Known gaps (see `SOURCE-REGISTER.md` for detail on each)

- `tca-1997/` covers only 6 sections; nothing here yet supports the bulk of
  Finance-Act-to-TCA cross-references the audit report flags as unresolved.
- `si-639-2010/`, `tdm-38-01-03b/` are partial extracts of larger instruments.
- The reference-only folders are not wired into the deterministic pipeline
  at all — see `docs/RULES_KB.md` for what would be needed to change that
  (verbatim, offset-traceable text, not a paraphrase).
