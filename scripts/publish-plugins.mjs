#!/usr/bin/env node
/**
 * EW-693 / T12 — plugin publish orchestrator.
 *
 * Invokes `pnpm -F <plugin-name> publish` for every distributable
 * plugin under `packages/plugins/*`. A plugin is "distributable" iff
 * its manifest declares either `distribution: 'registry'` or
 * `systemPlugin !== true` (the default-derivation rule from
 * `@ever-works/plugin/contracts/plugin-manifest.types.ts`).
 *
 * Flags:
 *   --dry-run   Pass `--dry-run` to pnpm publish for each plugin.
 *               Resolves what would be published without touching
 *               either registry.
 *   --registry  Optional override URL (default: registry.npmjs.org).
 *               Use `https://npm.pkg.github.com` to publish to
 *               GitHub Packages instead. The workflow publishes to
 *               both registries by running this script twice with
 *               different `--registry` values.
 *   --tag       npm dist-tag (default: latest).
 *   --filter    Only operate on plugins whose package name matches
 *               this substring. Mainly for local debugging.
 *
 * Exit codes:
 *   0 — every distributable plugin published successfully (or no
 *       distributable plugins remain — vacuous truth).
 *   1 — one or more publishes failed; the first failing plugin's
 *       stderr is forwarded.
 *
 * IMPORTANT — privacy default (per user directive 2026-06-03):
 *   `--access` is read from each plugin's `publishConfig.access`,
 *   which is `restricted` by default. The orchestrator does NOT
 *   override this to `public`. To publish a plugin publicly, set
 *   `publishConfig.access: "public"` on that plugin's `package.json`
 *   explicitly + reviewer sign-off.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');
const pluginsDir = join(repoRoot, 'packages', 'plugins');

const args = parseArgs(process.argv.slice(2));

const distributable = listDistributablePlugins(pluginsDir);
const targets = args.filter
	? distributable.filter((p) => p.name.includes(args.filter))
	: distributable;

if (targets.length === 0) {
	console.error(
		`No distributable plugins matched filter=${JSON.stringify(args.filter ?? '<none>')}.`
	);
	process.exit(0);
}

console.log(
	`\nEW-693 publish — ${targets.length} distributable plugin(s)` +
		(args.dryRun ? ' [DRY RUN]' : '') +
		` → ${args.registry}\n`
);

const failed = [];
for (const plugin of targets) {
	const banner = `\n── ${plugin.name} @ ${plugin.version} (${plugin.dir})`;
	console.log(banner);

	const cli = ['-F', plugin.name, 'publish', '--no-git-checks', `--tag=${args.tag}`];
	if (args.registry) cli.push(`--registry=${args.registry}`);
	if (args.dryRun) cli.push('--dry-run');

	try {
		execFileSync('pnpm', cli, { cwd: repoRoot, stdio: 'inherit' });
	} catch (err) {
		failed.push({ name: plugin.name, error: String(err?.message ?? err) });
		console.error(`✖ ${plugin.name}: publish failed`);
	}
}

if (failed.length > 0) {
	console.error(`\n${failed.length} plugin(s) failed:`);
	for (const f of failed) console.error(`  - ${f.name}: ${f.error}`);
	process.exit(1);
}

console.log(`\n✔ All ${targets.length} distributable plugins published successfully.`);

// ─── helpers ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = {
		dryRun: false,
		registry: undefined,
		tag: 'latest',
		filter: undefined
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dry-run' || a === '-n') out.dryRun = true;
		else if (a === '--registry') out.registry = argv[++i];
		else if (a.startsWith('--registry=')) out.registry = a.slice('--registry='.length);
		else if (a === '--tag') out.tag = argv[++i];
		else if (a.startsWith('--tag=')) out.tag = a.slice('--tag='.length);
		else if (a === '--filter') out.filter = argv[++i];
		else if (a.startsWith('--filter=')) out.filter = a.slice('--filter='.length);
		else if (a === '--help' || a === '-h') {
			printHelp();
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${a}`);
			printHelp();
			process.exit(2);
		}
	}
	return out;
}

function printHelp() {
	console.log(
		[
			'EW-693 plugin publish orchestrator',
			'',
			'Usage: node scripts/publish-plugins.mjs [options]',
			'',
			'Options:',
			'  --dry-run, -n          Pass --dry-run to each pnpm publish',
			'  --registry <url>       Override the target registry',
			'                         (e.g. https://npm.pkg.github.com)',
			'  --tag <tag>            npm dist-tag (default: latest)',
			'  --filter <substring>   Only plugins whose package name matches',
			'  --help, -h             Show this help',
			''
		].join('\n')
	);
}

/**
 * EW-693 default-derivation rule, kept in sync with
 * `resolvePluginDistribution` in `@ever-works/plugin/contracts`:
 *   - `distribution` explicit ⇒ use it.
 *   - else `systemPlugin === true` ⇒ 'core'.
 *   - else 'registry'.
 */
function resolveDistribution(manifest) {
	if (manifest.distribution === 'core' || manifest.distribution === 'registry') {
		return manifest.distribution;
	}
	return manifest.systemPlugin === true ? 'core' : 'registry';
}

function listDistributablePlugins(root) {
	const entries = readdirSync(root, { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		const pkgPath = join(dir, 'package.json');
		try {
			statSync(pkgPath);
		} catch {
			continue;
		}
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		} catch (err) {
			console.error(`! Skip ${entry.name}: malformed package.json (${err.message})`);
			continue;
		}
		const manifest = pkg?.everworks?.plugin ?? {};
		const dist = resolveDistribution(manifest);
		if (dist !== 'registry') continue;
		if (pkg.private === true) {
			console.error(
				`! Skip ${pkg.name}: distribution=registry but private=true — flip private:false + add publishConfig before publishing.`
			);
			continue;
		}
		out.push({ name: pkg.name, version: pkg.version, dir });
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}
