# Test pack results — Leabhar main e31bdae

Company: Test Pack Digital Ltd, VAT-registered, invoice basis.
Bank import: read=200 imported=200 duplicates=0 failed=0

## Sales invoices

| id | date | customer | pack net/VAT/gross | system net/VAT/gross | posted | flags |
|---|---|---|---|---|---|---|
| SI-001 | 2026-01-08 | Acme Digital Ltd | 1000/230/1230 @23% | 100000/23000/123000 | yes | normal  |
| SI-002 | 2026-01-20 | Murphy Consulting Ltd | 2000/460/2460 @23% | 200000/46000/246000 | yes | normal  |
| SI-003 | 2026-02-04 | Cork Foods Ltd | 600/138/738 @23% | 60000/13800/73800 | yes | normal  |
| SI-004 | 2026-02-18 | GreenTech Ltd | 1500/345/1845 @23% | 150000/34500/184500 | yes | normal  |
| SI-005 | 2026-03-03 | Atlantic Retail Ltd | 850/195.5/1045.5 @23% | 85000/19550/104550 | yes | normal  |
| SI-006 | 2026-03-19 | Acme Digital Ltd | 2500/575/3075 @23% | 250000/57500/307500 | yes | normal  |
| SI-007 | 2026-04-02 | Murphy Consulting Ltd | 2400/552/2952 @23% | 240000/55200/295200 | yes | normal  |
| SI-008 | 2026-04-17 | Cork Foods Ltd | 1200/276/1476 @23% | 120000/27600/147600 | yes | normal  |
| SI-009 | 2026-05-01 | GreenTech Ltd | 1800/414/2214 @23% | 180000/41400/221400 | yes | normal  |
| SI-010 | 2026-05-21 | Atlantic Retail Ltd | 900/207/1107 @23% | 90000/20700/110700 | yes | normal  |
| SI-011 | 2026-06-05 | Acme Digital Ltd | 4000/920/4920 @23% | 400000/92000/492000 | yes | normal  |
| SI-012 | 2026-06-22 | Murphy Consulting Ltd | 3000/690/3690 @23% | 300000/69000/369000 | yes | normal  |
| SI-026 | 2026-06-28 | Acme Digital Ltd | -250/-57.5/-307.5 @23% | -25000/-5750/-30750 | yes | credit_note  |
| SI-013 | 2026-07-07 | Cork Foods Ltd | 1200/276/1476 @23% | 120000/27600/147600 | yes | normal  |
| SI-014 | 2026-07-23 | GreenTech Ltd | 2200/506/2706 @23% | 220000/50600/270600 | yes | normal  |
| SI-015 | 2026-08-04 | Atlantic Retail Ltd | 1100/253/1353 @23% | 110000/25300/135300 | yes | normal  |
| SI-016 | 2026-08-20 | Acme Digital Ltd | 3500/805/4305 @23% | 350000/80500/430500 | yes | normal  |
| SI-017 | 2026-09-03 | Murphy Consulting Ltd | 3200/736/3936 @23% | 320000/73600/393600 | yes | normal  |
| SI-018 | 2026-09-21 | Cork Foods Ltd | 1700/391/2091 @23% | 170000/39100/209100 | yes | normal  |
| SI-019 | 2026-10-05 | GreenTech Ltd | 1900/437/2337 @23% | 190000/43700/233700 | yes | normal  |
| SI-020 | 2026-10-22 | Atlantic Retail Ltd | 1300/299/1599 @23% | 130000/29900/159900 | yes | normal  |
| SI-021 | 2026-11-04 | Acme Digital Ltd | 5000/1150/6150 @23% | 500000/115000/615000 | yes | normal  |
| SI-022 | 2026-11-19 | Murphy Consulting Ltd | 2800/644/3444 @23% | 280000/64400/344400 | yes | normal  |
| SI-023 | 2026-12-02 | Cork Foods Ltd | 2000/460/2460 @23% | 200000/46000/246000 | yes | normal  |
| SI-024 | 2026-12-12 | GreenTech Ltd | 2400/552/2952 @23% | 240000/55200/295200 | yes | normal  |
| SI-025 | 2026-12-20 | Atlantic Retail Ltd | 1500/0/1500 @0% | 150000/0/150000 | yes | normal zero_rate_sale |

## Purchase invoices

| id | date | supplier | pack net/VAT/rate | system VAT | treatment | flags |
|---|---|---|---|---|---|---|
| PI-001 | 2026-01-04 | GitHub | 36.59/8.42 @23% | 842 | NON_EU_SERVICES_RCV | normal |
| PI-002 | 2026-01-06 | Vercel | 16.26/3.74 @23% | 374 | NON_EU_SERVICES_RCV | normal |
| PI-003 | 2026-01-12 | Blacknight | 25/5.75 @23% | 575 | IE_STD | normal |
| PI-004 | 2026-01-25 | Anthropic | 100/23 @23% | 2300 | NON_EU_SERVICES_RCV | normal|US_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-005 | 2026-02-01 | Office Supplies Ltd | 200/46 @23% | 4600 | IE_STD | normal |
| PI-006 | 2026-02-10 | Cloud Services EU | 50/11.5 @23% | 1150 | EU_SERVICES_RCV | normal|EU_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-007 | 2026-02-28 | GoDaddy | 30/6.9 @23% | 690 | NON_EU_SERVICES_RCV | normal |
| PI-008 | 2026-03-05 | Anthropic | 200/46 @23% | 4600 | NON_EU_SERVICES_RCV | normal|US_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-009 | 2026-03-12 | Business Insurance Co | 600/0 @0% | 0 | IE_EXEMPT | normal |
| PI-026 | 2026-03-20 | Office Supplies Ltd | -40/-9.2 @23% | -920 | IE_STD | credit_note |
| PI-010 | 2026-04-01 | Vercel | 50/11.5 @23% | 1150 | NON_EU_SERVICES_RCV | normal |
| PI-011 | 2026-04-08 | Vodafone Business | 50/11.5 @23% | 1150 | IE_STD | normal |
| PI-012 | 2026-04-15 | Solicitors LLP | 300/69 @23% | 6900 | IE_STD | normal |
| PI-013 | 2026-05-02 | Computer Equipment Ltd | 1000/230 @23% | 23000 | IE_STD | normal|CAPITAL_CANDIDATE |
| PI-014 | 2026-05-12 | Anthropic | 100/23 @23% | 2300 | NON_EU_SERVICES_RCV | normal|US_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-015 | 2026-05-18 | Irish Rail | 55/0 @0% | 0 | IE_ZERO | normal |
| PI-016 | 2026-06-02 | Blacknight | 20/4.6 @23% | 460 | IE_STD | normal |
| PI-017 | 2026-06-19 | Restaurant Ltd | 150/34.5 @23% | 3450 | IE_STD | normal |
| PI-018 | 2026-07-01 | Anthropic | 200/46 @23% | 4600 | NON_EU_SERVICES_RCV | normal|US_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-019 | 2026-07-10 | Software Co | 100/23 @23% | 2300 | NON_EU_SERVICES_RCV | normal |
| PI-027 | 2026-07-11 | Software Co | 100/23 @23% | 2300 | NON_EU_SERVICES_RCV | duplicate|DO_NOT_DOUBLE_COUNT |
| PI-020 | 2026-08-01 | Cloud Services EU | 100/23 @23% | 2300 | EU_SERVICES_RCV | normal|EU_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-021 | 2026-08-10 | Google Ads | 200/46 @23% | 4600 | IE_STD | normal |
| PI-028 | 2026-08-15 | Google Ads | 200/40 @20% | 4000 | IE_STD | incorrect_vat|STATED_VAT_TRUSTED_EVEN_IF_WRONG |
| PI-022 | 2026-09-01 | Anthropic | 100/23 @23% | 2300 | NON_EU_SERVICES_RCV | normal|US_SUPPLIER_IRISH_VAT_ON_INVOICE |
| PI-023 | 2026-09-15 | Dublin Hotel | 150.46/13.54 @9% | 1354 | IE_SECOND_RED | normal |
| PI-029 | 2026-09-20 | Unknown Supplier | 250/57.5 @23% | 5750 | IE_STD | missing_supplier |
| PI-024 | 2026-10-01 | GoDaddy | 30/6.9 @23% | 690 | NON_EU_SERVICES_RCV | normal |
| PI-025 | 2026-10-10 | Training Provider | 500/115 @23% | 11500 | IE_STD | normal |
| PI-030 | 2026-11-05 | Computer Equipment Ltd | 500/115 @23% | 11500 | IE_STD | normal|CAPITAL_CANDIDATE |
| PI-031 | 2026-11-06 | Anthropic | 100/23 @23% | 2300 | NON_EU_SERVICES_RCV | duplicate_payment|US_SUPPLIER_IRISH_VAT_ON_INVOICE|DO_NOT_DOUBLE_COUNT |
| PI-032 | 2026-12-15 | Charity | 100/0 @0% | 0 | IE_ZERO | non_deductible_candidate |

## Bank transactions

| id | date | ref | desc | amount | topics | rate rules | coding | expected |
|---|---|---|---|---|---|---|---|---|
| BT-0119 | 2026-01-02 | MISC-001 | Stationery | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0179 | 2026-01-02 | MISC-061 | Parking | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0101 | 2026-01-05 | TX-0101 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0143 | 2026-01-06 | MISC-025 | Domain renewal | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0027 | 2026-01-07 | PI-001 | SEPA PAYMENT GitHub | -45.01 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0102 | 2026-01-08 | TX-0102 | Vercel | -20 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0028 | 2026-01-09 | PI-002 | SEPA PAYMENT Vercel | -20 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0167 | 2026-01-10 | MISC-049 | Parking | -72 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0069 | 2026-01-12 | DIR-001 | Director funds introduced | 2000 | vat|business_expense|director_transaction | vat.rate_standard_current | no default rule | director funding |
| BT-0089 | 2026-01-14 | UNKNOWN-001 | CARD PAYMENT 4837 | -87.4 | vat|business_expense | vat.rate_standard_current | no default rule | missing invoice |
| BT-0131 | 2026-01-14 | MISC-013 | Small software charge | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0191 | 2026-01-14 | MISC-073 | Courier | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0029 | 2026-01-15 | PI-003 | SEPA PAYMENT Blacknight | -30.75 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0103 | 2026-01-15 | TX-0103 | Blacknight hosting | -30.75 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0001 | 2026-01-16 | SI-001 | SEPA CREDIT Acme Digital Ltd | 1230 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0155 | 2026-01-18 | MISC-037 | Courier | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0030 | 2026-01-28 | PI-004 | SEPA PAYMENT Anthropic | -123 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0057 | 2026-01-28 | REV-01 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0002 | 2026-01-29 | SI-002 | SEPA CREDIT Murphy Consulting Ltd | 2460 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0070 | 2026-01-31 | REV-TAX-01 | Revenue payment - VAT | -500 | vat|business_expense | vat.rate_standard_current | no default rule | tax payment |
| BT-0120 | 2026-02-03 | MISC-002 | Small software charge | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0180 | 2026-02-03 | MISC-062 | Business supplies | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0031 | 2026-02-04 | PI-005 | SEPA PAYMENT Office Supplies Ltd | -246 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0104 | 2026-02-05 | TX-0104 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0144 | 2026-02-07 | MISC-026 | Courier | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0105 | 2026-02-08 | TX-0105 | Vercel | -20 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0168 | 2026-02-11 | MISC-050 | Stationery | -72 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0032 | 2026-02-13 | PI-006 | SEPA PAYMENT Cloud Services EU | -61.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0003 | 2026-02-14 | SI-003 | SEPA CREDIT Cork Foods Ltd | 738 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0071 | 2026-02-14 | REV-TAX-02 | Revenue payment - PAYE/other | -350 | vat|business_expense|usc|income_tax | vat.rate_standard_current | no default rule | tax payment |
| BT-0132 | 2026-02-15 | MISC-014 | Domain renewal | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0192 | 2026-02-15 | MISC-074 | Office coffee | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0090 | 2026-02-17 | TRANSFER-001 | REVOLUT TRANSFER | -500 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0156 | 2026-02-19 | MISC-038 | Stationery | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0072 | 2026-02-25 | REF-001 | Office Supplies refund | 49.2 | vat|business_expense | vat.rate_standard_current | no default rule | supplier refund |
| BT-0058 | 2026-02-28 | REV-02 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0004 | 2026-03-01 | SI-004 | SEPA CREDIT GreenTech Ltd | 1845 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0033 | 2026-03-03 | PI-007 | SEPA PAYMENT GoDaddy | -36.9 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0121 | 2026-03-04 | MISC-003 | Domain renewal | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0181 | 2026-03-04 | MISC-063 | Postage | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0106 | 2026-03-05 | TX-0106 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0034 | 2026-03-08 | PI-008 | SEPA PAYMENT Anthropic | -246 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0107 | 2026-03-08 | TX-0107 | Vercel | -20 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0145 | 2026-03-08 | MISC-027 | Office coffee | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0169 | 2026-03-12 | MISC-051 | Courier | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0005 | 2026-03-15 | SI-005 | SEPA CREDIT Atlantic Retail Ltd | 1045.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0035 | 2026-03-15 | PI-009 | SEPA PAYMENT Business Insurance Co | -600 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0073 | 2026-03-15 | INS-001 | Business insurance annual premium | -600 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0133 | 2026-03-16 | MISC-015 | Stationery | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0193 | 2026-03-16 | MISC-075 | Stationery | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0157 | 2026-03-20 | MISC-039 | Business supplies | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0091 | 2026-03-21 | DUP-001 | ACME DIGITAL | -1230 | vat|business_expense | vat.rate_standard_current | no default rule | possible duplicate |
| BT-0052 | 2026-03-25 | PI-026 | SEPA PAYMENT Office Supplies Ltd | 49.2 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0074 | 2026-03-25 | REF-002 | Office Supplies credit note refund | 49.2 | vat|business_expense | vat.rate_standard_current | no default rule | supplier refund |
| BT-0006 | 2026-03-27 | SI-006 | SEPA CREDIT Acme Digital Ltd | 3075 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0059 | 2026-03-28 | REV-03 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0036 | 2026-04-04 | PI-010 | SEPA PAYMENT Vercel | -61.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0092 | 2026-04-04 | REF-VERCEL | REFUND VERCEL | 20 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0108 | 2026-04-05 | TX-0108 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0122 | 2026-04-05 | MISC-004 | Stationery | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0182 | 2026-04-05 | MISC-064 | Business supplies | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0146 | 2026-04-09 | MISC-028 | Parking | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0007 | 2026-04-11 | SI-007 | SEPA CREDIT Murphy Consulting Ltd | 2952 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0037 | 2026-04-11 | PI-011 | SEPA PAYMENT Vodafone Business | -61.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0075 | 2026-04-12 | TEL-001 | Vodafone Business | -61.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0170 | 2026-04-13 | MISC-052 | Small software charge | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0134 | 2026-04-17 | MISC-016 | Courier | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0194 | 2026-04-17 | MISC-076 | Domain renewal | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0038 | 2026-04-18 | PI-012 | SEPA PAYMENT Solicitors LLP | -369 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0076 | 2026-04-19 | LEG-001 | Solicitor consultation | -369 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0158 | 2026-04-21 | MISC-040 | Office coffee | -72 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0008 | 2026-04-27 | SI-008 | SEPA CREDIT Cork Foods Ltd | 1476 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0060 | 2026-04-28 | REV-04 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0159 | 2026-05-02 | MISC-041 | Office coffee | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0039 | 2026-05-05 | PI-013 | SEPA PAYMENT Computer Equipment Ltd | -1230 | vat|capital_allowances|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0109 | 2026-05-05 | TX-0109 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0123 | 2026-05-06 | MISC-005 | Courier | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0183 | 2026-05-06 | MISC-065 | Domain renewal | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0147 | 2026-05-10 | MISC-029 | Business supplies | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0009 | 2026-05-12 | SI-009 | SEPA CREDIT GreenTech Ltd | 2214 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0093 | 2026-05-13 | ATM-001 | ATM WITHDRAWAL | -100 | vat|banking|business_expense | vat.rate_standard_current | no default rule | cash/unknown |
| BT-0171 | 2026-05-14 | MISC-053 | Stationery | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0040 | 2026-05-15 | PI-014 | SEPA PAYMENT Anthropic | -123 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0135 | 2026-05-18 | MISC-017 | Business supplies | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0195 | 2026-05-18 | MISC-077 | Business supplies | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0041 | 2026-05-21 | PI-015 | SEPA PAYMENT Irish Rail | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0077 | 2026-05-22 | TRV-001 | Irish Rail business travel | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0061 | 2026-05-28 | REV-05 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0010 | 2026-06-02 | SI-010 | SEPA CREDIT Atlantic Retail Ltd | 1107 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0160 | 2026-06-03 | MISC-042 | Small software charge | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0042 | 2026-06-05 | PI-016 | SEPA PAYMENT Blacknight | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0110 | 2026-06-05 | TX-0110 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0124 | 2026-06-07 | MISC-006 | Postage | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0184 | 2026-06-07 | MISC-066 | Domain renewal | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0148 | 2026-06-11 | MISC-030 | Small software charge | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0011 | 2026-06-13 | SI-011 | SEPA CREDIT Acme Digital Ltd | 4920 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0078 | 2026-06-14 | REV-TAX-03 | Revenue payment - VAT | -750 | vat|business_expense | vat.rate_standard_current | no default rule | tax payment |
| BT-0172 | 2026-06-15 | MISC-054 | Business supplies | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0094 | 2026-06-18 | DIR-004 | TRANSFER TO DIRECTOR | -300 | vat|business_expense|director_transaction | vat.rate_standard_current | no default rule | director current account |
| BT-0136 | 2026-06-19 | MISC-018 | Small software charge | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0196 | 2026-06-19 | MISC-078 | Domain renewal | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0079 | 2026-06-20 | ENT-001 | Restaurant - business dinner | -184.5 | vat|business_expense | vat.rate_restaurant_catering_reduced_current | no default rule |  |
| BT-0043 | 2026-06-22 | PI-017 | SEPA PAYMENT Restaurant Ltd | -184.5 | vat|business_expense | vat.rate_restaurant_catering_reduced_current | no default rule |  |
| BT-0062 | 2026-06-28 | REV-06 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0012 | 2026-07-01 | SI-012 | SEPA CREDIT Murphy Consulting Ltd | 3690 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0026 | 2026-07-02 | SI-026 | SEPA PAYMENT CREDIT NOTE Acme Digital Ltd | -307.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0095 | 2026-07-02 | DUP-002 | ACME DIGITAL | -1230 | vat|business_expense | vat.rate_standard_current | no default rule | possible duplicate |
| BT-0044 | 2026-07-04 | PI-018 | SEPA PAYMENT Anthropic | -246 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0161 | 2026-07-04 | MISC-043 | Domain renewal | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0111 | 2026-07-05 | TX-0111 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0125 | 2026-07-08 | MISC-007 | Domain renewal | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0185 | 2026-07-08 | MISC-067 | Stationery | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0149 | 2026-07-12 | MISC-031 | Parking | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0045 | 2026-07-13 | PI-019 | SEPA PAYMENT Software Co | -123 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0173 | 2026-07-16 | MISC-055 | Small software charge | -72 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0013 | 2026-07-17 | SI-013 | SEPA CREDIT Cork Foods Ltd | 1476 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0137 | 2026-07-20 | MISC-019 | Office coffee | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0197 | 2026-07-20 | MISC-079 | Postage | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0080 | 2026-07-23 | DIR-002 | Director personal expense reimbursement | -250 | vat|business_expense|director_transaction | vat.rate_standard_current | no default rule | director current account |
| BT-0063 | 2026-07-28 | REV-07 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0014 | 2026-08-03 | SI-014 | SEPA CREDIT GreenTech Ltd | 2706 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0046 | 2026-08-04 | PI-020 | SEPA PAYMENT Cloud Services EU | -123 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0112 | 2026-08-05 | TX-0112 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0162 | 2026-08-05 | MISC-044 | Courier | -72 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0126 | 2026-08-09 | MISC-008 | Postage | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0186 | 2026-08-09 | MISC-068 | Stationery | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0047 | 2026-08-13 | PI-021 | SEPA PAYMENT Google Ads | -246 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0150 | 2026-08-13 | MISC-032 | Parking | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0081 | 2026-08-15 | ADV-001 | Google Ads | -246 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0015 | 2026-08-16 | SI-015 | SEPA CREDIT Atlantic Retail Ltd | 1353 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0053 | 2026-08-16 | PI-028 | SEPA PAYMENT Google Ads | -240 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0096 | 2026-08-16 | UNKNOWN-002 | CARD PAYMENT | -73.25 | vat|business_expense | vat.rate_standard_current | no default rule | missing invoice |
| BT-0118 | 2026-08-16 | MISMATCH-001 | Computer Equipment Ltd | -1235 | vat|capital_allowances|business_expense | vat.rate_standard_current | no default rule | invoice mismatch |
| BT-0174 | 2026-08-17 | MISC-056 | Parking | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0138 | 2026-08-21 | MISC-020 | Courier | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0198 | 2026-08-21 | MISC-080 | Postage | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0016 | 2026-08-28 | SI-016 | SEPA CREDIT Acme Digital Ltd | 4305 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0064 | 2026-08-28 | REV-08 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0139 | 2026-09-02 | MISC-021 | Small software charge | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0199 | 2026-09-02 | MISC-081 | Stationery | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0048 | 2026-09-04 | PI-022 | SEPA PAYMENT Anthropic | -123 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0113 | 2026-09-05 | TX-0113 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0163 | 2026-09-06 | MISC-045 | Business supplies | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0127 | 2026-09-10 | MISC-009 | Courier | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0187 | 2026-09-10 | MISC-069 | Parking | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0017 | 2026-09-12 | SI-017 | SEPA CREDIT Murphy Consulting Ltd | 3936 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0097 | 2026-09-14 | TRANSFER-002 | REVOLUT TRANSFER | -1000 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0151 | 2026-09-14 | MISC-033 | Courier | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0049 | 2026-09-18 | PI-023 | SEPA PAYMENT Dublin Hotel | -164 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0082 | 2026-09-18 | TRV-002 | Dublin Hotel | -164 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0175 | 2026-09-18 | MISC-057 | Postage | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0083 | 2026-09-25 | BNK-001 | Bank charge | -25 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0065 | 2026-09-28 | REV-09 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0018 | 2026-10-01 | SI-018 | SEPA CREDIT Cork Foods Ltd | 2091 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0140 | 2026-10-03 | MISC-022 | Domain renewal | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0200 | 2026-10-03 | MISC-082 | Business supplies | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0050 | 2026-10-04 | PI-024 | SEPA PAYMENT GoDaddy | -36.9 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0114 | 2026-10-05 | TX-0114 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0164 | 2026-10-07 | MISC-046 | Parking | -89 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0128 | 2026-10-11 | MISC-010 | Office coffee | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0188 | 2026-10-11 | MISC-070 | Parking | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0051 | 2026-10-13 | PI-025 | SEPA PAYMENT Training Provider | -615 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0152 | 2026-10-15 | MISC-034 | Domain renewal | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0019 | 2026-10-16 | SI-019 | SEPA CREDIT GreenTech Ltd | 2337 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0176 | 2026-10-19 | MISC-058 | Parking | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0084 | 2026-10-22 | EDU-001 | Training course | -615 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0066 | 2026-10-28 | REV-10 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0098 | 2026-10-29 | REF-004 | SUPPLIER REFUND | 50 | vat|business_expense | vat.rate_standard_current | no default rule | supplier refund |
| BT-0020 | 2026-11-03 | SI-020 | SEPA CREDIT Atlantic Retail Ltd | 1599 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0141 | 2026-11-04 | MISC-023 | Postage | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0115 | 2026-11-05 | TX-0115 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0054 | 2026-11-06 | PI-030 | SEPA PAYMENT Computer Equipment Ltd | -615 | vat|capital_allowances|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0055 | 2026-11-07 | PI-031 | SEPA PAYMENT Anthropic | -123 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0117 | 2026-11-07 | DUP-ANT-01 | ANTHROPIC duplicate payment | -123 | vat|business_expense | vat.rate_standard_current | no default rule | duplicate payment |
| BT-0165 | 2026-11-08 | MISC-047 | Stationery | -12.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0021 | 2026-11-12 | SI-021 | SEPA CREDIT Acme Digital Ltd | 6150 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0129 | 2026-11-12 | MISC-011 | Postage | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0189 | 2026-11-12 | MISC-071 | Courier | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0153 | 2026-11-16 | MISC-035 | Postage | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0085 | 2026-11-18 | TEL-002 | Vodafone Business | -61.5 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0099 | 2026-11-19 | CASH-001 | CASH WITHDRAWAL | -200 | vat|business_expense | vat.rate_standard_current | no default rule | cash/unknown |
| BT-0177 | 2026-11-20 | MISC-059 | Small software charge | -30 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0067 | 2026-11-28 | REV-11 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0116 | 2026-12-05 | TX-0116 | GitHub subscription | -45 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0142 | 2026-12-05 | MISC-024 | Small software charge | -18 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0166 | 2026-12-09 | MISC-048 | Stationery | -24.6 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0023 | 2026-12-12 | SI-023 | SEPA CREDIT Cork Foods Ltd | 2460 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0130 | 2026-12-13 | MISC-012 | Courier | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0190 | 2026-12-13 | MISC-072 | Domain renewal | -41 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0086 | 2026-12-15 | DON-001 | Charitable donation | -100 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0056 | 2026-12-16 | PI-032 | SEPA PAYMENT Charity | -100 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0154 | 2026-12-17 | MISC-036 | Postage | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0087 | 2026-12-20 | REF-003 | Supplier refund | 123 | vat|business_expense | vat.rate_standard_current | no default rule | supplier refund |
| BT-0088 | 2026-12-21 | DIR-003 | Director transfer | -750 | vat|business_expense|director_transaction | vat.rate_standard_current | no default rule | director current account |
| BT-0100 | 2026-12-21 | DIR-005 | DIRECTOR TRANSFER | -750 | vat|business_expense|director_transaction | vat.rate_standard_current | no default rule | director current account |
| BT-0178 | 2026-12-21 | MISC-060 | Parking | -55 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0024 | 2026-12-23 | SI-024 | SEPA CREDIT GreenTech Ltd | 2952 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0068 | 2026-12-28 | REV-12 | Revolut Business monthly fee | -10 | vat|banking|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0025 | 2027-01-01 | SI-025 | SEPA CREDIT Atlantic Retail Ltd | 1500 | vat|business_expense | vat.rate_standard_current | no default rule |  |
| BT-0022 | 2027-01-05 | SI-022 | SEPA CREDIT Murphy Consulting Ltd | 3444 | vat|business_expense | vat.rate_standard_current | no default rule |  |