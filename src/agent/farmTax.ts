import type { AppDatabase } from '@/db';
import { getFlag } from '@/cli/args';
import { parseAmount } from '@/domain/money';
import { recordCtDecision } from '@/domain/corporationTax/subjects';
import { parsePercent } from '@/domain/farm';
import {
  recordGrant, linkGrantReceipt, reconcileGrants, listGrants, recordFarmPartnershipRegistration, endFarmPartnershipRegistration,
  recordShareFarming, farmTaxSummary, type GrantKind, type FarmPartnershipRegister,
} from '@/domain/farmTax';

/** Farm tax and grants commands (EPIC 25, issues #543–#546): the same domain functions the farm tax screen calls. */

export const FARM_TAX_USAGE = `
Farm tax and grants (EPIC 25, issues #543-#546). Stock relief and income averaging are claims recorded with
ct-decide --subject-type farm_stock_relief|farm_income_averaging; the tax computations apply them:
  add-grant --scheme <text> --payer <text> --kind revenue|capital --awarded <euro> --date <date> [--asset <id>] [--ref <text>] --by <name>
  link-grant-receipt --grant <id> --line <journal line id> --by <name>
  list-grants | reconcile-grants --as-of <date>
  record-farm-profit --year <year> --profit <euro, a loss negative> --source <return or accounts> --by <name>
                                         A year before these books, for income averaging (s.657)
  farm-partnership-register --register registered_farm_partnership|succession_farm_partnership --id <identifier> --date <date> --by <name>
  end-farm-partnership-register --registration <id> --date <date>
  share-farming --counterparty <name> --land this_farm|counterparty [--parcels <id,id>] --output-share <%> --cost-share <%>
           --from <date> [--to <date>] --by <name>
  farm-tax-summary (--year <year> | --from <date> --to <date>)
`;

export const FARM_TAX_COMMANDS = [
  'add-grant', 'link-grant-receipt', 'list-grants', 'reconcile-grants', 'record-farm-profit', 'farm-partnership-register',
  'end-farm-partnership-register', 'share-farming', 'farm-tax-summary',
] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

/** A euro amount that may be negative: a loss. */
export function parseSignedEuro(text: string): number {
  const t = text.trim();
  return t.startsWith('-') ? -parseAmount(t.slice(1), 'EUR') : parseAmount(t, 'EUR');
}

export function runFarmTaxCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  switch (command) {
    case 'add-grant':
      return recordGrant(db, {
        companyId, scheme: need(flags, 'scheme'), payer: need(flags, 'payer'), kind: need(flags, 'kind') as GrantKind,
        awardedMinor: parseAmount(need(flags, 'awarded'), 'EUR'), awardedOn: need(flags, 'date'), fixedAssetId: getFlag(flags, 'asset') ?? null,
        reference: getFlag(flags, 'ref') ?? null, recordedBy: need(flags, 'by'),
      });
    case 'link-grant-receipt':
      return linkGrantReceipt(db, { companyId, grantId: need(flags, 'grant'), journalLineId: need(flags, 'line'), recordedBy: need(flags, 'by') });
    case 'list-grants':
      return listGrants(db, companyId);
    case 'reconcile-grants':
      return reconcileGrants(db, { companyId, asOf: need(flags, 'as-of') });
    case 'record-farm-profit': {
      const year = Number(need(flags, 'year'));
      if (!Number.isInteger(year)) throw new Error('--year is a year.');
      return {
        decisionId: recordCtDecision(db, {
          companyId, subjectType: 'farm_prior_profit', subjectId: companyId, periodEnd: `${year}-12-31`, choice: 'recorded',
          amountMinor: parseSignedEuro(need(flags, 'profit')), note: need(flags, 'source'), decidedBy: need(flags, 'by'),
        }),
      };
    }
    case 'farm-partnership-register':
      return recordFarmPartnershipRegistration(db, {
        companyId, register: need(flags, 'register') as FarmPartnershipRegister, identifier: need(flags, 'id'),
        registeredOn: need(flags, 'date'), recordedBy: need(flags, 'by'),
      });
    case 'end-farm-partnership-register':
      return endFarmPartnershipRegistration(db, { companyId, registrationId: need(flags, 'registration'), endedOn: need(flags, 'date') });
    case 'share-farming': {
      const parcels = getFlag(flags, 'parcels');
      return recordShareFarming(db, {
        companyId, counterparty: need(flags, 'counterparty'), landProvidedBy: need(flags, 'land') as 'this_farm' | 'counterparty',
        parcelIds: parcels ? parcels.split(',').map((s) => s.trim()).filter(Boolean) : [],
        outputShareBasisPoints: parsePercent(need(flags, 'output-share')), costShareBasisPoints: parsePercent(need(flags, 'cost-share')),
        startsOn: need(flags, 'from'), endsOn: getFlag(flags, 'to') ?? null, recordedBy: need(flags, 'by'),
      });
    }
    case 'farm-tax-summary': {
      const year = getFlag(flags, 'year');
      return farmTaxSummary(db, { companyId, year: year ? Number(year) : undefined, from: getFlag(flags, 'from'), to: getFlag(flags, 'to') });
    }
    default:
      throw new Error(`Unknown farm tax command: ${command}`);
  }
}
