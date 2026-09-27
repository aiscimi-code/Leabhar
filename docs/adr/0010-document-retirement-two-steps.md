# 0010. Documents are retired in two audited steps, and deletion is the only thing that removes a file

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The document repository's oldest rule (AGENTS.md #5, `documents.storage`) is
that a stored file is never modified. But EPIC 12 (issue #307) also requires
retention (#429) and deletion rules (#430): a book accumulates documents filed
by mistake, and a retention policy eventually makes documents eligible for
disposal. An accountant could reasonably ask for a way to remove a document
that does not mean deleting the evidence behind a posted figure — and the
tempting shortcut, "just delete the row and the file", would be wrong twice:
it can orphan an invoice's evidence, and the file is content-addressed, so
the same bytes can belong to more than one document.

## Decision

Retirement is two steps, both audited, both with a reason
(`src/domain/documents/lifecycle.ts`):

1. **Archive** (`archiveDocument`) — soft, reversible, refused while the
   document supports anything (`documentDependencies`: an invoice, a linked
   bank transaction, an accepted match). Archived documents leave the working
   lists but keep their rows and their file.
2. **Hard delete** (`deleteDocument`) — only on an already-archived document
   that supports nothing and that no other document points at as a duplicate.
   It removes the row and everything read from it, and removes the stored file
   only when no other row shares the same `storage_path`. A document still
   inside the retention period its policy sets (resolved as of its own date)
   cannot be deleted; it stays archived until the period has run out. The
   dependencies include an invoice or fixed asset created with the document
   as its evidence, not only the link recorded on the document row.

Retention (`src/domain/documents/retention.ts`) never deletes anything: it
resolves an effective-dated policy as of each document's own date and lists
documents past it; disposal is an explicit archive by a person
(`disposeDocumentAction`). No retention periods are seeded — that is the
owner's decision (issue #432).

A new permission, `documents.manage` (owner, director, accountant), governs
archive, restore and delete.

## Consequences

- Deleting a document that supports something is impossible by construction,
  not by convention: the guards run inside the transaction, and every
  refusal is a thrown, specific error.
- Duplicate handling stays honest: the original of a flagged duplicate cannot
  be deleted while the duplicate's record points at it, and the byte-identical
  file of another document is never removed.
- The audit trail outlives the document: the `deleted` event records the
  filename, hash and the reason, which is the only trace left once the
  evidence is gone.
- Two steps cost a click. That is accepted: deletion is permanent, and the
  archive step is where a person can still turn back.
