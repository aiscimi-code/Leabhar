# VATCA 2010 — full LRC-revised corpus (in progress)

Distinct from [`docs/statutes/vatca-2010/`](../vatca-2010/), which holds the
full **as-enacted (2010)** verbatim text the deterministic KB actually
ingests, plus 4 hand-picked pointers to current text (`s5-revised.md` etc.).
This folder is a separate, wider effort: the full current/revised text of
every operative VATCA section and Schedule, sourced section-by-section from
`https://revisedacts.lawreform.ie/eli/2010/act/31/section/{n}/revised/en/html`
via `../scripts/extract_vat_sources.py`.

## Status

Schedules 4, 5, 6 and 9 are committed. Schedules 1-3, 7 and 8, and the full
set of individual sections (VATCA has ~125), are not yet — re-run the
extractor (via `.github/workflows/extract-vat-docs.yml`) to fill the rest.

None of this is ingested into the deterministic KB — reference only, and
several sections here overlap `vatca-2010/`'s 4 pointer files (ss. 5, 46,
65, 84); once this folder is complete it may be worth retiring those in
favour of this one, but that's not done here.
