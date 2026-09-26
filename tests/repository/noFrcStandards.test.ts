import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FRC standards (FRS 102, FRS 105 and their amendments) are copyright and
 * stay in the owner's private Google Drive folder only (#293). They were
 * removed from the tree in #294; this fails if a merge or a new import brings
 * them back. Pointer notes that cite FRS 102 by section are allowed.
 */
const ROOT = join(__dirname, '..', '..');
const FORBIDDEN = [
  /^docs\/statutes\/_inbox\/I\/(?!SOURCES\.txt$)/,
  /^docs\/statutes\/_inbox\/I-FRS-not-collected\/(?!SOURCES\.txt$)/,
  /leabhar-218-section-I\.zip$/,
  /FRS_10[25]_.*\.(pdf|md)$/i,
  /Amendments_FRS_.*\.(pdf|md)$/i,
  /frc-frs-10[25]-index\.html$/i,
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [relative(ROOT, path).split('\\').join('/')];
  });
}

describe('FRC standards are not in the repository (#293)', () => {
  it('has no FRS 102/105 copies under docs/', () => {
    const found = files(join(ROOT, 'docs')).filter((f) => FORBIDDEN.some((re) => re.test(f)));
    expect(found).toEqual([]);
  });
});
