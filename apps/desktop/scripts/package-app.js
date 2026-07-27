#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * Package the desktop app with electron-builder, applying the code-signing
 * plan resolved from the environment.
 *
 * Signing material lives only in repository secrets; the packaging workflow
 * exports them as env vars. When they are absent — forks, pull requests from
 * forks, local builds — the plan degrades to an UNSIGNED build and prints a
 * loud warning rather than failing, so anyone can still build installers.
 *
 * Secret VALUES are never printed: only the names of what is missing.
 *
 * Usage:
 *   node scripts/package-app.js                 # current platform
 *   node scripts/package-app.js --os linux      # explicit target
 *   node scripts/package-app.js --os mac --dir  # unpacked directory only
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const SIGNING_PLAN_MODULE = path.join(DESKTOP_DIR, 'dist', 'services', 'signing-plan.js');

function fail(message) {
	console.error(`::error title=Desktop packaging::${message}`);
	process.exit(1);
}

/** Absolute path to electron-builder's CLI entry, read from its own `bin` field. */
function resolveElectronBuilderCli() {
	try {
		const pkgPath = require.resolve('electron-builder/package.json', { paths: [DESKTOP_DIR] });
		const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin;
		const relative = typeof bin === 'string' ? bin : bin['electron-builder'];
		return path.join(path.dirname(pkgPath), relative);
	} catch (error) {
		fail(`electron-builder is not installed in apps/desktop: ${error.message}`);
		return '';
	}
}

function parseArgs(argv) {
	const args = { os: undefined, dir: false, passthrough: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--os') {
			args.os = argv[index + 1];
			index += 1;
		} else if (arg.startsWith('--os=')) {
			args.os = arg.slice('--os='.length);
		} else if (arg === '--dir') {
			args.dir = true;
		} else {
			args.passthrough.push(arg);
		}
	}
	return args;
}

function main() {
	if (!fs.existsSync(SIGNING_PLAN_MODULE)) {
		fail(`${SIGNING_PLAN_MODULE} not found — run \`pnpm --filter ever-works-desktop build\` before packaging.`);
	}

	// Compiled from src/services/signing-plan.ts, which is unit-tested.
	const { resolveSigningPlan, platformToTargetOs, describeSigningPlan } = require(SIGNING_PLAN_MODULE);

	const args = parseArgs(process.argv.slice(2));
	const targetOs = args.os || platformToTargetOs(process.platform);
	if (!['win', 'mac', 'linux'].includes(targetOs)) {
		fail(`Unknown target OS "${targetOs}" — expected win, mac or linux.`);
	}

	const plan = resolveSigningPlan(targetOs, process.env);
	console.log(`[package-app] ${describeSigningPlan(plan)}`);
	if (plan.warning) {
		console.warn(`::warning title=Desktop code signing::${plan.warning}`);
		console.warn(`[package-app] ${plan.warning}`);
	}

	const builderArgs = ['--config', 'electron-builder.yml', `--${targetOs}`];
	if (args.dir) {
		builderArgs.push('--dir');
	}
	builderArgs.push(...plan.configArgs, ...args.passthrough);

	// Spawn electron-builder's CLI entry with the current Node binary rather
	// than the `.cmd`/shell wrapper: Node refuses to spawn `.cmd` files without
	// `shell: true`, and a shell would re-parse the arguments.
	const cli = resolveElectronBuilderCli();
	console.log(`[package-app] node ${path.basename(cli)} ${builderArgs.join(' ')}`);
	const result = spawnSync(process.execPath, [cli, ...builderArgs], {
		cwd: DESKTOP_DIR,
		stdio: 'inherit',
		env: { ...process.env, ...plan.env }
	});

	if (result.error) {
		fail(`electron-builder could not be started: ${result.error.message}`);
	}
	process.exit(result.status === null ? 1 : result.status);
}

main();
