#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * Stage the SELF-CONTAINED runtime payload the installer ships.
 *
 * Before this existed, an installed desktop app still needed the developer's
 * monorepo checkout (plus Node.js and pnpm) on the user's machine: it resolved
 * the repo root two levels above the app and ran `pnpm dev:api` / `pnpm dev:web`
 * from it. That is not something you can hand to a user.
 *
 * This script assembles `apps/desktop/bundle/`:
 *
 *   bundle/
 *     bundle-manifest.json   <- describes what is inside (see runtime-layout.ts)
 *     api/                   <- `pnpm deploy` output: dist/ + production node_modules
 *     web/                   <- Next.js standalone server + static assets
 *
 * electron-builder copies that directory into `resources/app-bundle`, and the
 * app runs both entry points on Electron's own embedded Node.js
 * (`ELECTRON_RUN_AS_NODE`), so the install needs no host toolchain at all.
 *
 * DEGRADED MODE: when the platform build output is not present (a fast PR
 * packaging run, or a fork that skipped the platform build), the script writes
 * a `bundled: false` manifest and exits 0 with a LOUD warning. Packaging still
 * succeeds — the resulting app simply reports that local-stack mode is
 * unavailable and offers client mode instead.
 *
 * Usage:
 *   node scripts/prepare-bundle.js              # stage everything that is available
 *   node scripts/prepare-bundle.js --skip       # write a placeholder manifest only
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const BUNDLE_DIR = path.join(DESKTOP_DIR, 'bundle');
const MANIFEST_PATH = path.join(BUNDLE_DIR, 'bundle-manifest.json');

const API_ENTRY = path.join('api', 'dist', 'main.js');
const API_CWD = 'api';
/** Next.js standalone keeps the monorepo layout inside the output directory. */
const WEB_ENTRY = path.join('web', 'apps', 'web', 'server.js');
const WEB_CWD = path.join('web', 'apps', 'web');

function log(message) {
	console.log(`[prepare-bundle] ${message}`);
}

function warn(message) {
	// GitHub Actions renders `::warning` in the run summary; harmless locally.
	console.warn(`::warning title=Desktop runtime bundle::${message}`);
	console.warn(`[prepare-bundle] WARNING: ${message}`);
}

function version() {
	try {
		return JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8')).version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

function writeManifest(manifest) {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');
	log(`wrote ${MANIFEST_PATH}`);
}

function writePlaceholder(notes) {
	writeManifest({
		schema: 1,
		bundled: false,
		version: version(),
		generatedAt: new Date().toISOString(),
		notes
	});
	warn(
		`Packaged WITHOUT a platform runtime: ${notes}. The installer will build, but local-stack mode will be unavailable in the installed app (client mode still works).`
	);
}

function rmrf(target) {
	fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.cpSync(from, to, { recursive: true, dereference: true });
}

/**
 * `pnpm deploy` produces a standalone directory with real (non-symlinked)
 * production dependencies — the only supported way to lift one workspace
 * package out of a pnpm monorepo.
 */
function deployApi(target) {
	// `--legacy` is required by pnpm 10 unless the workspace opts into
	// `inject-workspace-packages`. Install scripts stay ENABLED so native
	// dependencies (better-sqlite3, bcrypt) are built for the target platform.
	const args = ['deploy', '--filter=ever-works-api', '--prod', '--legacy', target];
	// Prefer pnpm's own JS entry (set when this script runs through a pnpm
	// script): Node refuses to spawn `pnpm.cmd` on Windows without a shell,
	// and a shell would re-parse the arguments.
	const pnpmJs = process.env.npm_execpath;
	if (pnpmJs && pnpmJs.endsWith('.cjs')) {
		execFileSync(process.execPath, [pnpmJs, ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
		return;
	}
	execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
		cwd: REPO_ROOT,
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
}

function stageApi() {
	const apiDist = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'main.js');
	if (!fs.existsSync(apiDist)) {
		return { ok: false, reason: 'apps/api/dist/main.js is missing — run `pnpm build:api` first' };
	}

	const target = path.join(BUNDLE_DIR, API_CWD);
	rmrf(target);
	try {
		deployApi(target);
	} catch (error) {
		return { ok: false, reason: `pnpm deploy of ever-works-api failed: ${error.message}` };
	}

	// `pnpm deploy` copies the package's published files; make sure the built
	// output is present even when `files`/`.npmignore` excluded it.
	const deployedEntry = path.join(target, 'dist', 'main.js');
	if (!fs.existsSync(deployedEntry)) {
		copyDir(path.join(REPO_ROOT, 'apps', 'api', 'dist'), path.join(target, 'dist'));
	}
	if (!fs.existsSync(deployedEntry)) {
		return { ok: false, reason: 'the deployed API package has no dist/main.js' };
	}

	// Plugins are loaded from disk at runtime; ship them next to the API.
	const plugins = path.join(REPO_ROOT, 'plugins');
	if (fs.existsSync(plugins)) {
		copyDir(plugins, path.join(target, 'plugins'));
	}
	log(`staged API runtime at ${target}`);
	return { ok: true };
}

function stageWeb() {
	const standalone = path.join(REPO_ROOT, 'apps', 'web', '.next', 'standalone');
	const serverEntry = path.join(standalone, 'apps', 'web', 'server.js');
	if (!fs.existsSync(serverEntry)) {
		return {
			ok: false,
			reason: 'apps/web/.next/standalone/apps/web/server.js is missing — build the web app with NEXT_BUILD_OUTPUT=standalone'
		};
	}

	const target = path.join(BUNDLE_DIR, 'web');
	rmrf(target);
	copyDir(standalone, target);

	// The standalone server does not include the static assets or `public/`.
	const staticFrom = path.join(REPO_ROOT, 'apps', 'web', '.next', 'static');
	if (fs.existsSync(staticFrom)) {
		copyDir(staticFrom, path.join(target, 'apps', 'web', '.next', 'static'));
	}
	const publicFrom = path.join(REPO_ROOT, 'apps', 'web', 'public');
	if (fs.existsSync(publicFrom)) {
		copyDir(publicFrom, path.join(target, 'apps', 'web', 'public'));
	}
	log(`staged web runtime at ${target}`);
	return { ok: true };
}

function main() {
	const skip = process.argv.includes('--skip');
	log(`repo root: ${REPO_ROOT}`);
	log(`bundle dir: ${BUNDLE_DIR} (${os.platform()})`);

	if (skip) {
		rmrf(BUNDLE_DIR);
		writePlaceholder('staging was explicitly skipped (--skip)');
		return;
	}

	const api = stageApi();
	if (!api.ok) {
		writePlaceholder(api.reason);
		return;
	}
	const web = stageWeb();
	if (!web.ok) {
		writePlaceholder(web.reason);
		return;
	}

	writeManifest({
		schema: 1,
		bundled: true,
		version: version(),
		generatedAt: new Date().toISOString(),
		api: { entry: API_ENTRY.split(path.sep).join('/'), cwd: API_CWD },
		web: { entry: WEB_ENTRY.split(path.sep).join('/'), cwd: WEB_CWD.split(path.sep).join('/') }
	});
	log('runtime bundle is complete — the installer will be self-contained.');
}

main();
