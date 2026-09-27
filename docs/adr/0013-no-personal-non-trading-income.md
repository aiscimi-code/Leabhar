# 0013. Leabhar does not record an individual's non-trading income

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

A trading loss set against the individual's other income (TCA 1997 s.381)
depends on income the books do not hold: pensions, rents, employment income
and other income are wider than the business, and one book is one business
(ADR 0001). The same gap means a Form 11 produced by the app cannot total the
person's income: the return asks for non-trading income the app must flag as
unknown.

Issue #458 asked whether that is the product Leabhar wants to be, or whether
it should record per-individual, per-year non-trading income so it can
compute the s.381 relief's tax effect and produce a Form 11 whose
self-assessment reconciles to the person's whole income.

## Decision

**Keep the boundary (issue #458, option A). Leabhar does not record an
individual's non-trading income. Where the return needs it, it is flagged for
review, never computed.**

- **One book is one business (ADR 0001).** A person's pensions, rents,
  employment income and other income are not the business's transactions.
  Holding them turns the book into a personal tax file, with a separate trust
  statement for figures that do not come from the ledger.
- **Data minimisation.** A partnership book would hold each partner's private
  income, visible to every user of the book — exactly the data a partner may
  not want their co-partners to see, and against the GDPR work of EPIC 38
  (#342).
- **The PAYE epics do not need it.** #315 and #316 concern what the *employer*
  pays its employees, which is in the book's own payroll records — a different
  boundary from a proprietor's other income, so no shared data model is
  required.

## Consequences

- An **s.381 claim** stays a person's decision carrying their own amount
  (ADR 0011); the finding states that the tax saving is computed on the
  person's own return.
- The **Form 11** lists every panel for income outside the business —
  employment, pensions, rents, investment income, other income, chargeable
  gains — as
  *to be completed by [name]: not in these books*, and the self-assessment is
  marked **partial**: it reconciles only the trade's liability and is never
  presented as the person's total liability.
- The **accountant pack (#215)** surfaces those panels as review items, so
  the accountant sees exactly what is missing for each person. Until the pack
  exists, the Form 11's panels and findings carry the flag.
- If personal income is ever wanted, it belongs in a separate personal book —
  its own SQLite file, owned by the individual, importing each business's
  Form 11 figures — not inside a business's book. That can be a later epic
  without changing anything here.
