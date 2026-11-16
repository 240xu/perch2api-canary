#!/usr/bin/env node
/**
 * Version self-check.
 *
 * Perch named three reasons for the earlier ban, and one of them was reporting a
 * client version that did not match the installed build. This prints the three
 * numbers that matter — what we claim, what is installed, what is published —
 * and exits non-zero on a claim/install mismatch so a deploy script can gate on
 * it.
 *
 *   node scripts/verify-version.mjs
 *   node scripts/verify-version.mjs --json
 */
import { checkCliVersion, latestPublishedVersion } from '../src/guard.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const skipNetwork = args.includes('--offline');

const local = checkCliVersion();
const latest = skipNetwork ? null : await latestPublishedVersion();

if (asJson) {
  console.log(JSON.stringify({ ...local, latest }, null, 2));
} else {
  console.log(`claimed (PERCH_CLI_VERSION) : ${local.claimed ?? '(empty -> "unknown")'}`);
  console.log(`installed (package.json)    : ${local.installed ?? '(not found)'}`);
  console.log(`published (npm latest)      : ${latest ?? '(not checked)'}`);
  console.log(`package.json                : ${local.file ?? '(not found)'}`);
  console.log(`verdict                     : ${local.level}`);
  console.log(`  ${local.message}`);
  if (latest && local.installed && latest !== local.installed) {
    console.log(`  note: installed ${local.installed} is behind published ${latest}; upgrade the CLI before bumping PERCH_CLI_VERSION.`);
  }
  console.log('');
  console.log('Rule: PERCH_CLI_VERSION must equal the installed version, or be empty (User-Agent then says "unknown", which real clients also emit).');
}

process.exit(local.level === 'mismatch' ? 1 : 0);
