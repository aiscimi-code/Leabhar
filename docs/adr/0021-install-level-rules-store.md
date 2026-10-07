# 0021. Ship the rules as a read-only database beside the app; a book keeps only its decisions

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

ADR-0020 §6 says the rules catalogue "is loaded into a read-only rules store at
install level, not copied into each book." It does not say where that store
lives, how an update replaces it, or how an existing book gets there. Issue
#718 step 2 asks for those answers before any code is written.

Today, by contrast:

- **Every rule is copied into the book.** `loadStatutoryKnowledgeBase`
  (`src/domain/rules/knowledgeBase.ts`) runs about twenty derive steps. Each
  writes sources, provisions, rules, rule tests and links into the book, with
  the book's `company_id` on each row.
  - The catalogue JSON (`catalogue/`) holds each version's key, dates, quote,
    value and review.
  - The derive code adds the rest: conditions, effects, topic, tax heads and
    rule type.
  - So the rows come from the JSON *and* the code. Reading the JSON alone does
    not give a rule row.
- **A book numbers versions as it derives them.** A book that held a version
  before it was corrected numbers the correction 2, where the catalogue says 1.
  - Decisions (`irish_rule_decisions`) record the book's number.
  - So do posted invoice lines (`invoice_lines.vat_rule_versions`, `key@version`).
  - Since #718 step 1, `ruleReviewResolver` matches a book's version to the
    catalogue's by content (dates and quote). No reader trusts the number.
- **Two columns on a rule row belong to the book, not the rule.**
  - `tax_rate_id` and `vat_treatment_id` bind a rule to the book's own
    configuration rows.
  - `taxRateSync.ts` writes `tax_rate_id`. It is the only writer that updates a
    rule row.
- **The install already has two roots** (`src/lib/paths.ts`, #59):
  - `APP_ROOT` holds the binaries. The installer replaces it wholesale on
    upgrade and removes it on uninstall.
  - `DATA_ROOT` holds the book, documents and backups. Install and uninstall
    never touch it.
  - `scripts/build-package.mjs` already copies `catalogue/` and
    `docs/statutes/` into `APP_ROOT`, and the provision page reads excerpts
    from there.

Three alternatives were considered:

- **Keep the copies and only stop trusting their review** (where step 1 left
  it). This does not meet ADR-0020 §6. Every book carries every rule row, none of which
  it can change, and a catalogue fix reaches a book only when someone presses
  "load statutory rules" again.
- **Read the catalogue JSON into memory at run time** (what
  `catalogueRuleStore` does for reviews). This would run the derive code on
  every start, or move all of it into the JSON. Lookups join rules to
  provisions and filter by topic and date. In SQL they are queries, but in
  memory each would need its own index code.
- **A separate SQLite file, built once from the catalogue and the derive
  code**, and opened read-only next to the book. This is the decision below.

## Decision

1. **The store is `rules.db`, a SQLite file under `APP_ROOT`.**
   - Its path comes from `rulesStorePath()` in `src/lib/paths.ts`: by default
     `<APP_ROOT>/rules/rules.db`, overridable by `LEABHAR_RULES_DB` like every
     other path.
   - `scripts/build-package.mjs` builds it at package time, by running the
     existing derive pipeline against an empty store database instead of a
     book.
   - The installer owns it like any other binary. An upgrade replaces it with
     the new release's store, and an uninstall removes it. It never sits in
     `DATA_ROOT`, and it is never written after the build.
   - In development, `npm run rules:build` builds it under the working
     directory. Opening a store older than the catalogue it was built from
     fails loudly and names the command. Comparing size and modification time
     per entry, as `catalogueRuleStore` does, is enough to detect that.
2. **The book attaches the store read-only.**
   - `src/db/index.ts` runs `ATTACH 'file:…/rules.db?mode=ro' AS rules` on the
     book's connection.
   - The store's tables are the rule tables of today without `company_id`:
     sources, provisions, rules, rule tests and links. Readers query
     `rules.irish_tax_rules`.
   - Joins between the book's decisions and the store's rows stay single SQL
     queries.
   - A missing or unreadable store stops the app at start-up with a clear
     error. It never falls back to rules copied into the book.
3. **The catalogue's version number is the version ID.**
   - A store row's ID is `key@version` as the catalogue numbers it.
   - From the switch on, a book records only catalogue numbers, in decisions
     and in posted lines.
   - Releases never drop or change a shipped version (ADR-0020). The build
     enforces this: it compares the new store with
     `catalogue/released-versions.json`, the committed list of every
     `key@version` and its content hash from the last release. A missing or
     changed version fails the build.
   - The content hash covers what the rule says: its dates, quote, value and
     unit, conditions, exceptions and effects. It never covers the review. An
     approval or rejection changes who has read a version, not what the
     version says, so it ships in an update under the same version number and
     does not fail the build.
4. **A book keeps only what is its own.** That means:
   - its decisions (`irish_rule_decisions`, unchanged);
   - the version IDs its entries applied (already snapshotted on the lines);
   - its bindings to its own configuration. These move from columns on the
     rule row to a new book table, `irish_rule_bindings`: `company_id`,
     `rule_key`, `rule_version`, `tax_rate_id`, `vat_treatment_id`,
     effective-dated and append-only. `taxRateSync.ts` writes there.
5. **Every update is checked against the book.** The book records the
   signature of the last store it opened in `rules_store_seen`. On the first
   open of a different store, the app does three things:
   - It runs `checkCatalogueVersions`. A version the book references but the
     store lacks becomes a review item.
   - It raises review items for the keys whose versions changed between the
     two stores (ADR-0020 §7).
   - It records the new signature.

   Nothing is resolved to another version silently (AGENTS.md #7).
6. **Existing books migrate once, by content, without rewriting what they
   posted.** A code migration (it needs the store, so it cannot be SQL alone)
   runs after a backup (`src/domain/backup/backup.ts`):
   - **Map versions.** For each of the book's rule rows, it finds the store
     version that says the same thing: the same dates, quote, value and unit.
     Dates and quote alone (`catalogueVersionFor` today) are not enough. A
     corrected figure with the same dates and quote would map to the wrong
     version, and the map is append-only, so the match adds the value before
     the migration is written. It writes the
     pair to `irish_rule_version_map` (`company_id`, `rule_key`,
     `book_version`, `catalogue_version`), which is append-only. The two
     places that hold old version numbers, decisions and
     `vat_rule_versions`, are read through this map. Neither is rewritten:
     decisions are append-only and posted lines are evidence.
   - **Keep unmatched versions.** A book row with no store version saying the
     same thing (for example, a wording a later catalogue corrected) is kept.
     It is copied, frozen, into `irish_rule_versions_retained`, so any entry
     that applied it can still be explained, and it becomes a review item.
   - **Move bindings.** It copies `tax_rate_id` and `vat_treatment_id` to
     `irish_rule_bindings`.
   - **Stop writing the old copies.** Readers move to the store, and nothing
     writes the book's copied tables again.
   - **Drop them one release later, and only for a book that has opened the
     new store.** One release is the rollback window: the migration already
     runs after a backup, and the copied tables are what the previous release
     still reads. The drop migration refuses to run while `rules_store_seen`
     is empty, so a book that never opened the new store keeps its copies.
     The drop does not wait for review items to be cleared. A frozen version
     with no catalogue match is meant to stay a review item, and waiting for
     none to be outstanding would either block the drop for good or push
     someone to clear a real mismatch.
7. **"Load statutory rules" goes away.** A book no longer loads rules: it has
   the store the install shipped. `loadStatutoryRulesAction`, the CLI
   `load-kb` commands and the demo seed stop writing rules into the book. The
   derive pipeline becomes the store build.
8. **The provision viewer reads the store.**
   - Provisions and their sources come from `rules.irish_act_provisions` and
     `rules.irish_knowledge_sources`.
   - The official files and excerpts stay where the package already puts them
     (`APP_ROOT/catalogue`, `APP_ROOT/docs/statutes`).
   - The SHA-256 re-check reads those files as it does today.

## Consequences

**Easier**

- A catalogue fix or a shipped approval reaches every book on the next install.
  Nobody has to remember to reload.
- A book shrinks to what it owns. A backup no longer carries rule rows it
  cannot change.
- One version number everywhere. The version map is read only for entries
  posted before the switch.
- The derive code runs once, at build time, so start-up and the test database
  no longer pay for it on every company.

**Harder**

- A book depends on the store that ships with the app. ADR-0020 already
  accepted this. Decision 5 makes the dependency visible rather than silent.
- A backup restored on another install is explained by that install's store.
  The never-drop rule means a newer store still holds every version an older
  book used. A book restored on an *older* install may reference versions the
  store lacks, and decision 5 turns each into a review item.
- Tests need a store.
  - `createTestDatabase` builds it once per test run, into a temporary
    directory, and attaches it.
  - A test that ships its own catalogue (`effectiveReview.test.ts`) builds its
    own store.
- The package build gets slower by the time the derive pipeline takes, and it
  fails when a version is dropped or changed (decision 3).

**Forbidden**

- Writing to `rules.db` after the build.
- Copying store rows into a book.
- Falling back to a book's copied rules when the store is missing.
- Rewriting a posted line's `vat_rule_versions` or an earlier decision to the
  new numbering.

**Out of scope: practice-authored rules**

Sources carry a nullable `company_id` for "a practice's own Leabhar
implementation rule sources". None exist today, and this step builds nothing
for them. When one exists:

- **It belongs in the book**, never in `rules.db`. The installer owns the
  store and replaces it on every update, so a practice's rule written there
  would be lost.
- **It is read beside the store.** Each reader takes rules from both places.

So that this stays possible, the reader switch (Delivery step 3) must not
assume every rule comes from `rules.db`. Readers go through one function that
returns the rules a book can see. Today that is the store plus the book's
frozen versions in `irish_rule_versions_retained` (decision 6); later it
also includes the book's own rules. Building that second source waits
until a practice has a rule to put there.

## Delivery

Each step passes the gate alone:

1. **Store build.** `rulesStorePath`, `npm run rules:build`, the
   package-build step, the released-versions check, and a test that the store
   holds, by content, exactly what a freshly loaded book holds today.
2. **Book tables and migration.** `irish_rule_bindings`,
   `irish_rule_version_map`, `irish_rule_versions_retained`,
   `rules_store_seen`, and the migration in decision 6, tested on a book that
   holds a corrected version under a different number.
3. **Readers switch to the attached store.** These are the readers
   `ruleReviewResolver` already lists: lookups, figures, rate sync, rule page,
   audit, search, version comparison, provision page and `list-rules`. The
   review resolver loses its by-content match, except through the version map.
   Readers take rules through one function, not from `rules.db` directly. It
   returns the store's versions and the book's frozen versions in
   `irish_rule_versions_retained`, so a posted line that applied an old
   wording can still be explained. Practice-authored rules can be added to it
   later (see "Out of scope").
4. **Loading stops.** The action, the CLI commands and the seed stop writing
   rules into the book, and the update check in decision 5 replaces them.
5. **One release later,** drop the copied tables, in each book that has opened
   the new store (`rules_store_seen` is not empty).
