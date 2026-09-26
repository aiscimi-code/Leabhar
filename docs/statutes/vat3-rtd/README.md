# VAT3 / RTD box mapping

Revenue guidance — use only after a VAT treatment is already known from
VATCA/the Regulations. Never a substitute for the statute.

`vat3-rtd-boxes.md` maps a known treatment to the actual VAT3 and annual
Return of Trading Details (RTD) box it lands in — knowing a supply is
zero-rated doesn't by itself tell you which return box it belongs in.

## Sources the code quotes (issue #210)

- `completing-vat3-return.md` (+ `.html`): Revenue's "How do you complete a
  VAT 3 return?". `src/domain/vat/boxDefinitions.ts` quotes each box's
  definition from it; a test checks every quote is still in the file.
- `VAT-RTD-S76.md` (+ `.pdf`): Tax and Duty Manual "VAT Return of Trading
  Details" (February 2026). `src/domain/vat/rtd.ts` follows its §2.6 grid and
  §4 answers (reverse-charged services in section 1, CGS adjustments left
  out, a changed rate stays on its row).

The VIES statement follows `docs/statutes/vies/vies-traders-manual.md`
(`src/domain/vat/vies.ts`).
