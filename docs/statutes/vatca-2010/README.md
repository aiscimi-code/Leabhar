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
  oversight (see `docs/RULES_KB.md` "Limitations").

  All 125 numbered body sections convert cleanly. This was cross-checked
  against the Act's own "ARRANGEMENT OF SECTIONS" table of contents (embedded
  in the source PDF): every section is found, and every extracted heading
  matches its TOC entry, aside from two sections (53, 55) where the TOC and
  the body margin render the same words with a different dash glyph — a font
  detail, not a content error.

These files are reference material only.

This Act is ingested into the Irish rules knowledge base — see
[`docs/RULES_KB.md`](../../RULES_KB.md).

## Revised-text pointers

`s5-revised.md`, `s46-revised.md`, `s65-revised.md`, `s84-revised.md` are
short, curated summaries (not verbatim) of the *current, LRC-revised* text of
those four sections, sourced from
`https://revisedacts.lawreform.ie/eli/2010/act/31/section/{n}/revised/en/html`.
They exist because `vatca-2010-enacted.md` above is deliberately the
*2010-as-enacted* text — later amendments (e.g. S.I. 69/2025's changes to
ss. 5, 59, 60, 80 and the new ss. 92B-92D) are not reflected in it. Where the
two disagree, the revised pointer is the more current one, but neither
substitutes for reading the official page directly for anything
consequential. See [`docs/statutes/SOURCE-REGISTER.md`](../SOURCE-REGISTER.md)
(item 1.1) for the full register entry and known gaps (only 4 of the
originally-scoped 7 sections have a pointer file).
