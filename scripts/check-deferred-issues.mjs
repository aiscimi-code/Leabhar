#!/usr/bin/env node
/**
 * Fails when a coverage-matrix row is deferred to an issue that is closed
 * (issue #289). coverage.test.ts runs offline and cannot know issue state, so
 * this asks the GitHub API. It is not part of `npm test`; run it by hand or
 * from the "Deferred issues" workflow.
 *
 *   node scripts/check-deferred-issues.mjs            # uses GITHUB_REPOSITORY, GITHUB_TOKEN
 *   node scripts/check-deferred-issues.mjs owner/repo
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const matrixPath = fileURLToPath(new URL('../docs/rules/coverage-matrix.json', import.meta.url));
const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? 'aiscimi-code/Leabhar';
const token = process.env.GITHUB_TOKEN;

const { rows } = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byIssue = new Map();
for (const row of rows) {
  if (row.status !== 'deferred') continue;
  if (!Number.isInteger(row.issue)) {
    console.error(`Row ${row.id} is deferred with no issue number.`);
    process.exitCode = 1;
    continue;
  }
  byIssue.set(row.issue, [...(byIssue.get(row.issue) ?? []), row.id]);
}

for (const [issue, ids] of [...byIssue].sort((a, b) => a[0] - b[0])) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    console.error(`#${issue}: GitHub answered ${res.status}; cannot check ${ids.length} row(s).`);
    process.exitCode = 1;
    continue;
  }
  const { state } = await res.json();
  if (state === 'closed') {
    console.error(`#${issue} is closed but ${ids.length} row(s) defer to it: ${ids.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`#${issue} open, ${ids.length} row(s) deferred`);
  }
}
