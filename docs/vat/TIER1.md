# Tier 1 VAT extracts

Branch `docs/vat-tier1-schedules-sis` — full official HTML text for the gaps that block invoice coding.

| Gap | Path | Status on this branch |
|---|---|---|
| VATCA Schedules 1–9 | `docs/vat/2010-act-31/schedule-N.md` | 4, 5, 6, 9 committed here; 1–3, 7–8 extracted locally and follow |
| S.I. 639/2010 regs 14, 19–27, 29 | `docs/vat/2010-si-639/reg-*.md` | following commits |
| S.I. 734/2020 (inserts reg 14A postponed accounting) | `docs/vat/2010-si-639/reg-14A-si-734-2020.md` | following |
| S.I. 69/2025 full | `docs/vat/2025-si-69/2025-si-69.md` | following |
| Effective-dated rate table | `docs/vat/vat-rates/current-vat-rates.md` + `rates.json` | this commit |

Do not treat VATCA s.46 as enacted (21%) as the current standard rate. Use `rates.json` with `effective_from`.
