# Relevant Contracts Tax (RCT) — not VAT

Withholding on payments under relevant contracts in construction, forestry
and meat processing. Rates **0% / 20% / 35%** — a withholding rate, never a
VAT rate. A construction invoice can be VAT-coded correctly and still need
a separate RCT deduction authorisation; the two are independent regimes.

| Source | File / URL |
|---|---|
| TCA 1997 s.530 (relevant contract / relevant operations / construction operations) | Rules catalogue: `catalogue/tca-1997/s530.json`, with its Irish Statute Book page beside it (#556) |
| TCA 1997 s.530A (who must operate RCT) | Not a 1997-Act page — inserted by Finance Act 2011 s.20, amended by Finance Act 2025 s.21. Rules catalogue: `catalogue/tca-1997/s530A.json`, read from FA 2011 s.20's page (ss.530E, G, H and I likewise). |
| TDM Part 18-02-01 Relevant Operations (updated 2025/26) | `tdm-18-02-01-operations.md` |
| TDM Part 18-02-02 Who is a Principal Contractor (updated Feb 2026) | `tdm-18-02-02-principal.md` |
| TDM Part 18-02-04 Principals | Rules catalogue: `catalogue/rct/tdm-18-02-04.json`, with Revenue's PDF beside it (#556) |
| TDM Part 18-02-05 Subcontractors | Rules catalogue: `catalogue/rct/tdm-18-02-05.json` |
| TDM Part 18-02-11 eRCT (full, Mar 2026) | Rules catalogue: `catalogue/rct/tdm-18-02-11.json` |

The three manuals in the catalogue are written by `npm run catalogue:extract --
rct/tdm-18-02-04` (and -05, -11), which fetches the PDF and extracts each
page's text with `scripts/catalogue/pdfplumber_to_text.py` (the
`pdfplumber-full` conversion their copies here were made with).
| SI 651/2011 eRCT Regulations | [`docs/statutes/si-651-2011/`](../si-651-2011/) |

**Citation refined, still not fully verified:** `tdm-18-02-02-principal.md`
cites "s.639(1)" for the "erection of buildings or development of land"
construction-operations definition used to decide who is a principal.
Now that s.530 is in the knowledge base, that description is closer to what it calls
**construction operations** — but "who is a principal" content specifically
belongs to **s.530A** ("who must operate RCT"), not s.530 or s.639. The
most plausible actual citation is **s.530A(1)**, which the knowledge base
now holds (see above), but the TDM's citation has not been checked against
it, so this stays flagged rather than silently corrected.

## Registration TDM (finish verbatim extract)

TDM Part 38-01-03b, official PDF (May 2026, 54 pages):
https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-38/38-01-03b.pdf

A partial extract (pages 19-36 only) already exists at
[`docs/statutes/tdm-38-01-03b/`](../tdm-38-01-03b/); finishing this one
belongs there, not here.
