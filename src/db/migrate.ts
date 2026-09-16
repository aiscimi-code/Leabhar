import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDatabase } from './index';
import { migrationsFolder } from '@/lib/paths';

export function runMigrations(db = createDatabase()): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  console.log('Migrations applied.');
}
