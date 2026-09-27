import type { AppDatabase } from '@/db';
import { getFlag } from '@/cli/args';
import { parseAmount } from '@/domain/money';
import { parseQuantity } from '@/domain/inventory';
import {
  saveFarmProfile, farmProfile, addLandParcel, endLandParcel, farmedArea, parseHectares, createEnterprise,
  allocateJournalLine, removeAllocation, enterpriseGrossMargins, createAnimalGroup, listAnimalGroups, registerAnimal,
  recordLivestockEvent, transferLivestock, reverseLivestockEvent, headCounts, planLivestockValuation, postLivestockValuation,
  createPlanting, recordHarvest, cropReport, requireGroup, requireEnterprise, parsePercent,
  type EnterpriseKind, type LandTenure, type Species, type SimpleEventKind, type CropInputKind,
} from '@/domain/farm';

export { parsePercent };

/** Farm commands (EPIC 24, issues #539–#541): the same domain functions the farm screen calls. */

export const FARM_USAGE = `
Farm (EPIC 24, issues #539-#541). Areas are hectares (up to four decimals); --enterprise and --group take an id or a name:
  farm-profile --name <text> [--activity <id>] [--flock <number>] --by <name>
  add-parcel --ref <LPIS ref> --name <text> --hectares <n> --tenure owned|leased --from <date> [--to <date>]
           [--lessor <name> --rent <euro a year>] [--asset <id>] --by <name>
  end-parcel --parcel <id> --to <date>
  farmed-area --as-of <date>
  add-enterprise --name <text> --kind dairy|beef|sheep|tillage|horticulture|forestry|other --from <date> --by <name>
  allocate-line --line <journal line id> --enterprise <id> --percent <n> [--planting <id> --kind seed|fertiliser|chemicals|contractor|sales|other] --by <name>
  remove-allocation --allocation <id> --reason <text> --by <name>
  gross-margins --from <date> --to <date>
  add-animal-group --enterprise <id> --name <text> --species cattle|sheep|pigs|poultry|goats|horses|other --by <name>
  register-animal --tag <tag> --species <species> [--sex female|male|castrated_male] [--breed <text>] [--born <date>] [--dam <tag>] --by <name>
  livestock-event --kind opening|purchase|sale|birth|death --group <id> --date <date> (--head <n> | --animal <tag>)
           [--amount <euro>] [--invoice-line <id>] [--reason <cause of death>] --by <name>
  move-livestock --from <group> --to <group> --date <date> (--head <n> | --animal <tag>) --by <name>
  reverse-livestock-event --event <id> --date <date> --reason <text> --by <name>
  head-counts --as-of <date>
  value-livestock --date <date> --value "<group>=<euro per head>:<basis>;..." [--opening] [--post --by <name>]
  add-planting --enterprise <id> --parcel <id> --crop <text> [--variety <text>] --year <harvest year> --hectares <n> [--sown <date>] --by <name>
  record-harvest --planting <id> --date <date> --quantity <n> --unit <unit> --by <name>
  crop-report [--year <harvest year>]
`;

export const FARM_COMMANDS = [
  'farm-profile', 'add-parcel', 'end-parcel', 'farmed-area', 'add-enterprise', 'allocate-line', 'remove-allocation', 'gross-margins',
  'add-animal-group', 'register-animal', 'livestock-event', 'move-livestock', 'reverse-livestock-event', 'head-counts',
  'value-livestock', 'add-planting', 'record-harvest', 'crop-report',
] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

/** "Dairy cows=1100:Market value;Calves=200:Market value" into the valuation's values. */
export function parseLivestockValues(text: string): Record<string, { valuePerHeadMinor: number; basis: string }> {
  const out: Record<string, { valuePerHeadMinor: number; basis: string }> = {};
  for (const part of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.+?)=([\d.]+):(.+)$/.exec(part);
    if (!m) throw new Error(`--value takes <group>=<euro per head>:<basis>, not "${part}".`);
    out[m[1]!.trim()] = { valuePerHeadMinor: parseAmount(m[2]!, 'EUR'), basis: m[3]!.trim() };
  }
  return out;
}

export function runFarmCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  const by = () => need(flags, 'by');
  switch (command) {
    case 'farm-profile':
      saveFarmProfile(db, {
        companyId, farmName: need(flags, 'name'), tradingActivityId: getFlag(flags, 'activity') ?? null,
        flockNumber: getFlag(flags, 'flock') ?? null, recordedBy: by(),
      });
      return farmProfile(db, companyId);
    case 'add-parcel': {
      const rent = getFlag(flags, 'rent');
      return addLandParcel(db, {
        companyId, reference: need(flags, 'ref'), name: need(flags, 'name'), areaSqm: parseHectares(need(flags, 'hectares')),
        tenure: need(flags, 'tenure') as LandTenure, heldFrom: need(flags, 'from'), heldTo: getFlag(flags, 'to') ?? null,
        counterparty: getFlag(flags, 'lessor') ?? null, annualRentMinor: rent ? parseAmount(rent, 'EUR') : null,
        fixedAssetId: getFlag(flags, 'asset') ?? null, recordedBy: by(),
      });
    }
    case 'end-parcel':
      return endLandParcel(db, { companyId, parcelId: need(flags, 'parcel'), heldTo: need(flags, 'to') });
    case 'farmed-area':
      return farmedArea(db, { companyId, asOf: need(flags, 'as-of') });
    case 'add-enterprise':
      return createEnterprise(db, {
        companyId, name: need(flags, 'name'), kind: need(flags, 'kind') as EnterpriseKind, startedOn: need(flags, 'from'), recordedBy: by(),
      });
    case 'allocate-line':
      return allocateJournalLine(db, {
        companyId, journalLineId: need(flags, 'line'), enterpriseId: requireEnterprise(db, companyId, need(flags, 'enterprise')).id,
        basisPoints: parsePercent(need(flags, 'percent')), plantingId: getFlag(flags, 'planting') ?? null,
        inputKind: (getFlag(flags, 'kind') as CropInputKind | undefined) ?? null, recordedBy: by(),
      });
    case 'remove-allocation':
      removeAllocation(db, { companyId, allocationId: need(flags, 'allocation'), reason: need(flags, 'reason'), actor: by() });
      return { removed: need(flags, 'allocation') };
    case 'gross-margins':
      return enterpriseGrossMargins(db, { companyId, from: need(flags, 'from'), to: need(flags, 'to') });
    case 'add-animal-group':
      return createAnimalGroup(db, {
        companyId, enterpriseId: requireEnterprise(db, companyId, need(flags, 'enterprise')).id, name: need(flags, 'name'),
        species: need(flags, 'species') as Species, recordedBy: by(),
      });
    case 'register-animal':
      return registerAnimal(db, {
        companyId, tagNumber: need(flags, 'tag'), species: need(flags, 'species') as Species,
        sex: (getFlag(flags, 'sex') as 'female' | 'male' | 'castrated_male' | undefined) ?? null, breed: getFlag(flags, 'breed') ?? null,
        dateOfBirth: getFlag(flags, 'born') ?? null, damTag: getFlag(flags, 'dam') ?? null, recordedBy: by(),
      });
    case 'livestock-event': {
      const head = getFlag(flags, 'head');
      const amount = getFlag(flags, 'amount');
      return recordLivestockEvent(db, {
        companyId, kind: need(flags, 'kind') as SimpleEventKind, groupId: requireGroup(db, companyId, need(flags, 'group')).id,
        date: need(flags, 'date'), headCount: head ? Number(head) : undefined, animalId: getFlag(flags, 'animal') ?? null,
        amountMinor: amount ? parseAmount(amount, 'EUR') : null, invoiceLineId: getFlag(flags, 'invoice-line') ?? null,
        reason: getFlag(flags, 'reason') ?? null, recordedBy: by(),
      });
    }
    case 'move-livestock': {
      const head = getFlag(flags, 'head');
      return transferLivestock(db, {
        companyId, fromGroupId: requireGroup(db, companyId, need(flags, 'from')).id, toGroupId: requireGroup(db, companyId, need(flags, 'to')).id,
        date: need(flags, 'date'), headCount: head ? Number(head) : undefined, animalId: getFlag(flags, 'animal') ?? null, recordedBy: by(),
      });
    }
    case 'reverse-livestock-event':
      return reverseLivestockEvent(db, { companyId, eventId: need(flags, 'event'), date: need(flags, 'date'), reason: need(flags, 'reason'), recordedBy: by() });
    case 'head-counts': {
      const counts = headCounts(db, { companyId, asOf: need(flags, 'as-of') });
      return listAnimalGroups(db, companyId).map((g) => ({ group: g.name, species: g.species, headCount: counts.get(g.id) ?? 0 }));
    }
    case 'value-livestock': {
      const params = {
        companyId, date: need(flags, 'date'), opening: !!flags.opening, values: parseLivestockValues(need(flags, 'value')),
      };
      return flags.post ? postLivestockValuation(db, { ...params, postedBy: by() }) : planLivestockValuation(db, params);
    }
    case 'add-planting': {
      const sown = getFlag(flags, 'sown');
      return createPlanting(db, {
        companyId, enterpriseId: requireEnterprise(db, companyId, need(flags, 'enterprise')).id, parcelId: need(flags, 'parcel'),
        crop: need(flags, 'crop'), variety: getFlag(flags, 'variety') ?? null, harvestYear: Number(need(flags, 'year')),
        areaSqm: parseHectares(need(flags, 'hectares')), sownOn: sown ?? null, recordedBy: by(),
      });
    }
    case 'record-harvest':
      return recordHarvest(db, {
        companyId, plantingId: need(flags, 'planting'), harvestedOn: need(flags, 'date'), quantityMilli: parseQuantity(need(flags, 'quantity')),
        unit: need(flags, 'unit'), recordedBy: by(),
      });
    case 'crop-report': {
      const year = getFlag(flags, 'year');
      return cropReport(db, { companyId, harvestYear: year ? Number(year) : undefined });
    }
    default:
      throw new Error(`Unknown farm command: ${command}`);
  }
}
