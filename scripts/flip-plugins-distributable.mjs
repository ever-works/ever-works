#!/usr/bin/env node
/**
 * EW-693 / T10 — one-shot helper that flips every DISTRIBUTABLE plugin's
 * `package.json` from `private: true` (or missing `private` + missing
 * `publishConfig`) to:
 *
 *   "private": false,
 *   "publishConfig": {
 *     "access": "restricted",
 *     "registry": "https://registry.npmjs.org"
 *   },
 *
 * Idempotent. Run from the repo root with:
 *
 *   node scripts/flip-plugins-distributable.mjs            # apply
 *   node scripts/flip-plugins-distributable.mjs --dry-run  # preview only
 *
 * Distributable = the manifest's resolved `distribution` is `registry`
 * (mirrors `resolvePluginDistribution` from the SDK). Per user
 * directive 2026-06-03, plugins ship as PRIVATE — `publishConfig.access`
 * is hard-coded to `restricted`; flip it to `public` per plugin only
 * after explicit authorisation.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');
const pluginsDir = join(repoRoot, 'packages', 'plugins');

const dryRun = process.argv.includes('--dry-run');

function resolveDistribution(manifest) {
	if (manifest.distribution === 'core' || manifest.distribution === 'registry') {
		return manifest.distribution;
	}
	return manifest.systemPlugin === true ? 'core' : 'registry';
}

const expectedPublishConfig = {
	access: 'restricted',
	registry: 'https://registry.npmjs.org'
};

let flippedCount = 0;
let alreadyCount = 0;
let coreCount = 0;
let skippedCount = 0;
const report = [];

for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const dir = join(pluginsDir, entry.name);
	const pkgPath = join(dir, 'package.json');
	try {
		statSync(pkgPath);
	} catch {
		continue;
	}

	const raw = readFileSync(pkgPath, 'utf8');
	const pkg = JSON.parse(raw);
	const manifest = pkg?.everworks?.plugin ?? {};
	const dist = resolveDistribution(manifest);

	if (dist === 'core') {
		coreCount += 1;
		report.push({ name: pkg.name, action: 'skip (core)', dist });
		continue;
	}

	// distributable
	const currentPrivate = pkg.private;
	const currentPub = pkg.publishConfig;
	const needsPrivateFlip = currentPrivate !== false;
	const needsPubConfig =
		!currentPub ||
		currentPub.access !== expectedPublishConfig.access ||
		currentPub.registry !== expectedPublishConfig.registry;

	if (!needsPrivateFlip && !needsPubConfig) {
		alreadyCount += 1;
		report.push({ name: pkg.name, action: 'already correct', dist });
		continue;
	}

	if (!manifest.distribution) {
		// We left some plugins relying on default derivation. Make the
		// classification explicit on every distributable plugin so future
		// changes don't accidentally redefine the default.
		manifest.distribution = 'registry';
		if (!pkg.everworks) pkg.everworks = {};
		pkg.everworks.plugin = manifest;
	}

	pkg.private = false;
	pkg.publishConfig = { ...expectedPublishConfig };

	const serialized = JSON.stringify(pkg, null, '\t') + '\n';
	if (dryRun) {
		report.push({
			name: pkg.name,
			action: `would flip (private:${currentPrivate} → false)`,
			dist
		});
		skippedCount += 1;
	} else {
		writeFileSync(pkgPath, serialized);
		flippedCount += 1;
		report.push({
			name: pkg.name,
			action: `flipped (private:${currentPrivate} → false, +publishConfig)`,
			dist
		});
	}
}

console.log('\nEW-693 T10 — distributable plugin flip\n');
for (const row of report.sort((a, b) => a.name.localeCompare(b.name))) {
	console.log(`  ${row.name.padEnd(45)} ${row.action}`);
}
console.log(
	`\nSummary: ${flippedCount} flipped, ${alreadyCount} already correct, ${coreCount} core (skipped)` +
		(dryRun ? `, ${skippedCount} would-be flipped (dry run)` : '')
);
