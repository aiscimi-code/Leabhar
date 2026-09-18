# Value-Added Tax Consolidation Act 2010 (enacted)

- Source PDF: Irish Statute Book, Number 31 of 2010 (enacted text, as
  consolidated at enactment — later amendments, including by the Finance
  Acts, are NOT reflected in this text; see "Limitations" in
  [`docs/RULES_KB.md`](../../RULES_KB.md)).
- `vatca-2010-enacted.pdf` — the enacted PDF, as supplied.
- `vatca-2010-enacted.md` — a parseable Markdown extract produced locally by
  `scripts/convert-statute-pdf.ts` (not a hand-structured rewrite; body not
  reviewed). Reproducible from the PDF:

  ```
  npx tsx scripts/convert-statute-pdf.ts \
    docs/statutes/vatca-2010/vatca-2010-enacted.pdf \
    docs/statutes/vatca-2010/vatca-2010-enacted.md \
    --section-re '^(\d+[A-Z]?)\s*\.—' --start-after 'BE IT ENACTED' --stop-at 'SCHEDULE'
  ```

  Unlike the Finance Act 2024 extract (a single-column amending-Act layout,
  parsed by `statuteParser.ts`), this Act is printed in the "marginal note"
  layout typical of a consolidated principal Act: each section's short
  heading and predecessor-provision citation are printed in a column beside
  the section rather than above it. `convert-statute-pdf.ts` reconstructs the
  main body text and re-attaches each section's heading above its section
  number, in the convention `vatcaParser.ts` expects — see that script's own
  header comment for how, and its known edge cases.

  The conversion stops at the first `SCHEDULE` heading: Schedules 1–5 (exempt
  activities, zero-rated goods/services, reduced-rate goods/services, etc.)
  are **not** ingested in this pass — a documented limitation, not an
  oversight. Sections 30, 42 and 55 are also not resolved by the converter
  (see `docs/RULES_KB.md` "Limitations").

These files are reference material only.

This Act is ingested into the Irish rules knowledge base — see
[`docs/RULES_KB.md`](../../RULES_KB.md).
