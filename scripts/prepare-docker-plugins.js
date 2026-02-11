#!/usr/bin/env node

/**
 * Prepares built-in plugins for the Docker production image.
 * Runs after `pnpm deploy --filter=ever-works-api`.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLUGINS_SRC = path.resolve('/app/packages/plugins');
const DEPLOY_DIR = path.resolve('/app/deploy');
const PLUGINS_DEST = path.join(DEPLOY_DIR, 'plugins');
const DEPLOY_NODE_MODULES = path.join(DEPLOY_DIR, 'node_modules');

function main() {
	console.log('==> Preparing plugins for production...');

	stripDevDepsFromDeployPkgJson();

	fs.mkdirSync(PLUGINS_DEST, { recursive: true });

	if (!fs.existsSync(PLUGINS_SRC)) {
		console.log('==> No plugins source directory found, skipping.');
		return;
	}

	const pluginDirs = fs.readdirSync(PLUGINS_SRC, { withFileTypes: true }).filter((d) => d.isDirectory());

	let copiedCount = 0;
	const missingDeps = new Map();

	for (const dir of pluginDirs) {
		const pluginPath = path.join(PLUGINS_SRC, dir.name);
		const distPath = path.join(pluginPath, 'dist');
		const pkgJsonPath = path.join(pluginPath, 'package.json');

		if (!fs.existsSync(distPath) || !fs.existsSync(pkgJsonPath)) continue;

		const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
		if (!pkgJson.everworks?.plugin) continue;

		const destDir = path.join(PLUGINS_DEST, dir.name);
		fs.mkdirSync(destDir, { recursive: true });

		copyDirSync(distPath, path.join(destDir, 'dist'));

		// Minimal package.json — only fields the plugin loader needs at runtime
		const runtimePkg = {};
		for (const key of [
			'name',
			'version',
			'description',
			'main',
			'module',
			'types',
			'type',
			'exports',
			'everworks'
		]) {
			if (pkgJson[key] !== undefined) runtimePkg[key] = pkgJson[key];
		}
		fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');

		copiedCount++;
		console.log(`  -> Copied plugin: ${dir.name}`);

		collectMissingDeps(pkgJson.dependencies, missingDeps);
		collectMissingDeps(pkgJson.peerDependencies, missingDeps);
	}

	console.log(`==> Copied ${copiedCount} plugins`);

	if (missingDeps.size > 0) {
		const depsToInstall = Array.from(missingDeps.entries())
			.map(([name, version]) => `${name}@${version}`)
			.join(' ');

		console.log(`==> Installing ${missingDeps.size} missing plugin deps via pnpm...`);

		// Remove workspace marker so pnpm treats deploy dir as standalone
		try { fs.unlinkSync('/app/pnpm-workspace.yaml'); } catch {}
		// Ensure hoisting so plugins at /app/plugins/ can resolve deps
		fs.writeFileSync(path.join(DEPLOY_DIR, '.npmrc'), 'shamefully-hoist=true\n');

		try {
			execSync(`pnpm add ${depsToInstall}`, {
				cwd: DEPLOY_DIR,
				stdio: 'inherit',
			});
		} catch (error) {
			console.error('==> Failed to install plugin deps:', error.message);
			process.exit(1);
		}
	} else {
		console.log('==> All plugin deps already satisfied.');
	}

	console.log('==> Plugin preparation complete.');
}

/** Clean deploy/package.json: strip devDeps and workspace: protocol refs that npm can't resolve. */
function stripDevDepsFromDeployPkgJson() {
	const pkgPath = path.join(DEPLOY_DIR, 'package.json');
	if (!fs.existsSync(pkgPath)) return;

	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
	let changed = false;

	if (pkg.devDependencies) {
		delete pkg.devDependencies;
		changed = true;
	}

	for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
		if (!pkg[field]) continue;
		for (const [name, version] of Object.entries(pkg[field])) {
			if (String(version).startsWith('workspace:')) {
				delete pkg[field][name];
				changed = true;
			}
		}
	}

	if (changed) {
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
		console.log('==> Cleaned deploy/package.json (stripped devDeps + workspace: refs)');
	}
}

/** Collect non-workspace deps not already in deploy/node_modules. */
function collectMissingDeps(deps, missingDeps) {
	if (!deps) return;

	for (const [name, version] of Object.entries(deps)) {
		if (String(version).startsWith('workspace:')) continue;
		if (name.startsWith('@ever-works/') || name.startsWith('@packages/')) continue;
		if (missingDeps.has(name)) continue;

		const depPath = path.join(DEPLOY_NODE_MODULES, ...name.split('/'));
		if (fs.existsSync(depPath)) continue;

		missingDeps.set(name, version);
	}
}

function copyDirSync(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
	}
}

main();
