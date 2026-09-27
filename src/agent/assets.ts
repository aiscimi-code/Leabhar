import type { AppDatabase } from '@/db';
import { getFlag } from '@/cli/args';
import { parseAmount } from '@/domain/money';
import { registerFixedAsset, recordCarEmissions, transferFixedAsset, reconcileFixedAssets } from '@/domain/assets/register';

/** Fixed asset register commands (EPIC 22, issues #534, #466): the same domain functions the assets screen calls. */

export const ASSET_USAGE = `
Fixed assets (EPIC 22, issues #534, #466):
  register-asset --name <text> --category <category> --account <id> --date <date> --cost <euro> --by <name>
            [--life-months <n>] [--co2 <g/km> --co2-evidence <text>] [--description <text>]
                                         Register a purchase already posted to a fixed-asset account
  record-car-co2 --asset <id> --co2 <g/km> --evidence <text> --by <name> [--reason <text>]
                                         A car's CO2 emissions, which decide its allowances (TCA Part 11C)
  transfer-asset --asset <id> --to-account <id> --date <date> --reason <text> --by <name>
  reconcile-assets --as-of <date>        Fixed-asset and accumulated depreciation accounts against the register
`;

export const ASSET_COMMANDS = ['register-asset', 'record-car-co2', 'transfer-asset', 'reconcile-assets'] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

export function runAssetCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  switch (command) {
    case 'register-asset': {
      const co2 = getFlag(flags, 'co2');
      const life = getFlag(flags, 'life-months');
      return registerFixedAsset(db, {
        companyId, name: need(flags, 'name'), assetCategory: need(flags, 'category') as 'computer_equipment',
        accountId: need(flags, 'account'), purchaseDate: need(flags, 'date'), costMinor: parseAmount(need(flags, 'cost'), 'EUR'),
        usefulLifeMonths: life ? Number(life) : undefined, co2EmissionsGramsPerKm: co2 ? Number(co2) : null,
        co2EmissionsEvidence: getFlag(flags, 'co2-evidence') ?? null, description: getFlag(flags, 'description') ?? null,
        recordedBy: need(flags, 'by'),
      });
    }
    case 'record-car-co2':
      return recordCarEmissions(db, {
        companyId, assetId: need(flags, 'asset'), gramsPerKm: Number(need(flags, 'co2')), evidence: need(flags, 'evidence'),
        reason: getFlag(flags, 'reason'), recordedBy: need(flags, 'by'),
      });
    case 'transfer-asset':
      return transferFixedAsset(db, {
        companyId, assetId: need(flags, 'asset'), toAccountId: need(flags, 'to-account'), date: need(flags, 'date'),
        reason: need(flags, 'reason'), recordedBy: need(flags, 'by'),
      });
    case 'reconcile-assets':
      return reconcileFixedAssets(db, { companyId, asOf: need(flags, 'as-of') });
    default:
      throw new Error(`Unknown asset command: ${command}`);
  }
}
