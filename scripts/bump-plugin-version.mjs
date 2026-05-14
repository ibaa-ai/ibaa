#!/usr/bin/env node
/**
 * Bumps the IBAA plugin version across every file that must stay in sync.
 * Two parallel plugin distributions (Claude Code, Codex CLI) share one
 * version line — same code, different hosts.
 *
 * Files updated:
 *   Claude Code:
 *     - plugin/.claude-plugin/plugin.json       (manifest)
 *     - .claude-plugin/marketplace.json         (plugins[0].version)
 *     - plugin/package.json                     (workspace package)
 *   Codex CLI:
 *     - plugin-codex/.codex-plugin/plugin.json  (manifest)
 *     - .agents/plugins/marketplace.json        (plugins[0].version)
 *
 * Usage:
 *   node scripts/bump-plugin-version.mjs patch   # 0.4.0 → 0.4.1
 *   node scripts/bump-plugin-version.mjs minor   # 0.4.0 → 0.5.0
 *   node scripts/bump-plugin-version.mjs major   # 0.4.0 → 1.0.0
 *   node scripts/bump-plugin-version.mjs 0.4.0   # set explicit version
 *
 * Why this matters:
 *   - Claude Code caches plugins by manifest version. Without a bump,
 *     `/plugin update ibaa@ibaa` reports "already at latest" and users
 *     never see new content.
 *   - Codex's marketplace cache behaves the same way — needs a version
 *     bump for `codex plugin marketplace upgrade` to pick up changes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const FILES = [
  // Claude Code distribution
  resolve(repoRoot, 'plugin/.claude-plugin/plugin.json'),
  resolve(repoRoot, '.claude-plugin/marketplace.json'),
  resolve(repoRoot, 'plugin/package.json'),
  // Codex CLI distribution
  resolve(repoRoot, 'plugin-codex/.codex-plugin/plugin.json'),
  resolve(repoRoot, '.agents/plugins/marketplace.json'),
];

function readVersion(path) {
  const obj = JSON.parse(readFileSync(path, 'utf-8'));
  if (path.endsWith('marketplace.json')) {
    return obj.plugins?.[0]?.version ?? null;
  }
  return obj.version ?? null;
}

function writeVersion(path, version) {
  const text = readFileSync(path, 'utf-8');
  const obj = JSON.parse(text);
  if (path.endsWith('marketplace.json')) {
    if (!obj.plugins?.[0]) {
      throw new Error(`${path}: no plugins[0] to update`);
    }
    obj.plugins[0].version = version;
  } else {
    obj.version = version;
  }
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function bump(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`unparseable version: ${current}`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { maj++; min = 0; pat = 0; }
  else if (kind === 'minor') { min++; pat = 0; }
  else if (kind === 'patch') { pat++; }
  else throw new Error(`unknown bump kind: ${kind}`);
  return `${maj}.${min}.${pat}`;
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: bump-plugin-version.mjs (patch|minor|major|x.y.z)');
  process.exit(1);
}

const current = readVersion(FILES[0]);
if (!current) {
  console.error('could not read current version from plugin/.claude-plugin/plugin.json');
  process.exit(1);
}

const next = /^\d+\.\d+\.\d+$/.test(arg) ? arg : bump(current, arg);

console.log(`bump: ${current} → ${next}`);
for (const f of FILES) {
  const before = readVersion(f);
  writeVersion(f, next);
  console.log(`  ${f.replace(repoRoot + '/', '')}: ${before} → ${next}`);
}

// Verify in-sync
const after = FILES.map(readVersion);
if (new Set(after).size !== 1) {
  console.error(`drift! ${JSON.stringify(after)}`);
  process.exit(1);
}
console.log(`ok. all ${FILES.length} files at ${next}.`);
console.log('next: commit + push.');
console.log('  - Claude Code users get the new version on /plugin update ibaa@ibaa.');
console.log('  - Codex users get it on `codex plugin marketplace upgrade`.');
