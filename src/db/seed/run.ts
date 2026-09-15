import { createDatabase } from '../index';
import { runMigrations } from '../migrate';
import { seedDemoCompany } from './demo';

/**
 * Seed the local database with the demo company (README §51).
 * Safe to run against an empty database; it creates a new demo company each time.
 */
async function main(): Promise<void> {
  const db = createDatabase();
  runMigrations(db);
  const result = await seedDemoCompany(db);
  console.log('Demo company created.');
  console.log(`  Company id:   ${result.companyId}`);
  console.log(`  Transactions: ${result.counts.transactions}`);
  console.log(`  Documents:    ${result.counts.documents}`);
  console.log(`  Suppliers:    ${result.counts.suppliers}`);
  console.log(`  Customers:    ${result.counts.customers}`);
  console.log('');
  console.log('This data is labelled as demo data throughout the application.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
