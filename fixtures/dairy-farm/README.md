# Mullane Dairy Farm: 20 years of bank statements and documents

A **fictional** spring-calving dairy farm in Co. Cork, trading as a sole trader from
1 Jan 2006 to 31 Dec 2025. Every name, number and amount is invented. Regenerate with
`python3 scripts/generate-dairy-farm-fixtures.py` (seeded, so the output is identical each run).

The data is deliberately dirty. The point is to see whether Leabhar can take the statements
and the documents and work out the real state of the business: what the herd and the milk did,
what was farm and what was private, what was income and what was a loan or a transfer, and what
looks wrong.

## What to feed the tool

| File | What it is |
| --- | --- |
| `bank/aib_current_2006.csv` … `2025.csv` | Main farm current account, one file per year. `Date,Description,Debit,Credit,Balance,Reference`. Dates are `dd/mm/yyyy`. About 9,600 lines. Import with `Date→transaction_date`, `Debit→debit`, `Credit→credit`, day-first dates and the debit/credit amount style. |
| `bank/aib_deposit_2006_2025.csv` | Deposit account: sweeps from and to the current account, and yearly interest with DIRT. |
| `invoices_purchases.csv` | About 4,400 supplier invoices, credit notes, mart dockets, rent receipts. |
| `invoices_sales.csv` | About 690 sales documents: 240 monthly milk statements (self-billed by the co-op, with litres, price, fat and protein in the description), mart and factory dockets, contracting invoices. |
| `other_documents.csv` | Loan agreements, HP agreement, solicitor completion statement, scheme remittance advices, VAT3 returns as filed, co-op loan deduction notices. |
| `payslips.csv` | Payroll for three staff and a former one, plus the spouse's and son's PAYE payslips for pay that is lodged to the farm account. |
| `cheque_stubs.csv` | Cheque book stubs (about 85% kept). Pre-2013 cheques show only a number on the statement. |
| `herd_register_events.csv` | Births, deaths, sales, purchases, TB reactor removals, year-end counts, and movements to a dealer with no docket. |

The invoice columns are those of `import-invoices` / `create-invoice` (`invoiceNumber, date, party,
description, net, vat, gross, due, currency, reference, type, supplyDate`) plus `partyVatNo` and a
`docId`. Amounts are as printed; a credit note is positive and its `type` carries the sign.

## The answer key (do not give these to the tool)

| File | What it holds |
| --- | --- |
| `answer_key_bank.csv` | For every statement line (by file and row): true category, farm/private/mixed/exempt/unexplained, linked `docId`s, planted issue code. Includes the lines that were *dropped* from the statement. |
| `answer_key_documents.csv` | Per document: true category, business use, whether its VAT is recoverable, issue code. |
| `answer_key_issues.csv` | One row per planted problem with the behaviour we expect from the tool. |
| `answer_key_annual_summary.csv` | Cows, litres, milk revenue, banked livestock and scheme income, payroll, drawings, over-claimed input VAT, year-end balance. |

## The business

- **Herd** 205 cows (2006) to 300 (2021). Quota-limited to 2014, expansion from 2015 (parlour 30 to 40 units, 150-cubicle house, slurry store, 60 more cows bought in 2015 to 2017). Nitrates and cost pressure cut it to 262 in 2023.
- **Milk** 5,000 to 5,900 L per cow, set by weather: the 2013 fodder crisis (4,823), the 2018 drought (5,284), the 2009 price crash. Seasonal supply (peaks in May, dry in December/January). Price from 24 c/L (2009) to 59 c/L (2022). The co-op nets its stores account, levies, super-levy and loan instalments off the cheque, so the bank line is not the milk statement.
- **Animals sold** bull and surplus heifer calves at the mart each spring (price swings 25 c to 250 EUR a head), cull cows each autumn to the mart or factory, surplus in-calf heifers in 2012, 2018 and 2022. The mart takes commission off the receipt.
- **Capital** bulk tank, shed extension, parlour upgrades, cluster removers, slurry tanker, 2015 expansion, 25 acres bought 2018 (loan, solicitor, stamp duty), calf feeder, scraper robot, feed pusher robot, herd sensors, parlour automation, HP tractor 2022, 9.9 kWp solar 2019, 49.9 kWp solar plus battery 2024/25 with export payments.
- **Grants and schemes** Single Farm Payment / Basic Payment / BISS, ANC, REPS/AEOS/GLAS/ACRES, TAMS and the solar scheme, TB compensation, fodder aid, forestry premium (exempt).
- **VAT** a flat-rate farmer until 31 Dec 2014 (the co-op pays the flat-rate addition), VAT-registered from 1 Jan 2015 with bi-monthly VAT3s that refund heavily in the expansion years.
- **People** a full-time worker from 2008, a relief milker, a seasonal student, monthly PAYE/PRSI/USC to Revenue. The spouse drives a school bus (PAYE, net pay lodged to the farm account) and from 2019 the son is an employee of a contractor (same).
- **Own contracting** slurry, silage, hedges and baling for neighbours from 2011.
- **Also** conacre rent, insurance claims, an ESB wayleave, a CPO payment, a parental gift, two co-op price-support loans repaid inside milk cheques, overdraft and deposit sweeps, and a late-payment history with Revenue.

## What is wrong with it

| Kind | Examples (see `answer_key_issues.csv` for all 56) |
| --- | --- |
| **Statement defects** | Four missing statement pages (Oct 2008, Jul 2012, Feb 2017, Sep 2022: lines absent, balance continues). Eight duplicated export rows. Three files that start 10 days early and overlap the previous year. |
| **Errors** | Invoices paid twice, then refunded. Payments with two digits swapped. Wrong invoice reference on a payment. Invoices with printed gross not equal to net plus VAT, or VAT at 23% on a 13.5% supply. Duplicate invoices resent. Returned customer cheques. A bank charge taken twice. Revenue debit taken twice. Late PAYE with interest, late VAT with interest. GBP invoices paid by card with FX fee. |
| **Omissions** | Payments with no invoice. Invoices with no VAT number. A tractor sold privately for 28,500 with no sales invoice. Credit notes never refunded. A customer who never paid. |
| **Private spending through the farm account** | Groceries (some with cashback), school costs, family holiday, health insurance, personal pension, credit union, family car running costs, the farmer's own income tax, drawings and ATM withdrawals. Electricity and phone are mixed farm/house. |
| **Not income** | Loan drawdowns, a parental gift, spouse and son PAYE pay, own transfers to the deposit account, forestry premium (exempt), insurance and compensation receipts. |
| **Tax evasion attempts** | 8 years of calves and cows moved to a dealer for cash with no docket or receipt (E1), some of it lodged later as unexplained cash. Contracting paid in cash with no invoice or output VAT (E2, E16). Income deferred over a year end (E3). A worker paid monthly outside payroll (E4), overtime paid outside payroll (E5), the son paid as "farm labour" (E6). A family car invoiced as a farm vehicle (E7). Invoice inflation for grants, with cash coming back (E8, E10). One invoice claimed twice for the same grant (E9). A family holiday invoiced as a study tour (E11). Round-sum year-end invoices from a supplier with no VAT number (E12). Fertiliser prepaid on 29 Dec for delivery in March (E13). A supermarket receipt with VAT claimed (E14). Input VAT over-claimed on all of these (E15). |

## Caveats

- Rates (VAT bands and their dates, the flat-rate addition, livestock rate, scheme amounts, prices, tax
  deductions in payroll) are plausible approximations for exercising the tool. They are **not** a source for
  a real return. Check any rate against Revenue before relying on it.
- A negative milk-cheque month (December 2009 and December 2016) is deliberate: the co-op loan instalment
  was larger than the milk cheque.
- Extraction is not under test: every document is a CSV row, not a PDF.
