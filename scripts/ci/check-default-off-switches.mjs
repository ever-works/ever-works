#!/usr/bin/env node
/**
 * App Works ships dormant: every App Works switch stays OFF in what this repository deploys.
 *
 * Scans the deploy manifests (`.deploy/k8s/*.yaml`), the compose files (`docker-compose*.yml`)
 * and the env examples (`.env.example`, `apps/<app>/.env.example`), and fails when one of the
 * switches below is set to anything but `false` (or left unset / empty). A value taken from a
 * Secret or ConfigMap (`valueFrom`) fails too: what a deploy file turns on must be readable here.
 *
 * Out of scope on purpose: the e2e workflows, which switch App Works on for their own ephemeral
 * stacks (that lane is App Works' own evidence), and the runtime environment of a live
 * installation, which is the operator's to set.
 *
 * Turning App Works on for an environment is a deliberate change: it edits this list or the
 * scanned file in the same pull request, and review sees it.
 *
 *   node scripts/ci/check-default-off-switches.mjs --self-test   # the scanner's own controls
 *   node scripts/ci/check-default-off-switches.mjs               # the repository
 *
 * No dependencies: the patterns these files use are line-shaped, and a parser package would add
 * an install step to a check that must run before anything else.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SWITCHES = [
	'EVER_WORKS_APP_WORKS_ENABLED',
	'APP_WORKS_CLOUD_PUSH_ENABLED',
	'EVER_WORKS_APP_LAUNCHER_ENABLED',
	'EVER_WORKS_APPS_MANAGED_ENABLED'
];

const unquote = (value) =>
	value
		.trim()
		.replace(/^(['"])(.*)\1$/, '$2')
		.trim();
const isOff = (value) => value === '' || value.toLowerCase() === 'false';

/** Kubernetes container env: `- name: SWITCH` followed by `value:` / `valueFrom:` within a few lines. */
function scanK8s(text) {
	const findings = [];
	const lines = text.split(/\r?\n/);
	lines.forEach((line, i) => {
		const m = line.match(/^\s*-\s*name:\s*['"]?([A-Z0-9_]+)['"]?\s*$/);
		if (!m || !SWITCHES.includes(m[1])) return;
		for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
			const next = lines[j];
			if (/^\s*-\s*name:/.test(next)) break;
			const value = next.match(/^\s*value:\s*(.*?)\s*(#.*)?$/);
			if (value) {
				const v = unquote(value[1]);
				if (!isOff(v)) findings.push({ line: j + 1, name: m[1], value: v });
				return;
			}
			if (/^\s*valueFrom:/.test(next)) {
				findings.push({ line: j + 1, name: m[1], value: '<valueFrom>' });
				return;
			}
		}
	});
	return findings;
}

/** Compose `environment:` in map form (`SWITCH: v`) or list form (`- SWITCH=v`). */
function scanCompose(text) {
	const findings = [];
	text.split(/\r?\n/).forEach((line, i) => {
		if (/^\s*#/.test(line)) return;
		const map = line.match(/^\s*['"]?([A-Z0-9_]+)['"]?\s*:\s*(.*?)\s*(#.*)?$/);
		const list = line.match(/^\s*-\s*['"]?([A-Z0-9_]+)=(.*?)['"]?\s*(#.*)?$/);
		const hit = list || map;
		if (!hit || !SWITCHES.includes(hit[1])) return;
		const v = unquote(hit[2]);
		if (!isOff(v)) findings.push({ line: i + 1, name: hit[1], value: v });
	});
	return findings;
}

/** dotenv: `SWITCH=v` (`export ` allowed); comments are prose, never a setting. */
function scanDotenv(text) {
	const findings = [];
	text.split(/\r?\n/).forEach((line, i) => {
		const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (!m || !SWITCHES.includes(m[1])) return;
		const v = unquote(m[2].replace(/\s+#.*$/, ''));
		if (!isOff(v)) findings.push({ line: i + 1, name: m[1], value: v });
	});
	return findings;
}

function targets(root) {
	const out = [];
	const k8s = path.join(root, '.deploy', 'k8s');
	if (existsSync(k8s)) {
		for (const f of readdirSync(k8s)) if (/\.ya?ml$/i.test(f)) out.push({ file: path.join(k8s, f), scan: scanK8s });
	}
	for (const f of readdirSync(root)) {
		if (/^docker-compose.*\.ya?ml$/i.test(f)) out.push({ file: path.join(root, f), scan: scanCompose });
	}
	if (existsSync(path.join(root, '.env.example')))
		out.push({ file: path.join(root, '.env.example'), scan: scanDotenv });
	const apps = path.join(root, 'apps');
	if (existsSync(apps)) {
		for (const a of readdirSync(apps)) {
			const env = path.join(apps, a, '.env.example');
			if (existsSync(env)) out.push({ file: env, scan: scanDotenv });
		}
	}
	return out;
}

function selfTest() {
	const cases = [
		['k8s value "true"', scanK8s, '        - name: EVER_WORKS_APP_WORKS_ENABLED\n          value: "true"\n', 1],
		['k8s value 1', scanK8s, '- name: APP_WORKS_CLOUD_PUSH_ENABLED\n  value: 1\n', 1],
		[
			'k8s valueFrom',
			scanK8s,
			'- name: EVER_WORKS_APP_LAUNCHER_ENABLED\n  valueFrom:\n    secretKeyRef: {name: s, key: k}\n',
			1
		],
		['k8s value "false"', scanK8s, '- name: EVER_WORKS_APP_WORKS_ENABLED\n  value: "false"\n', 0],
		['k8s other variable true', scanK8s, '- name: SOMETHING_ELSE_ENABLED\n  value: "true"\n', 0],
		[
			'k8s switch with no value line, next entry true',
			scanK8s,
			'- name: EVER_WORKS_APP_WORKS_ENABLED\n- name: X\n  value: "true"\n',
			0
		],
		[
			'compose map true',
			scanCompose,
			'services:\n  api:\n    environment:\n      EVER_WORKS_APPS_MANAGED_ENABLED: "true"\n',
			1
		],
		['compose list true', scanCompose, '    environment:\n      - EVER_WORKS_APP_WORKS_ENABLED=true\n', 1],
		['compose list false', scanCompose, '      - EVER_WORKS_APP_WORKS_ENABLED=false\n', 0],
		['compose comment', scanCompose, '      # EVER_WORKS_APP_WORKS_ENABLED: true would turn it on\n', 0],
		['dotenv true', scanDotenv, 'EVER_WORKS_APP_LAUNCHER_ENABLED=true\n', 1],
		['dotenv export TRUE', scanDotenv, 'export APP_WORKS_CLOUD_PUSH_ENABLED=TRUE\n', 1],
		['dotenv yes', scanDotenv, "EVER_WORKS_APP_WORKS_ENABLED='yes'\n", 1],
		['dotenv false', scanDotenv, 'EVER_WORKS_APP_WORKS_ENABLED=false\n', 0],
		['dotenv empty', scanDotenv, 'EVER_WORKS_APPS_MANAGED_ENABLED=\n', 0],
		['dotenv prose comment', scanDotenv, '# set EVER_WORKS_APP_WORKS_ENABLED=true to turn it on\n', 0]
	];
	let failed = 0;
	for (const [label, scan, text, expected] of cases) {
		const got = scan(text).length;
		const ok = got === expected;
		if (!ok) failed += 1;
		console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: expected ${expected} finding(s), got ${got}`);
	}
	if (failed) {
		console.error(`self-test: ${failed} control(s) failed`);
		process.exit(1);
	}
	console.log(`self-test: ${cases.length} controls passed`);
}

function main() {
	if (process.argv.includes('--self-test')) return selfTest();
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
	const files = targets(root);
	const k8sFiles = files.filter((t) => t.scan === scanK8s);
	// Vacuity guard: a moved directory must not turn this into a check of nothing.
	if (k8sFiles.length < 3) {
		console.error(`expected the .deploy/k8s manifests, found ${k8sFiles.length}`);
		process.exit(1);
	}
	let mentioned = 0;
	const findings = [];
	for (const { file, scan } of files) {
		const text = readFileSync(file, 'utf8');
		if (SWITCHES.some((s) => text.includes(s))) mentioned += 1;
		for (const f of scan(text)) findings.push({ ...f, file: path.relative(root, file).split(path.sep).join('/') });
	}
	if (mentioned === 0) {
		console.error('no scanned file mentions any App Works switch: the scan found nothing to check');
		process.exit(1);
	}
	if (findings.length) {
		console.error('App Works switches must stay off (false or unset) in deploy, compose and env example files:');
		for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.name} = ${f.value}`);
		process.exit(1);
	}
	console.log(`App Works switches off: ${files.length} files scanned, ${mentioned} mention a switch, 0 turned on.`);
}

main();
