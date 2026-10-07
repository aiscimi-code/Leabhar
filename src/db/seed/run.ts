import { openBook } from '../index';
import { seedDemoCompany, type DemoEntityType } from './demo';

/**
 * Seed the local database with a demo book (README §51, issue #283).
 * Safe to run against an empty database; it creates a new demo company each time.
 *
 * Variants:
 *   npm run db:seed
 *   npm run db:seed -- --sole-trader
 *   npm run db:seed -- --partnership
 */
function entityFromArgv(argv: string[]): DemoEntityType {
  if (argv.includes('--sole-trader') || argv.includes('--sole_trader')) return 'sole_trader';
  if (argv.includes('--partnership')) return 'partnership';
  const flagged = argv.find((a) => a.startsWith('--entity='));
  if (flagged) {
    const value = flagged.slice('--entity='.length);
    if (value === 'sole_trader' || value === 'sole-trader') return 'sole_trader';
    if (value === 'partnership') return 'partnership';
    if (value === 'company') return 'company';
    throw new Error(`Unknown demo entity "${value}". Use company, sole_trader, or partnership.`);
  }
  return 'company';
}

async function main(): Promise<void> {
  const entityType = entityFromArgv(process.argv.slice(2));
  const db = openBook();
  const result = await seedDemoCompany(db, { entityType });
  const label = entityType === 'sole_trader' ? 'sole trader'
    : entityType === 'partnership' ? 'partnership'
    : 'limited company';
  console.log(`Demo ${label} created.`);
  console.log(`  Company id:   ${result.companyId}`);
  console.log(`  Entity type:  ${result.entityType}`);
  console.log(`  Transactions: ${result.counts.transactions}`);
  console.log(`  Documents:    ${result.counts.documents}`);
  console.log(`  Suppliers:    ${result.counts.suppliers}`);
  console.log(`  Customers:    ${result.counts.customers}`);
  console.log(`  Statutes:     ${result.knowledgeBase.sourcesProcessed} sources ingested, `
    + `${result.knowledgeBase.rulesAfter} rules derived (/statutes is populated)`);
  console.log('');
  console.log('This data is labelled as demo data throughout the application.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
