import type { AppDatabase } from '@/db';
import { getFlag } from '@/cli/args';
import { parseAmount } from '@/domain/money';
import { parsePercent } from '@/domain/farm';
import {
  createProject, createSite, listProjects, listSites, registerSubcontractor, recordRctContract, recordContractNotification,
  notifyRctPayment, recordDeductionAuthorisation, payRctPayment, rctPeriod, fileRctReturn, payRctReturn, reconcileRct,
  listSubcontractors, listRctContracts, listRctPayments, requireProject,
} from '@/domain/construction';
import {
  createJob, allocateToProject, setProjectBudget, setOverheadRate, projectResult, projectProfitability, workInProgress,
  type ProjectCategory,
} from '@/domain/projects';

/** Construction and RCT commands (EPIC 26, issues #548, #549): the same domain functions the construction screen calls. */

export const CONSTRUCTION_USAGE = `
Construction and RCT (EPIC 26, issues #548, #549). Revenue's figures (rate, tax, deduction summary) are recorded as issued:
  add-project --code <code> --name <text> --from <date> [--customer <id>] --by <name>
  add-site --name <text> --address <text> [--eircode <code>] [--project <id|code>] --by <name>
  list-projects | list-sites | list-subcontractors | list-rct-contracts | list-rct-payments
  add-subcontractor --supplier <id> --tax-ref <ref> --evidence <text> --checked-by <name> --checked-on <date> --not-employee
  add-rct-contract --subcontractor <id> --site <id> --description <text> --value <euro> --from <date> [--to <date>]
           [--project <id|code>] [--labour-only] [--notified <date> --revenue-id <id>] --by <name>
  rct-contract-notified --contract <id> --date <date> --revenue-id <id>
  rct-notify-payment --contract <id> --invoice <id> --gross <euro> --date <date> --by <name>
  rct-deduction-authorisation --payment <id> --number <DA number> --rate 0|20|35 --tax <euro>
  rct-pay --payment <id> (--bank-transaction <id> | --date <date> [--bank-account <id>]) --by <name>
  rct-period --period <YYYY-MM>
  rct-return --period <YYYY-MM> --summary <euro> [--amended] --date <date> --by <name>
  rct-pay-return --period <YYYY-MM> (--bank-transaction <id> | --date <date> [--bank-account <id>]) --by <name>
  reconcile-rct --as-of <date>

Project and job costing (EPIC 27, issues #550, #551). --project takes an id or a code:
  add-job --project <id> --code <code> --name <text> --by <name>
  allocate-to-project --line <journal line id> --project <id> [--job <id>] --category income|labour|materials|contractors|other_direct|overheads
           --percent <n> --by <name>
  project-budget --project <id> --category <category> --amount <euro> --from <date> [--note <text>] --by <name>
  overhead-rate --project <id> --percent <n> --from <date> --basis <text> --by <name>
  project-result --project <id> --to <date> [--from <date>]
  project-profitability --from <date> --to <date>
  wip --as-of <date>
`;

export const CONSTRUCTION_COMMANDS = [
  'add-project', 'add-site', 'list-projects', 'list-sites', 'list-subcontractors', 'list-rct-contracts', 'list-rct-payments',
  'add-subcontractor', 'add-rct-contract', 'rct-contract-notified', 'rct-notify-payment', 'rct-deduction-authorisation', 'rct-pay',
  'rct-period', 'rct-return', 'rct-pay-return', 'reconcile-rct',
  'add-job', 'allocate-to-project', 'project-budget', 'overhead-rate', 'project-result', 'project-profitability', 'wip',
] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

export function runConstructionCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  const eur = (name: string) => parseAmount(need(flags, name), 'EUR');
  switch (command) {
    case 'add-project':
      return createProject(db, { companyId, code: need(flags, 'code'), name: need(flags, 'name'), startsOn: need(flags, 'from'), customerId: getFlag(flags, 'customer') ?? null, recordedBy: need(flags, 'by') });
    case 'add-site':
      return createSite(db, { companyId, name: need(flags, 'name'), address: need(flags, 'address'), eircode: getFlag(flags, 'eircode') ?? null, projectId: getFlag(flags, 'project') ?? null, recordedBy: need(flags, 'by') });
    case 'list-projects': return listProjects(db, companyId);
    case 'list-sites': return listSites(db, companyId);
    case 'list-subcontractors': return listSubcontractors(db, companyId);
    case 'list-rct-contracts': return listRctContracts(db, companyId);
    case 'list-rct-payments': return listRctPayments(db, companyId);
    case 'add-subcontractor':
      return registerSubcontractor(db, {
        companyId, supplierId: need(flags, 'supplier'), taxReference: need(flags, 'tax-ref'), identityEvidence: need(flags, 'evidence'),
        identityCheckedBy: need(flags, 'checked-by'), identityCheckedOn: need(flags, 'checked-on'), notEmployeeDeclared: flags.notEmployee === true,
      });
    case 'add-rct-contract':
      return recordRctContract(db, {
        companyId, subcontractorId: need(flags, 'subcontractor'), siteId: need(flags, 'site'), projectId: getFlag(flags, 'project') ?? null,
        description: need(flags, 'description'), estimatedValueMinor: eur('value'), startsOn: need(flags, 'from'), endsOn: getFlag(flags, 'to') ?? null,
        labourOnly: flags.labourOnly === true, notifiedOn: getFlag(flags, 'notified') ?? null, revenueContractId: getFlag(flags, 'revenue-id') ?? null,
        recordedBy: need(flags, 'by'),
      });
    case 'rct-contract-notified':
      return recordContractNotification(db, { companyId, contractId: need(flags, 'contract'), notifiedOn: need(flags, 'date'), revenueContractId: need(flags, 'revenue-id') });
    case 'rct-notify-payment':
      return notifyRctPayment(db, { companyId, contractId: need(flags, 'contract'), invoiceId: need(flags, 'invoice'), grossMinor: eur('gross'), notifiedOn: need(flags, 'date'), recordedBy: need(flags, 'by') });
    case 'rct-deduction-authorisation':
      return recordDeductionAuthorisation(db, {
        companyId, rctPaymentId: need(flags, 'payment'), number: need(flags, 'number'), rateBasisPoints: parsePercent(need(flags, 'rate')), rctMinor: eur('tax'),
      });
    case 'rct-pay':
      return payRctPayment(db, {
        companyId, rctPaymentId: need(flags, 'payment'), bankTransactionId: getFlag(flags, 'bank-transaction') ?? null,
        bankAccountId: getFlag(flags, 'bank-account') ?? null, date: getFlag(flags, 'date') ?? null, paidBy: need(flags, 'by'),
      });
    case 'rct-period':
      return rctPeriod(db, { companyId, period: need(flags, 'period') });
    case 'rct-return':
      return fileRctReturn(db, {
        companyId, period: need(flags, 'period'), summaryLiabilityMinor: eur('summary'), amended: flags.amended === true, filedOn: need(flags, 'date'), filedBy: need(flags, 'by'),
      });
    case 'rct-pay-return':
      return payRctReturn(db, {
        companyId, period: need(flags, 'period'), bankTransactionId: getFlag(flags, 'bank-transaction') ?? null,
        bankAccountId: getFlag(flags, 'bank-account') ?? null, date: getFlag(flags, 'date') ?? null, paidBy: need(flags, 'by'),
      });
    case 'reconcile-rct':
      return reconcileRct(db, { companyId, asOf: need(flags, 'as-of') });
    case 'add-job':
      return createJob(db, { companyId, projectId: requireProject(db, companyId, need(flags, 'project')).id, code: need(flags, 'code'), name: need(flags, 'name'), recordedBy: need(flags, 'by') });
    case 'allocate-to-project':
      return allocateToProject(db, {
        companyId, journalLineId: need(flags, 'line'), projectId: requireProject(db, companyId, need(flags, 'project')).id, jobId: getFlag(flags, 'job') ?? null,
        category: need(flags, 'category') as ProjectCategory, basisPoints: parsePercent(need(flags, 'percent')), recordedBy: need(flags, 'by'),
      });
    case 'project-budget':
      return setProjectBudget(db, {
        companyId, projectId: requireProject(db, companyId, need(flags, 'project')).id, category: need(flags, 'category') as ProjectCategory,
        amountMinor: eur('amount'), effectiveFrom: need(flags, 'from'), note: getFlag(flags, 'note') ?? null, recordedBy: need(flags, 'by'),
      });
    case 'overhead-rate':
      return setOverheadRate(db, {
        companyId, projectId: requireProject(db, companyId, need(flags, 'project')).id, rateBasisPoints: parsePercent(need(flags, 'percent')),
        effectiveFrom: need(flags, 'from'), basis: need(flags, 'basis'), recordedBy: need(flags, 'by'),
      });
    case 'project-result':
      return projectResult(db, { companyId, projectId: requireProject(db, companyId, need(flags, 'project')).id, to: need(flags, 'to'), from: getFlag(flags, 'from') });
    case 'project-profitability':
      return projectProfitability(db, { companyId, from: need(flags, 'from'), to: need(flags, 'to') });
    case 'wip':
      return workInProgress(db, { companyId, asOf: need(flags, 'as-of') });
    default:
      throw new Error(`Unknown construction command: ${command}`);
  }
}
