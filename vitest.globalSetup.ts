/**
 * Build the rules store once per test run (ADR-0021, "Tests need a store"),
 * into a temporary directory, and point every test's book at it
 * (`LEABHAR_RULES_DB`, read by `rulesStorePath`). The build runs the released-
 * versions check, so a run fails as the package build would on a dropped or
 * changed version.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRulesStore } from './src/domain/rules/rulesStore';

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-rules-'));
  const path = join(dir, 'rules.db');
  buildRulesStore({ outPath: path });
  process.env.LEABHAR_RULES_DB = path;
  return () => rmSync(dir, { recursive: true, force: true });
}
