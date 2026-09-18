# VATCA 2010 — full LRC-revised corpus (in progress)

Distinct from [`docs/statutes/vatca-2010/`](../vatca-2010/), which holds the
full **as-enacted (2010)** verbatim text the deterministic KB actually
ingests, plus 4 hand-picked pointers to current text (`s5-revised.md` etc.).
This folder is a separate, wider effort: the full current/revised text of
every operative VATCA section and Schedule, sourced section-by-section from
`https://revisedacts.lawreform.ie/eli/2010/act/31/section/{n}/revised/en/html`
via `../scripts/extract_vat_sources.py`.

## Status

Schedules 2, 3, 4, 5, 6 and 9 are committed — including the two most
commercially significant ones for invoice coding: Schedule 2 (zero-rated
goods/services) and Schedule 3 (reduced-rate goods/services, with the
1 July 2026 hospitality move and the apartment 9% rate reflected). All six
now carry `consolidation: lrc-revised` in front matter (backfilled onto
4/5/6/9, which originally lacked it). Only Schedule 2/3 carry
`lrc_updated_to: "2026-01-01"` — 4/5/6/9 don't record when they were
retrieved, so no "updated to" date is claimed for them; don't assume it's
the same date. Schedules 1, 7 and 8, and the full set of individual
sections (VATCA has ~125), are not yet — re-run the extractor (via
`.github/workflows/extract-vat-docs.yml`) to fill the rest.

None of this is ingested into the deterministic KB — reference only, and
several sections here overlap `vatca-2010/`'s 4 pointer files (ss. 5, 46,
65, 84); once this folder is complete it may be worth retiring those in
favour of this one, but that's not done here.
