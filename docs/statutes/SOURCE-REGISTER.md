---
title: "Source register — binding Irish VAT texts (1.1-1.6) plus reference items 5 and 9"
source_type: leabhar_implementation_rule
jurisdiction: IE
---

# Binding sources referenced here

Official HTML converted to Markdown (`official-html-plaintext`), not PDF
extracts. **Most of these files are curated pointers/summaries, not verbatim
statute text** — several explicitly say "see official text for the full
list" rather than quoting every sub-paragraph. They are reference material
for a human or an LLM-assisted lookup, not input to the deterministic
`irish_tax_rules` pipeline (see `docs/RULES_KB.md`): that pipeline requires
`provisionText` to be a verbatim, offset-traceable slice of the source
document, which a paraphrase cannot satisfy. See
[`docs/statutes/README.md`](README.md) for how this folder is laid out.

| ID | Path | Citation | Official source | Status |
|---|---|---|---|---|
| 1.1 | `vatca-2010/s5-revised.md`, `s46-revised.md`, `s65-revised.md`, `s84-revised.md` | VATCA 2010 (No. 31) ss. 5, 46, 65, 84 revised | https://revisedacts.lawreform.ie/eli/2010/act/31/front/revised/en/html | Partial: scoped to ss. 2, 5, 46, 59, 65, 66, 84; only these 4 exist. VATCA s.59 is separately fully ingested verbatim (as-enacted) into the deterministic KB. |
| 1.2 | `finance-act-2024/2024-act-43-part3-vat.md` | Finance Act 2024 (No. 43), Part 3 (VAT, ss. 77-88) | https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/print | Cross-check extract only; the KB's actual parser input is the full-Act `2024-act-43-enacted.md` in the same folder, not this. |
| 1.3 | `si-639-2010/` | VAT Regulations 2010 (S.I. 639/2010) | https://www.irishstatutebook.ie/eli/2010/si/639/made/en/print | Regs 14, 19-27, 29 covered, plus reg 14A (postponed accounting, inserted by S.I. 734/2020 — a separate instrument, not the original 639/2010 text). Regs 15-18 and 28 not confirmed present or absent. **The whole 47-regulation document is separately ingested verbatim as its own file, `si-639-2010/2010-si-639.md`, with reg.25 (cash-accounting authorisation) curated into the deterministic KB.** |
| 1.4 | `si-69-2025/2025-si-69.md` | European Union (Value-Added Tax) Regulations 2025 (S.I. 69/2025) | https://www.irishstatutebook.ie/eli/2025/si/69/made/en/html | Summary of all substantive amendments (ss. 2, 5, 6, 59, 60, 80, new ss. 92B-92D). **This same file's Regulations 5, 8 and 9 (respectively: the current VATCA s.6(1)(c)/(d) "current or previous calendar year" turnover test for the goods/services registration thresholds; the current s.80(1) cash-accounting eligibility thresholds; and the s.92B "annual turnover" definition for the cross-border SME scheme) are separately ingested verbatim and curated into the deterministic KB — see issue #136 bug 2 / issue #137.** |
| 1.5 | `tca-1997/` | TCA 1997 (as enacted) | https://www.irishstatutebook.ie/eli/1997/act/39/section/886/enacted/en/html | 11 sections: 885-887, 18, 52, 81, 235, 284, 288, 299, 496, 530, 613. Against 442 unresolved Finance-Act-to-TCA cross-references — s.600F/835DA/653AGA and others can never be a plain TCA file (later Finance Act inserts, no 1997 page exists). **s.530 and s.284 are separately ingested verbatim and curated into the deterministic KB; s235, s288, s299, s496 and s613 carry no source hash despite reading as verbatim — see `docs/RULES_KB.md` "Documents reviewed, not curated".** |
| 1.6 | `si-156-2012/2012-si-156.md` | Mandatory e-filing Regulations 2012 (S.I. 156/2012) | https://www.irishstatutebook.ie/eli/2012/si/156/made/en/html | Complete. **Regs 1, 2 and 4 of this same file are separately ingested verbatim into the deterministic KB (regs 5-9 are this file's own editorial summary, not verbatim); reg.4 (mandatory e-filing) is curated.** |
| — | `si-651-2011/2011-si-651.md` | Income Tax and Corporation Tax (RCT) Regulations 2011 (S.I. 651/2011) | https://www.irishstatutebook.ie/eli/2011/si/651/made/en/print | Not part of the original 1.1-1.6 register — added for the separate RCT effort (`rct/`). eRCT administration mechanics; superseded by SI 576/2012 — not deterministically ingested. |
| 5 | `tdm-38-01-03b/p01-18.md`, `p19-36.md`, `p37-54.md` | Revenue TDM Part 38-01-03b — Guidelines for VAT Registration | https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-38/38-01-03b.pdf | Complete — all 54 pages, paraphrased. **One passage of the full-document file `tdm-38-01-03b/38-01-03b.md` (the "Exclusion from Mandatory Electronic Filing" guidance) is separately ingested verbatim and curated into the deterministic KB, closing an S.I. 156/2012 reg.5 gap.** |
| 9 | `vat-rates/current-vat-rates.md` + `rates.json` + `schedule-moves-2025-2026.md` | Revenue current VAT rates table | https://www.revenue.ie/en/vat/vat-rates/search-vat-rates/current-vat-rates.aspx | Complete (2020-2026), retrieved 2026-09-18. `rates.json` is the same data machine-readable, keyed by `effective_from` — not yet wired into the app's own `tax_rates` table (application code, not a docs change). None of these three files carries a source hash; they back no deterministic rule. |
| — | `vatca-2010-revised/` | VATCA 2010, full LRC-revised corpus | https://revisedacts.lawreform.ie/eli/2010/act/31/revised/en/html | Not part of the original 1.1-1.6 register — a separate, wider effort than item 1.1's 4 pointers. Schedules 2, 3, 4, 5, 6, 9 and ss.2, 3, 5, 6, 9, 10, 12, 16, 19, 20, 22, 26-28, 33-37, 46, 59-61, 65, 66, 76-80, 84, 86, 91-92, 91A-91J, 92A-92D, 108, 108A-108C committed; Schedules 1, 7, 8 and other individual sections not yet. **s.46 (current VAT rates) and Schedules 2/3 (8 curated paragraphs) are deterministically ingested via `vatcaRevisedIngestion.ts`; s.6(1)(c)/(d) and s.92B are separately ingested and curated via the S.I. 69/2025 route (regs. 5 and 9 — see row 1.4) since their current text is a 2025 substitution, not the LRC page's own commencement date; s.33 (added for issue #138, interpreting s.34's specified-services/immovable-property/short-term-hire terms) is committed as text only; the remainder are committed as text only.** |
| — | `vat-thresholds/revenue-vat-thresholds.md` | Revenue: What are the VAT thresholds? | https://www.revenue.ie/en/vat/vat-registration/who-should-register-for-vat/vat-thresholds.aspx | Added for issue #137. Reference/cross-check only — restates the VATCA s.2(1)/s.78 threshold figures and the s.92B/TDM turnover-calculation rules in consumer-facing form; backs no rule of its own. |
| — | `sme-scheme/tdm-sme-domestic-layer.md` | Revenue TDM: EU VAT SME Scheme – Domestic Layer | https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part10-special-schemes/vat-ecommerce-rules/eu-vat-sme-scheme-domestic-layer.pdf | Added for issue #137. Complete (7 pages), retrieved 2026-09-19. Reference/cross-check for the `vat.registration_threshold_goods`/`_services` turnover-test conditions (worked examples in s.2.3 verified against the curated rule's own test cases) — backs no rule of its own; the operative statutory text it explains is VATCA s.6(1)(c)/(d) and s.92B, curated from the S.I. 69/2025 route above. |
| — | `282-2011/consolidated-282-2011.md`, `282-2011/articles-10-13b-establishment.md` | Council Implementing Regulation (EU) No 282/2011, consolidated 14.04.2025 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02011R0282-20250414 | Added for issue #138. Full consolidated regulation retrieved as reference; Articles 10-13b (the "established"/"fixed establishment"/"permanent address"/"usually resides"/"immovable property" tests VATCA ss.12/33/34 rely on without defining) separately extracted verbatim into its own file. **Not deterministically curated into a `conditions`-array rule** — it is an inherently multi-factor legal test (seat of economic activity, place of central management, registered office, human/technical resources) that no single TransactionContext field can mechanically evaluate; see `vat.reverse_charge_services_from_abroad`'s updated `interpretationNote` in `vatcaCuration.ts` and the new `supplierEstablishedOutsideState` override field in `transactionLookup.ts`. |
| — | `pos-of-services/general-place-of-supply.md`, `pos-of-services/exceptions-to-general-rules.md` | Revenue: General place of supply rules for services / Exceptions to the general place of supply rules | https://www.revenue.ie/en/vat/vat-on-services/when-is-vat-charged-on-services/general-place-of-supply-rules-for-services.aspx , https://www.revenue.ie/en/vat/vat-on-services/when-is-vat-charged-on-services/exceptions-general-place-supply-rules.aspx | Added for issue #138. Reference/cross-check for VATCA s.34's B2B/B2C general rules and paragraph (c)-(n) exceptions already curated (`vat.place_of_supply_b2b_general`) or documented as out of scope in that rule's `interpretationNote`; backs no rule of its own. |
| — | `tbe-services/tdm-tbe-services.md` | Revenue TDM: Telecommunications, broadcasting and electronic (TBE) services | https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part03-taxable-transactions-goods-ica-services/Services/telecommunications-broadcasting-and-electronic-tbe-services.pdf | Added for issue #138. Complete (15 pages), retrieved 2026-09-19. Reference material for VATCA s.34(kc) (TBE services place-of-supply, an existing exception this KB does not yet curate); backs no rule. |
| — | `immovable-property/tdm-services-connected-with-immovable-property.md` | Revenue TDM: Services connected with immovable property | https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part03-taxable-transactions-goods-ica-services/Services/services-connected-with-immovable-property.pdf | Added for issue #138. Complete (13 pages), retrieved 2026-09-19. Reference material for VATCA s.33(2)/s.34(c) (the immovable-property place-of-supply exception, already listed in `vat.place_of_supply_b2b_general`'s exceptions but not separately curated); backs no rule. |
| — | `distance-sales/tdm-intra-community-distance-sales.md` | Revenue TDM: VAT and intra-Community Distance Sales of Goods | https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/Part04-place-of-taxable-transactions-place-of-supply/distance-sales/vat-and-intra-community-distance-sales-of-goods.pdf | Added for issue #138. Complete (7 pages), retrieved 2026-09-19. Reference material for VATCA s.30/s.35A (distance-selling place-of-supply and its own €10,000 threshold, distinct from the registration thresholds this KB curates); backs no rule. |

`scripts/extract_vat_sources.py` (and the `workflow_dispatch` GH Actions job
`.github/workflows/extract-vat-docs.yml` that runs it on a network-unrestricted
runner) can fill the "Partial" gaps above — the full VATCA revised corpus
lands under `vatca-2010-revised/` when run, not `vatca-2010/` (which stays
reserved for the as-enacted text and its 4 hand-picked revised pointers).

## Relationship to the deterministic knowledge base

The Irish rules KB (`docs/RULES_KB.md`) originally ingested the **full
verbatim text** of two sources by a different route — a reviewed
PDF/HTML-to-Markdown converter, not this HTML register:

- Finance Act 2024 — `finance-act-2024/2024-act-43-enacted.md` (whole Act;
  s.78 is separately curated for the current VAT registration thresholds)
- VATCA 2010, all 125 sections — `vatca-2010/vatca-2010-enacted.md`

That has since grown to include several of this register's own instruments
in full or in part, each as its own separate whole-document (or
one-provision) file rather than this register's hand-picked reference
extracts: VATCA s.46 and Schedules 2/3 (`vatca-2010-revised/`), TCA 1997
s.530 and s.284 (`tca-1997/`), S.I. 639/2010 (whole document), S.I.
156/2012 (regs 1/2/4), S.I. 69/2025 (regs.5, 8 and 9), and one passage of Revenue TDM
38-01-03b — see `docs/statutes/README.md`'s "Two kinds of content here"
for the current, authoritative list.

Where a file in this register overlaps a KB-ingested section, the KB's own
copy is the verbatim, offset-traceable one and is authoritative for rule
extraction — this register's paraphrased/partial reference files back no
rule regardless. This register's remaining value is documenting sources
the KB still does *not* fully ingest (most of TCA 1997; most of S.I.
639/2010's individual regulations beyond reg.25; S.I. 69/2025's regs 1-7,
9-10) and the pointers to revised/current text (the KB's VATCA principal-
Act text is the 2010-as-enacted wording; S.I. 69/2025 in particular
documents specific amendments made since).

Notes:

- TCA ss.885-887 here are **as enacted**. Later Finance Act amendments are
  not consolidated in the eISB section pages. The same applies to any TCA
  1997 section without a "revised" LRC page at all — none exists for TCA
  1997 (unlike VATCA 2010); a section inserted by a later Finance Act (e.g.
  s.600F, s.835DA) must be read from that Finance Act directly, not from
  `/eli/1997/act/39/section/…`, which 404s for it.
- Conversion flattens eISB/LRC chrome; front matter records
  `source_html_sha256` where computed.
