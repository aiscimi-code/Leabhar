# What is in `docs/`, and what it is for (issue #291)

Measured on `main` on 2026-09-26. The per-file list is
[`docs-inventory.csv`](docs-inventory.csv): 648 tracked files, each with its
size, class and the reason for it. Regenerate it with the two scripts in
`scripts/docs-inventory/` (see *Method* below). This page summarises the list
and proposes what to do with each part. **It moves nothing.** The decisions
are open in #291.

## Headline

| Class | Size | Meaning |
|---|---:|---|
| runtime | 5.4 MB | Read by the knowledge base load and the tests. The app needs it. |
| cited-code | 0.6 MB | Named by its path in `src/` or `scripts/`. Moving it breaks a reference. |
| duplicate | 25.4 MB | In `_inbox`, byte-identical to a file already promoted out of it. |
| original | 66.4 MB | A PDF or HTML whose SHA-256 is recorded in a converted `.md` beside it. |
| cited-docs | 4.0 MB | Named only by another document. |
| unreferenced | 4.9 MB | Nothing names it. |

About 6 MB of the 107 MB is used by the software. The rest is evidence
(originals), copies of evidence (duplicates), and material collected for rules
not yet written.

The git history is larger than the tree. About 110 MB of zip archives were
committed under `docs/statutes/_inbox/` and later unpacked and deleted:
`leabhar-218-inbox.zip` (51 MB), `C-Revenue-VAT-guidance.zip` (33 MB),
`D-TCA-Notes-for-Guidance.zip` (9 MB), `leabhar-218-section-I.zip` (7 MB),
`G-Return-guides.zip` (7 MB), and five smaller archives. Deleting files
from the tree does not shrink the history.

## Findings that need a decision

1. **The FRS 102/105 PDFs are published in a public repository.**
   `docs/statutes/_inbox/I/` holds 9.7 MB of FRC PDFs and their conversions.
   The folder's own `SOURCES.txt` records the owner's decision: store them in
   the private Google Drive folder, as "a private working copy, not a
   republication". The repository is public, so that decision is not being
   followed. `leabhar-218-section-I.zip` in the history holds the same files.
   Removing them from the tree is easy. Removing them from what is published
   takes a history rewrite or a private repository. **This is the most urgent
   item.**
2. **The installer ships 24 MB it never reads.** `scripts/build-package.mjs`
   copies all of `docs/statutes/` except `_inbox`: 29.8 MB. Of that, 5.3 MB is
   read. The other 23.3 MB is PDF and HTML originals (the Notes for Guidance
   parts, the CT TDMs, VIES, the Finance Acts). Copying only the runtime set
   would cut the installer by about 24 MB with no change in behaviour. The
   `.md` files record each original's SHA-256, so the evidence chain survives.
3. **`_inbox` is two-thirds finished.** Folders D, G and F were promoted
   whole: every file is a byte-identical copy of one in `tca-1997-nfg/`,
   `tdm-ct/` or `swca-2005/`. Parts of A and B were promoted too; the
   commencement S.I.s in A and 15 VATCA sections in B were not. The copies
   left behind are 25 MB of the tree. Nothing reads them.
4. **Three code references point into `_inbox`:**
   - `vatScopeCuration.ts:543`, to `C/financial-services/vat-treatment-of-negotiation-services.md`;
   - `capitalGoodsMath.test.ts:9`, to `C/immovable-goods/capital-goods-scheme.md`;
   - `scheduleRates.ts:14`, to folder `A`.

   These files must be promoted, or the references changed, before `_inbox`
   can leave the repository.
5. **`_inbox/J` is test data, not a statute.** It holds E2E test packs (CSV and
   JSON). It belongs under `tests/` (#237) or nowhere.

## Proposed disposition, by folder

"Keep" means it stays in this repository. "Sources store" means the separate
home that #291 has to choose. My recommendation is a private `leabhar-sources`
repository. A fetch script in this one would check each file against the
SHA-256 the `.md` records, so the evidence stays verifiable and the public
repository carries none of the third-party files.

| Folder | Size | Proposal |
|---|---:|---|
| `docs/*.md`, `docs/trust/`, `docs/rules/` | 0.5 MB | Keep. Review for drift under #286. `SPECIFICATION.md` is the original brief and is marked as preserved. `trust/01-current-state.md` is a dated snapshot: archive it or date it. |
| `statutes/vatca-2010-revised/` | 1.4 MB | Keep the `.md` and the `.html` the tests read. There are 43 converted sections no rule ingests yet (s.5, 6, 12, 19, 91B–J, 92A–D, 108B–C and others): keep them as the #278 backlog. Move the 7 unread `.html` originals to the sources store. |
| `statutes/tca-1997-nfg/` | 12.5 MB | Keep the 11 parts that are read (2.4 MB). Move the 13 PDFs (10 MB) to the sources store. `part18.md` (0.1 MB) is not ingested: keep it only if a rule will use it. |
| `statutes/tdm-ct/` | 7.5 MB | No file here is read. The code cites TDM 47-06-01 by title only. Move the PDFs (7.3 MB). Keep the `.md` for the income tax and CT work still open (#211, #285). |
| `statutes/vies/`, `vat3-rtd/`, `finance-act-2024/`, `finance-act-2025/`, `vatca-2010/`, `swca-2005/` | 5.5 MB | Keep the `.md` files that are read or cited. Move the PDFs and HTML originals (about 4.5 MB). |
| Other `statutes/*` folders | 0.9 MB | Keep. These are small converted sources, read or cited. |
| `statutes/_inbox/D, F, G` | 20.1 MB | Delete from the tree. Every file is a duplicate, and `MANIFEST.sha256` plus the promoted copies keep them verifiable. |
| `statutes/_inbox/A` | 2.6 MB | The Finance Act 2025 PDF and conversion are duplicates: delete them. The 7 commencement S.I.s (684–687/2025, 305/306/324/2026) and the print HTML were never promoted. Move them to the sources store, or promote them to `finance-act-2025/`; `scheduleRates.ts` cites this folder. |
| `statutes/_inbox/B` | 1.4 MB | 21 VATCA sections and the Schedule 1–3 HTML are duplicates of `vatca-2010-revised/`: delete them. 15 were never promoted (ss.13, 23, 24, 29, 32, 41, 51, 52, 53, 55, 57, 58, 82, 83, and a different conversion of s.46). Promote them into `vatca-2010-revised/` as the #278 backlog. The Schedule 1–3 `.md` files are an earlier conversion of files that are already promoted: delete them. |
| `statutes/_inbox/C` | 40.6 MB | Revenue VAT guidance, 9 topics. Promote the 2 cited files into `docs/statutes/<topic>/`. Move the rest to the sources store. |
| `statutes/_inbox/E, H` | 1.9 MB | RCT S.I.s, TDMs and the Companies Act sections not yet used. Move them to the sources store, or promote them when a rule is written (#206, #276). |
| `statutes/_inbox/I` | 9.7 MB | Remove (finding 1). |
| `statutes/_inbox/J` | 0.3 MB | Move to `tests/fixtures/` or delete (#237). |
| `statutes/audit-report.json` | 0.04 MB | Generated on 2026-09-19 and stale. Regenerate it on demand or delete it. `RULES_KB.md` links to it. |

If everything above is done, the tree goes from 107 MB to about 12 MB, and
the installer loses about 24 MB. The history stays at its current size unless
it is rewritten. A rewrite means a force-push to `main`, and every existing
clone must re-clone. That needs an explicit yes.

## Method

1. `NODE_OPTIONS="--require ./scripts/docs-inventory/trace-reads.cjs" npm test`
   logs every path under `docs/` that the suite opens to `docs-reads.log`,
   which is gitignored. The suite calls `loadStatutoryKnowledgeBase`, which is
   the same load the app runs from Settings and the CLI, so what the suite
   reads is the runtime set. That includes the paths built at run time:
   Notes for Guidance parts, SWCA sections, Companies Act sections and VATCA
   sections.
2. `python3 scripts/docs-inventory/inventory.py` classifies each tracked file
   and rewrites `docs-inventory.csv`. The first class that matches wins:
   runtime, cited-code, duplicate, original, cited-docs, unreferenced.

Limits:
- "cited-code" matches a file's full path only. A source cited by title,
  such as TDM 47-06-01, counts as unreferenced here.
- "cited-docs" also counts a bare filename mentioned in a README in the same
  folder.
- The history figures come from `git rev-list --objects --all` on a fresh
  clone.
