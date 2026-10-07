/**
 * Build the install-level rules store, `rules.db` (ADR-0021).
 *
 *   npm run rules:build                       # into rulesStorePath() (rules/rules.db in development)
 *   npm run rules:build -- --out <path>       # somewhere else (the package build)
 *   npm run rules:build -- --record-release   # also add new versions to catalogue/released-versions.json
 *
 * Fails, and writes nothing, when a released version is missing or says
 * something else (ADR-0021 §3). `--record-release` is for cutting a release:
 * it only ever adds versions to the list.
 */
import { relative } from 'node:path';
import { rulesStorePath } from '@/lib/paths';
import { buildRulesStore, recordReleasedVersions, RulesStoreBuildError } from '@/domain/rules/rulesStore';

/** A list of version IDs, shortened past ten. */
const listed = (ids: string[]) => (ids.length <= 10 ? ids.join(', ') : `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more`);

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt >= 0 ? args[outAt + 1] : rulesStorePath();
if (!outPath) {
  console.error('--out needs a path.');
  process.exit(1);
}

try {
  const build = buildRulesStore({ outPath });
  const shown = relative(process.cwd(), build.path);
  console.log(`Rules store built: ${shown.startsWith('..') ? build.path : shown} (${build.versions.size} rule versions, signature ${build.signature.slice(0, 12)}).`);
  if (args.includes('--record-release')) {
    const added = recordReleasedVersions(build);
    console.log(added.length === 0
      ? 'No new versions to record in catalogue/released-versions.json.'
      : `Recorded ${added.length} new version(s) in catalogue/released-versions.json: ${listed(added)}.`);
  } else if (build.added.length > 0) {
    console.log(`${build.added.length} version(s) no release has shipped yet: ${listed(build.added)}.`);
  }
} catch (e) {
  if (e instanceof RulesStoreBuildError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
