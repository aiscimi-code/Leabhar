# 0014. Take an employee's figures from the RPN and the statutory figures from the rules

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

EPIC 20 (#315, #526) computes PAYE, USC and PRSI on each pay date. The
figures come from two different authorities:

- **Employee figures.** Revenue determines each employee's tax credits,
  standard rate cut-off point and USC cut-off points for the year (S.I.
  345/2018 reg.4; S.I. 510/2018 reg.8), and sends them on a Revenue payroll
  notification (RPN). The employer "shall ensure that ... the information on
  that notification is used" (reg.6(3); USC reg.10(3)). An employer who works
  out credits from the employee's circumstances instead would override
  Revenue's own determination, including adjustments for other income and
  unpaid tax that the employer cannot see.
- **Statutory figures.** The PRSI rates and thresholds (SWCA 2005 s.13, as
  amended), the NTF levy, and the bands used on the emergency basis are the
  same for every employee. They change on dates the legislation fixes.

A payroll figure also cannot be skipped the way part of an income tax
estimate can (#451). A payslip deducts tax correctly or not at all.

## Decision

- Employee-specific figures come from the RPN in force on the pay date,
  never from the rules (`src/domain/payroll/compute.ts`). An RPN is immutable
  and superseded by a later one (`rpn.ts`).
- Until RPN retrieval exists (#528), an RPN is copied by hand from ROS and
  recorded as the person's entry. Every payslip it produces says so.
- With no RPN, the emergency basis applies (reg.19). It is the only place the
  engine uses the statutory bands to set an employee's cut-off.
- The statutory figures are curated rules with verbatim excerpts, dated from
  the instrument that sets them (`payrollCuration.ts`). They resolve through
  `resolveRuleFigure` like every other computation's figures.
- A figure a person rejected or retired, or one no rule states for the pay
  date, stops the payslip with the rule's finding (`PayrollFigures`). It never
  falls back to a shipped constant and never omits the deduction.
- Each payslip snapshots the RPN and rule figures it used (invariant 6).

## Consequences

- A payslip always agrees with Revenue's own determination for the employee,
  and a change of RPN corrects the year's tax through the cumulative basis
  rather than through a manual adjustment.
- Posting re-computes each payslip and refuses if anything changed since the
  draft was reviewed, so a new RPN or a rule decision never silently changes
  what is posted.
- The engine cannot run payroll for a year no rule covers. PRSI is only
  curated from 2025, because the €496 employer threshold's start date is not
  in the sources collected. It fails closed there rather than guessing.
- A hand-entered RPN can be mistyped. The finding on every payslip, and the
  RPN retrieval in #528, are the controls; nothing re-derives the credits to
  check them.
