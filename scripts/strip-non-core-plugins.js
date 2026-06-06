#!/usr/bin/env node
/**
 * EW-693 / T29 — strip non-core plugins from the built /app/deploy/plugins
 * tree when the image is built with PLUGIN_DISTRIBUTION_MODE=dynamic.
 *
 * Runs AFTER scripts/prepare-docker-plugins.js so the deploy plugins
 * dir is fully populated; this script deletes every directory whose
 * everworks.plugin manifest resolves to `distribution: 'registry'`
 * (i.e. NOT core / NOT systemPlugin). Core plugins stay because the
 * platform must boot even when no distributable plugin is enabled
 * (FR-4: local-fs as the default storage backend, etc.).
 *
 * Distribution classification mirrors the SDK's
 * `resolvePluginDistribution`:
 *   - manifest.distribution === 'core'     ⇒ core.
 *   - manifest.distribution === 'registry' ⇒ registry.
 *   - else: systemPlugin === true          ⇒ core.
 *   - else                                  ⇒ registry.
 *
 * Idempotent. Safe to run twice. Emits a one-line summary so the
 * Docker build log records exactly what was kept and what was dropped.
 */

const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = process.env.PLUGINS_DIR || '/app/deploy/plugins';

function resolveDistribution(manifest) {
	if (manifest.distribution === 'core' || manifest.distribution === 'registry') {
		return manifest.distribution;
	}
	return manifest.systemPlugin === true ? 'core' : 'registry';
}

function main() {
	if (!fs.existsSync(PLUGINS_DIR)) {
		console.log(`==> ${PLUGINS_DIR} not found — nothing to strip.`);
		return;
	}

	const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
	const kept = [];
	const removed = [];
	const skipped = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const pluginDir = path.join(PLUGINS_DIR, entry.name);
		const pkgJsonPath = path.join(pluginDir, 'package.json');
		if (!fs.existsSync(pkgJsonPath)) {
			skipped.push(`${entry.name} (no package.json)`);
			continue;
		}
		let pkg;
		try {
			pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
		} catch (err) {
			skipped.push(`${entry.name} (malformed package.json: ${err.message})`);
			continue;
		}
		const manifest = pkg?.everworks?.plugin ?? {};
		const dist = resolveDistribution(manifest);
		if (dist === 'core') {
			kept.push(pkg.name || entry.name);
			continue;
		}
		fs.rmSync(pluginDir, { recursive: true, force: true });
		removed.push(pkg.name || entry.name);
	}

	console.log(
		`==> EW-693 dynamic-mode image: stripped ${removed.length} registry plugin(s), kept ${kept.length} core plugin(s).`
	);
	if (kept.length > 0) console.log(`    Kept (core): ${kept.sort().join(', ')}`);
	if (removed.length > 0) console.log(`    Removed (registry): ${removed.sort().join(', ')}`);
	if (skipped.length > 0) console.log(`    Skipped: ${skipped.join(', ')}`);
}

main();
