---
title: "VAT3 and RTD box map"
source_url: "https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/completing-vat3-return.aspx"
source_type: revenue_guidance
jurisdiction: IE
retrieved: "2026-09-18"
---

# VAT3 boxes

Official: https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/completing-vat3-return.aspx

| Box | Contents |
|---|---|
| **T1** | VAT due on supplies, ICAs, postponed-accounting imports, received services |
| **T2** | Recoverable VAT on costs for taxable/qualifying activities, ICAs, postponed-accounting imports, received services, flat-rate addition. Adjust for credit notes |
| **T3** | Payable: T1 − T2 when T1 > T2 |
| **T4** | Repayable: T2 − T1 when T2 > T1 |
| **E1** | Value of goods sent to customers in other EU states |
| **E2** | Value of goods received from suppliers in other EU states |
| **ES1** | Value of services supplied to customers in other EU states |
| **ES2** | Value of services received from suppliers in other EU states |
| **PA1** | Customs value of goods imported under postponed accounting (declaration value + customs duty) |

Nil period: enter **0** at T1–T4. Do not write “nil”.

Zero-rated intra-Community **goods** still go in **E1** (value) even though T1 VAT is €0. ICAs: Irish VAT in T1 and (if deductible) T2, value in **E2**.

Postponed accounting: value in **PA1**; VAT in **T1** and (if deductible) **T2**.

# RTD (annual Return of Trading Details)

TDM VAT-RTD-S76. Four blocks:

1. Supplies of goods/services — split by Irish rate, including exempt in **E3**, intra-Community supplies in **D4**, 0% exports separately.
2. Acquisitions from EU and non-EU postponed accounting — the values behind VAT3 **E2 / ES2 / PA1**, recorded at the Irish rate that would apply if bought in Ireland.
3. Goods or services purchased for resale (Irish, intra-EU, postponed accounting, non-EU imports).
4. Other deductible goods and services.

Rate columns on the RTD follow the live table in `docs/statutes/vat-rates/rates.json` (23 / 13.5 / 9 / 4.8 / farmer %). Do not hard-code the 2010 enacted 21%.

RTD TDM: https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part09-obligations-accountable-persons/return/VAT-RTD-S76.pdf
