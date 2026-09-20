#!/usr/bin/env node
/**
 * Release the Ever Works npm packages — the plugin SDK (`@ever-works/plugin`),
 * the shared contracts (`@ever-works/contracts`) and every distributable
 * plugin under `packages/plugins/*` — to BOTH npmjs.org and GitHub Packages,
 * as PUBLIC packages, on every production build (`publish-plugins.yml`, push
 * to `main`).
 *
 * Why this exists: the previous orchestrator published whatever version sat in
 * each package.json. Nobody bumps those (every plugin has said 1.0.0 since
 * 2026-06), so the only publish that ever happened was the manual one on
 * 2026-06-06, and both registries have served June code ever since.
 *
 * VERSIONING — content-addressed, never by hand:
 *   - Each package gets a fingerprint: sha256 over the exact files `npm pack`
 *     would ship, with package.json normalised (its own version and the
 *     versions of sibling @ever-works packages blanked out).
 *   - The fingerprint is published inside the manifest as
 *     `everworksRelease.contentHash`.
 *   - If the highest version already published carries the same fingerprint,
 *     nothing changed: that version is reused (and back-filled into any
 *     registry that is missing it).
 *   - Otherwise a new version is cut: the package.json version when it is
 *     ahead of everything published (a deliberate minor/major bump, by hand or
 *     by a pending .changeset/*.md that names the package — applied here, NOT
 *     via `changeset version`, which would major-bump every SDK peer
 *     dependent), else the next PATCH of the highest published version.
 *   So an unchanged package is never republished, a changed one always is,
 *   and package.json keeps owning major.minor.
 *
 * Sibling dependencies are published as caret ranges (`^<version released in
 * this run>`), not pnpm's exact `workspace:*` pin, so a plugin keeps resolving
 * when the SDK moves by a patch.
 *
 * Usage (from the repo root, after `pnpm build:plugins`):
 *   node scripts/release-npm-packages.mjs --plan       # decide versions only
 *   node scripts/release-npm-packages.mjs --dry-run    # + pack + npm publish --dry-run
 *   node scripts/release-npm-packages.mjs              # publish for real
 *
 * Options:
 *   --registries=npm,github   Registries to publish to (default: both).
 *   --filter=<substring>      Only packages whose name contains it (plus nothing
 *                             else — the dependency order is still honoured).
 *   --tag=<dist-tag>          npm dist-tag (default: latest).
 *   --no-provenance           Do not request npm provenance.
 *
 * Environment:
 *   NPM_TOKEN      npmjs.org granular token with read+write on @ever-works.
 *                  npm tries trusted publishing (OIDC) first and falls back to
 *                  it, so packages with a trusted publisher do not need it.
 *   GITHUB_TOKEN   GitHub Packages token (`packages: write`).
 *   GITHUB_REPOSITORY / GITHUB_SHA / GITHUB_STEP_SUMMARY / GITHUB_ACTIONS /
 *   ACTIONS_ID_TOKEN_REQUEST_URL   Provided by GitHub Actions.
 *
 * Exit code 1 when any package failed to reach any selected registry.
 *
 * Docs: docs/devops/github-workflows-deep-dive.md (npm Package Publish Workflow);
 * internal runbook: Workspace/knowledge/infrastructure/EVER_WORKS_NPM.md
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Always released, in addition to the distributable plugins. */
export const CORE_PACKAGE_DIRS = ['packages/contracts', 'packages/plugin'];

export const REGISTRIES = {
	npm: { id: 'npm', url: 'https://registry.npmjs.org', tokenEnv: 'NPM_TOKEN' },
	github: { id: 'github', url: 'https://npm.pkg.github.com', tokenEnv: 'GITHUB_TOKEN' }
};

const DEP_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ALL_DEP_SECTIONS = [...DEP_SECTIONS, 'devDependencies'];

// ─── semver (X.Y.Z[-pre], enough for our own versions) ──────────────────────

const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version) {
	const m = SEMVER_RE.exec(String(version ?? '').trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		prerelease: m[4] ? m[4].split('.') : []
	};
}

export function compareSemver(a, b) {
	const pa = typeof a === 'string' ? parseSemver(a) : a;
	const pb = typeof b === 'string' ? parseSemver(b) : b;
	if (!pa || !pb) throw new Error(`Cannot compare non-semver versions ${a} / ${b}`);
	for (const k of ['major', 'minor', 'patch']) {
		if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
	}
	// A release outranks any of its prereleases.
	if (!pa.prerelease.length && !pb.prerelease.length) return 0;
	if (!pa.prerelease.length) return 1;
	if (!pb.prerelease.length) return -1;
	const n = Math.max(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < n; i++) {
		const x = pa.prerelease[i];
		const y = pb.prerelease[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) {
			if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
		} else if (xn !== yn) {
			return xn ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

export function incPatch(version) {
	const p = parseSemver(version);
	if (!p) throw new Error(`Cannot bump non-semver version ${version}`);
	// 1.2.3 -> 1.2.4; a prerelease 1.2.4-rc.1 -> its release 1.2.4.
	return p.prerelease.length ? `${p.major}.${p.minor}.${p.patch}` : `${p.major}.${p.minor}.${p.patch + 1}`;
}

/** Highest non-prerelease version in the list, or null. */
export function maxStable(versions) {
	let best = null;
	for (const v of versions) {
		const p = parseSemver(v);
		if (!p || p.prerelease.length) continue;
		if (best === null || compareSemver(v, best) > 0) best = v;
	}
	return best;
}

/** Apply a changeset bump type to a version. */
export function bumpVersion(version, type) {
	const p = parseSemver(version);
	if (!p) throw new Error(`Cannot bump non-semver version ${version}`);
	if (type === 'major') return `${p.major + 1}.0.0`;
	if (type === 'minor') return `${p.major}.${p.minor + 1}.0`;
	if (type === 'patch') return incPatch(version);
	return version;
}

const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * Bumps declared by pending (committed, not yet versioned) changesets:
 * package name → highest bump type any changeset names for it. Only the
 * packages a changeset NAMES are bumped. `pnpm changeset version` would also
 * bump every dependent — and every PEER dependent to a MAJOR when the SDK
 * takes a minor — which is not what an additive SDK change means.
 *
 * @param {Array<string>} contents  raw .changeset/*.md files (README excluded)
 */
export function parseChangesetBumps(contents) {
	const bumps = new Map();
	for (const text of contents) {
		const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!m) continue;
		for (const line of m[1].split(/\r?\n/)) {
			const e = /^\s*['"]?([^'":]+?)['"]?\s*:\s*['"]?(major|minor|patch|none)['"]?\s*$/.exec(line);
			if (!e) continue;
			const [, name, type] = e;
			if (BUMP_RANK[type] > BUMP_RANK[bumps.get(name) ?? 'none']) bumps.set(name, type);
		}
	}
	return bumps;
}

function readChangesetBumps() {
	const dir = join(REPO_ROOT, '.changeset');
	if (!existsSync(dir)) return new Map();
	const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
	return parseChangesetBumps(files.map((f) => readFileSync(join(dir, f), 'utf8')));
}

// ─── version decision ───────────────────────────────────────────────────────

/**
 * @param {object}   input
 * @param {string}   input.repoVersion   package.json version (after any Changesets bump)
 * @param {string}   input.fingerprint   content fingerprint of what would ship now
 * @param {Array<{versions: Record<string, object>, burned?: string[]}>} input.registries
 *        readable registry states; `versions` maps version → published manifest,
 *        `burned` lists versions that were published once and then unpublished
 *        (npm never lets such a number be used again)
 * @returns {{version: string, reason: string, changed: boolean}}
 */
export function resolveTargetVersion({ repoVersion, fingerprint, registries }) {
	if (!parseSemver(repoVersion)) throw new Error(`package.json version "${repoVersion}" is not semver`);
	const published = new Set();
	for (const r of registries) for (const v of Object.keys(r.versions ?? {})) published.add(v);
	const taken = new Set(published);
	for (const r of registries) for (const v of r.burned ?? []) taken.add(v);
	const highest = maxStable([...published]);

	if (highest) {
		const sameContent = registries.some(
			(r) => r.versions?.[highest]?.everworksRelease?.contentHash === fingerprint
		);
		// A number unpublished on any registry can never be (re)published there,
		// so reusing it would fail on that registry forever: cut a new one.
		const burnedSomewhere = registries.some((r) => (r.burned ?? []).includes(highest));
		if (sameContent && !burnedSomewhere) {
			return { version: highest, reason: `unchanged since ${highest}`, changed: false };
		}
	}

	const ahead = highest === null || compareSemver(repoVersion, highest) > 0;
	if (ahead && !taken.has(repoVersion)) {
		return {
			version: repoVersion,
			reason: highest ? `package.json ${repoVersion} is ahead of published ${highest}` : 'first release',
			changed: true
		};
	}

	// A deliberate bump whose own number is burned continues on its line.
	const base = ahead ? repoVersion : highest;
	let next = incPatch(base);
	while (taken.has(next)) next = incPatch(next);
	return { version: next, reason: `content changed since ${base}`, changed: true };
}

// ─── manifest rewriting ─────────────────────────────────────────────────────

/** `workspace:` specifier → a publishable range for the resolved version. */
export function workspaceRange(spec, version) {
	const s = String(spec).slice('workspace:'.length);
	if (s === '*' || s === '^' || s === '') return `^${version}`;
	if (s === '~') return `~${version}`;
	// `workspace:^1.2.0`, `workspace:1.2.0`, … — keep the explicit range.
	return s;
}

/**
 * Build the manifest that actually ships.
 *
 * @param {object} pkg              source package.json
 * @param {object} ctx
 * @param {string} ctx.version      version to publish
 * @param {Map<string,string>} ctx.releaseVersions  name → version for every package in this release
 * @param {Set<string>} ctx.workspaceNames          every package name in the monorepo
 * @param {string} ctx.repositoryUrl                e.g. https://github.com/ever-works/ever-works
 * @param {string} ctx.directory                    package dir relative to the repo root (posix)
 */
export function buildPublishManifest(pkg, ctx) {
	const out = structuredClone(pkg);
	out.version = ctx.version;

	for (const section of ALL_DEP_SECTIONS) {
		const deps = out[section];
		if (!deps) continue;
		for (const [name, spec] of Object.entries(deps)) {
			const internal = ctx.workspaceNames.has(name);
			const isWorkspaceSpec = typeof spec === 'string' && spec.startsWith('workspace:');
			if (!internal && !isWorkspaceSpec) {
				if (typeof spec === 'string' && /^(link|file|portal|catalog):/.test(spec)) {
					throw new Error(`${pkg.name}: ${section}.${name} uses "${spec}", which cannot be published`);
				}
				continue;
			}
			const released = ctx.releaseVersions.get(name);
			if (released) {
				deps[name] = isWorkspaceSpec ? workspaceRange(spec, released) : spec;
			} else if (section === 'devDependencies') {
				// Consumers never install devDependencies; drop the internal ones
				// rather than ship an unresolvable `workspace:` specifier.
				delete deps[name];
			} else {
				throw new Error(
					`${pkg.name}: ${section}.${name} is a workspace package that is not part of the npm release. ` +
						`Publish it too (CORE_PACKAGE_DIRS / plugin distribution) or remove the dependency.`
				);
			}
		}
		if (Object.keys(deps).length === 0) delete out[section];
	}

	// Registry, access and dist-tag are decided per publish on the command line
	// (a CLI flag outranks publishConfig, but a `registry` or `access` left in
	// the tarball would still leak into any manual republish of it).
	if (out.publishConfig) {
		delete out.publishConfig.registry;
		delete out.publishConfig.access;
		delete out.publishConfig.tag;
		if (Object.keys(out.publishConfig).length === 0) delete out.publishConfig;
	}

	// npm provenance verifies repository.url against the building repo, and
	// GitHub Packages links the package to its repo through it.
	if (ctx.repositoryUrl) {
		out.repository = {
			type: 'git',
			url: `git+${ctx.repositoryUrl}.git`,
			directory: ctx.directory
		};
		out.homepage ??= `${ctx.repositoryUrl}/tree/main/${ctx.directory}#readme`;
		out.bugs ??= { url: `${ctx.repositoryUrl}/issues` };
	}
	return out;
}

// ─── fingerprint ────────────────────────────────────────────────────────────

export function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

/** The manifest minus everything that changes without the package changing. */
export function normalizeManifestForFingerprint(manifest, releaseNames) {
	const m = structuredClone(manifest);
	delete m.version;
	delete m.everworksRelease;
	delete m.gitHead;
	for (const section of ALL_DEP_SECTIONS) {
		for (const name of Object.keys(m[section] ?? {})) {
			if (releaseNames.has(name)) m[section][name] = '<release>';
		}
	}
	return m;
}

/**
 * @param {Array<{path: string, sha256: string}>} files  shipped files except package.json
 * @param {object} normalizedManifest
 */
export function computeFingerprint(files, normalizedManifest) {
	const h = createHash('sha256');
	for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		h.update(`${f.path}\0${f.sha256}\n`);
	}
	h.update(`package.json\0${stableStringify(normalizedManifest)}\n`);
	return `sha256:${h.digest('hex')}`;
}

/**
 * package.json out of an npm tarball (.tgz). Used when a registry's packument
 * does not carry our custom `everworksRelease` field: npmjs.org keeps every
 * package.json field in the full packument, GitHub Packages is not documented
 * to — but the tarball is always byte-for-byte what was published.
 */
export function readPackageJsonFromTarball(tgz) {
	const tar = gunzipSync(tgz);
	let offset = 0;
	let paxPath = null;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;
		const field = (start, len) =>
			header
				.subarray(start, start + len)
				.toString('utf8')
				.replace(/\0[\s\S]*$/, '');
		const prefix = field(345, 155);
		const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
		const size = parseInt(field(124, 12).trim() || '0', 8);
		const type = field(156, 1);
		const data = tar.subarray(offset + 512, offset + 512 + size);
		if (type === 'x') {
			paxPath = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
		} else {
			const path = paxPath ?? name;
			paxPath = null;
			const parts = path.split('/');
			if ((type === '0' || type === '') && parts.length === 2 && parts[1] === 'package.json') {
				return JSON.parse(data.toString('utf8'));
			}
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return null;
}

// ─── packaging checks ───────────────────────────────────────────────────────

/** Every file path the manifest promises (main/module/types/bin/exports). */
export function entryPointTargets(manifest) {
	const out = new Set();
	const add = (v) => {
		if (typeof v !== 'string') return;
		if (v.includes('*')) return; // subpath patterns are not single files
		out.add(v.replace(/^\.\//, ''));
	};
	for (const k of ['main', 'module', 'types', 'typings']) add(manifest[k]);
	if (typeof manifest.bin === 'string') add(manifest.bin);
	else if (manifest.bin && typeof manifest.bin === 'object') Object.values(manifest.bin).forEach(add);
	const walk = (node) => {
		if (typeof node === 'string') add(node);
		else if (Array.isArray(node)) node.forEach(walk);
		else if (node && typeof node === 'object') Object.values(node).forEach(walk);
	};
	walk(manifest.exports);
	return [...out];
}

// ─── ordering ───────────────────────────────────────────────────────────────

/** Dependencies before dependents; throws on a cycle. */
export function topoSort(packages) {
	const byName = new Map(packages.map((p) => [p.name, p]));
	const state = new Map();
	const order = [];
	const visit = (p, trail) => {
		const s = state.get(p.name);
		if (s === 'done') return;
		if (s === 'visiting') throw new Error(`Dependency cycle: ${[...trail, p.name].join(' -> ')}`);
		state.set(p.name, 'visiting');
		for (const section of DEP_SECTIONS) {
			for (const dep of Object.keys(p.json[section] ?? {})) {
				const d = byName.get(dep);
				if (d && d !== p) visit(d, [...trail, p.name]);
			}
		}
		state.set(p.name, 'done');
		order.push(p);
	};
	for (const p of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(p, []);
	return order;
}

// ─── discovery ──────────────────────────────────────────────────────────────

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/** Mirrors `resolvePluginDistribution` in @ever-works/plugin/contracts. */
export function resolveDistribution(manifest) {
	if (manifest?.distribution === 'core' || manifest?.distribution === 'registry') return manifest.distribution;
	return manifest?.systemPlugin === true ? 'core' : 'registry';
}

function listPackageDirs(parent) {
	const abs = join(REPO_ROOT, parent);
	if (!existsSync(abs)) return [];
	return readdirSync(abs, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(abs, e.name, 'package.json')))
		.map((e) => `${parent}/${e.name}`);
}

export function discoverPackages(log = console) {
	const workspaceNames = new Set();
	for (const dir of [
		...listPackageDirs('apps'),
		...listPackageDirs('packages'),
		...listPackageDirs('packages/plugins')
	]) {
		const name = readJson(join(REPO_ROOT, dir, 'package.json')).name;
		if (name) workspaceNames.add(name);
	}

	const release = [];
	for (const dir of CORE_PACKAGE_DIRS) {
		const json = readJson(join(REPO_ROOT, dir, 'package.json'));
		if (json.private === true) throw new Error(`${dir} is private but part of the npm release`);
		release.push({ name: json.name, dir, json });
	}
	for (const dir of listPackageDirs('packages/plugins')) {
		const json = readJson(join(REPO_ROOT, dir, 'package.json'));
		if (resolveDistribution(json?.everworks?.plugin) !== 'registry') continue;
		if (json.private === true) {
			log.warn(`! skip ${json.name}: distribution=registry but "private": true`);
			continue;
		}
		release.push({ name: json.name, dir, json });
	}
	return { release, workspaceNames };
}

// ─── registry I/O ───────────────────────────────────────────────────────────

function encodeName(name) {
	return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function fetchWithRetry(url, init, attempts = 3) {
	let lastErr;
	for (let i = 1; i <= attempts; i++) {
		try {
			const res = await fetch(url, init);
			if (res.status >= 500 && i < attempts) {
				await new Promise((r) => setTimeout(r, i * 2000));
				continue;
			}
			return res;
		} catch (err) {
			lastErr = err;
			if (i < attempts) await new Promise((r) => setTimeout(r, i * 2000));
		}
	}
	throw lastErr;
}

/**
 * Versions and burned version numbers out of a packument. npm drops an
 * unpublished version from `versions` but keeps it in `time` (and a fully
 * unpublished package lists them under `time.unpublished.versions`), and it
 * never accepts that number again.
 */
export function parsePackument(body) {
	const versions = body?.versions ?? {};
	const time = body?.time ?? {};
	const burned = new Set(Array.isArray(time.unpublished?.versions) ? time.unpublished.versions : []);
	for (const key of Object.keys(time)) {
		if (key === 'created' || key === 'modified' || key === 'unpublished') continue;
		if (!versions[key]) burned.add(key);
	}
	return { versions, burned: [...burned] };
}

/**
 * What a registry holds for a package.
 * @returns {Promise<{readable: boolean, versions: Record<string, object>, burned: string[], restricted?: boolean, assumedAbsent?: boolean, error?: string}>}
 */
async function readRegistry(registry, name, token) {
	const url = `${registry.url}/${encodeName(name)}`;
	const headers = { accept: 'application/json' };
	const get = (auth) =>
		fetchWithRetry(url, { headers: auth ? { ...headers, authorization: `Bearer ${token}` } : headers });
	const empty = { versions: {}, burned: [] };

	// npmjs.org: read anonymously first, so a restricted package is detectable
	// (anonymous 404, authenticated 200).
	if (registry.id === 'npm') {
		const anon = await get(false);
		if (anon.ok) return { readable: true, ...parsePackument(await anon.json()), restricted: false };
		if (anon.status !== 404) return { readable: false, ...empty, error: `HTTP ${anon.status}` };
		if (!token) return { readable: true, ...empty, restricted: false, assumedAbsent: true };
		const authed = await get(true);
		if (authed.ok) return { readable: true, ...parsePackument(await authed.json()), restricted: true };
		if (authed.status === 404) return { readable: true, ...empty, restricted: false };
		return { readable: false, ...empty, error: `HTTP ${authed.status} (NPM_TOKEN rejected?)` };
	}

	if (!token) return { readable: false, ...empty, error: `${registry.tokenEnv} not set` };
	const res = await get(true);
	if (res.ok) return { readable: true, ...parsePackument(await res.json()) };
	if (res.status === 404) return { readable: true, ...empty };
	return { readable: false, ...empty, error: `HTTP ${res.status}` };
}

/**
 * Run a command without a shell. On Windows `npm` is a .cmd shim that
 * execFile cannot start, so npm's own CLI script is run with this node.
 */
function run(cmd, args, opts = {}) {
	let file = cmd;
	let argv = args;
	if (cmd === 'npm' && process.platform === 'win32') {
		const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
		if (existsSync(cli)) {
			file = process.execPath;
			argv = [cli, ...args];
		}
	}
	return execFileSync(file, argv, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
		...opts
	});
}

function describeExecError(err) {
	return `${err?.stderr ?? ''}${err?.stdout ?? ''}${err?.message ?? err}`.trim();
}

function lastLines(text, n) {
	return String(text)
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-n)
		.join(' | ');
}

/**
 * `npm pack` the release: the exact files `npm pack` listed for the source
 * package are copied into a staging directory next to the release manifest
 * and packed from there. The source tree is never written to, so an
 * interrupted run cannot leave a rewritten package.json behind.
 */
function packWithManifest(absDir, files, manifest, dest) {
	const stage = mkdtempSync(join(dest, 'stage-'));
	for (const f of files) {
		if (f.path === 'package.json') continue;
		const to = join(stage, f.path);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(join(absDir, f.path), to);
	}
	writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	const out = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dest], { cwd: stage });
	return join(dest, JSON.parse(out.slice(out.indexOf('[')))[0].filename);
}

/** Files `npm pack` would ship, with their content hashes (package.json excluded). */
function packedFiles(absDir) {
	const out = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: absDir });
	const parsed = JSON.parse(out.slice(out.indexOf('[')));
	const files = parsed[0].files.map((f) => f.path.split(sep).join('/'));
	return files.map((path) => ({
		path,
		sha256:
			path === 'package.json'
				? null
				: createHash('sha256')
						.update(readFileSync(join(absDir, path)))
						.digest('hex')
	}));
}

/**
 * One throwaway userconfig per registry; npm reads the token from the env
 * itself, so it is never written to disk. The scope line matters: for a scoped
 * package a configured `@scope:registry` outranks `--registry`, so it is
 * pinned to the same registry here rather than left to whatever config the
 * runner happens to carry.
 */
function writeUserconfig(tmp, registry, scopes) {
	const host = registry.url.replace(/^https?:/, '');
	const path = join(tmp, `.npmrc-${registry.id}`);
	const lines = [
		`registry=${registry.url}/`,
		...[...scopes].map((s) => `${s}:registry=${registry.url}/`),
		`${host}/:_authToken=\${${registry.tokenEnv}}`
	];
	writeFileSync(path, `${lines.join('\n')}\n`);
	return path;
}

/** Fill in `everworksRelease` for `version` from its tarball when the packument lacks it. */
async function hydrateReleaseInfo(state, registry, version, token) {
	const manifest = state.versions?.[version];
	if (!manifest || manifest.everworksRelease || !manifest.dist?.tarball) return;
	try {
		const res = await fetchWithRetry(manifest.dist.tarball, {
			headers: token ? { authorization: `Bearer ${token}` } : {}
		});
		if (!res.ok) return;
		const pkg = readPackageJsonFromTarball(Buffer.from(await res.arrayBuffer()));
		if (pkg?.everworksRelease) manifest.everworksRelease = pkg.everworksRelease;
	} catch {
		// Unknown content means "changed": the worst case is one extra patch.
	}
}

// ─── main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const opts = {
		plan: false,
		dryRun: false,
		registries: ['npm', 'github'],
		filter: '',
		tag: 'latest',
		provenance: true
	};
	for (const a of argv) {
		if (a === '--plan') opts.plan = true;
		else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
		else if (a === '--no-provenance') opts.provenance = false;
		else if (a.startsWith('--registries='))
			opts.registries = a
				.slice(13)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		else if (a.startsWith('--filter=')) opts.filter = a.slice(9);
		else if (a.startsWith('--tag=')) opts.tag = a.slice(6);
		else if (a === '--help' || a === '-h') {
			console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${a}`);
	}
	for (const r of opts.registries) if (!REGISTRIES[r]) throw new Error(`Unknown registry "${r}" (npm, github)`);
	return opts;
}

/**
 * Packages that are not publicly visible on GitHub Packages. The REST API that
 * reports `visibility` is not readable with the workflow's GITHUB_TOKEN (the
 * first production run got nothing back), so this asks the way the public
 * does: a package's page answers 302 (to its repository-linked page) when it
 * is public and 404 when it is private — or missing.
 */
export async function githubVisibility(names) {
	const owner = process.env.GITHUB_REPOSITORY_OWNER ?? process.env.GITHUB_REPOSITORY?.split('/')[0] ?? 'ever-works';
	const privateOnes = [];
	for (const name of names) {
		const bare = name.replace(/^@[^/]+\//, '');
		try {
			const res = await fetchWithRetry(
				`https://github.com/orgs/${owner}/packages/npm/package/${encodeURIComponent(bare)}`,
				{ redirect: 'manual' }
			);
			if (res.status === 404) {
				privateOnes.push({ name, url: `https://github.com/orgs/${owner}/packages/npm/${bare}/settings` });
			}
		} catch {
			// Visibility is advisory; never fail the release over it.
		}
	}
	return privateOnes;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const env = process.env;
	const repository = env.GITHUB_REPOSITORY ?? 'ever-works/ever-works';
	const repositoryUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}`;
	const provenance = opts.provenance && env.GITHUB_ACTIONS === 'true' && Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL);
	const selected = opts.registries.map((id) => REGISTRIES[id]);

	const { release, workspaceNames } = discoverPackages(console);
	// The version each package.json declares, raised by any pending changeset
	// that names the package (see parseChangesetBumps).
	const changesetBumps = readChangesetBumps();
	for (const p of release) {
		const type = changesetBumps.get(p.name);
		if (type && type !== 'none') {
			const bumped = bumpVersion(p.json.version, type);
			console.log(`  changeset: ${p.name} ${p.json.version} → ${bumped} (${type})`);
			p.json = { ...p.json, version: bumped };
		}
	}
	const ordered = topoSort(release);
	const releaseNames = new Set(ordered.map((p) => p.name));
	/** --filter narrows what is PUBLISHED; every package is still resolved, so a
	 *  selected plugin gets its dependencies' real released versions and is
	 *  blocked where a dependency is missing, exactly as in a full run. */
	const isSelected = (p) => !opts.filter || p.name.includes(opts.filter);
	const targets = ordered.filter(isSelected);
	const mode = opts.plan ? 'PLAN' : opts.dryRun ? 'DRY RUN' : 'PUBLISH';
	console.log(
		`\nEver Works npm release — ${targets.length}/${ordered.length} package(s) → ${selected.map((r) => r.id).join(' + ')} [${mode}]` +
			(provenance ? ' (with provenance)' : '') +
			'\n'
	);

	const tmp = mkdtempSync(join(tmpdir(), 'ew-npm-release-'));
	const scopes = new Set(ordered.map((p) => p.name.split('/')[0]).filter((s) => s.startsWith('@')));
	const userconfigs = Object.fromEntries(selected.map((r) => [r.id, writeUserconfig(tmp, r, scopes)]));
	/** Packages that exist on npm but are still restricted (private). */
	const restrictedOnNpmList = [];
	/** name → version this run settles on, for dependents' ranges. */
	const releaseVersions = new Map(ordered.map((p) => [p.name, p.json.version]));
	/** name → Set(registry id) that do NOT hold the settled version after this run. */
	const missing = new Map();
	const rows = [];
	let failures = 0;

	try {
		for (const pkg of ordered) {
			const absDir = join(REPO_ROOT, pkg.dir);
			const chosen = isSelected(pkg);
			const row = { name: pkg.name, version: '', reason: '', actions: [], errors: [] };
			if (chosen) rows.push(row);
			try {
				// 1. What would ship, and its fingerprint. Without a `files`
				//    allow-list npm ships the whole directory — sources, tests and
				//    turbo's per-run build log — so the fingerprint would change on
				//    every build and every push to main would cut a new version.
				if (!Array.isArray(pkg.json.files) || pkg.json.files.length === 0) {
					throw new Error('package.json has no "files" allow-list (add "files": ["dist"])');
				}
				const files = packedFiles(absDir);
				const stray = files.filter((f) => /^(\.turbo|node_modules|src)\//.test(f.path)).map((f) => f.path);
				if (stray.length) throw new Error(`would ship build/source files: ${stray.slice(0, 3).join(', ')}`);
				const shipped = new Set(files.map((f) => f.path));
				const absentEntries = entryPointTargets(pkg.json).filter((t) => !shipped.has(t));
				if (absentEntries.length) {
					throw new Error(`not built — the package would ship without ${absentEntries.join(', ')}`);
				}
				const draft = buildPublishManifest(pkg.json, {
					version: pkg.json.version,
					releaseVersions,
					workspaceNames,
					repositoryUrl,
					directory: pkg.dir
				});
				const fingerprint = computeFingerprint(
					files.filter((f) => f.path !== 'package.json'),
					normalizeManifestForFingerprint(draft, releaseNames)
				);

				// 2. What the registries already hold.
				const states = {};
				for (const r of selected) states[r.id] = await readRegistry(r, pkg.name, env[r.tokenEnv]);
				const readable = selected.filter((r) => states[r.id].readable);
				for (const r of selected) {
					if (!states[r.id].readable)
						row.errors.push(`${r.id}: cannot read registry (${states[r.id].error})`);
					if (states[r.id].assumedAbsent) {
						row.errors.push(
							`${r.id}: not visible anonymously and ${r.tokenEnv} is unset — cannot tell restricted from absent`
						);
					}
				}
				if (!readable.length) throw new Error('no selected registry is readable');

				// 3. The version. First make sure the newest published version's
				//    fingerprint is known, reading it from the tarball if needed.
				const highest = maxStable(readable.flatMap((r) => Object.keys(states[r.id].versions)));
				if (highest && !readable.some((r) => states[r.id].versions[highest]?.everworksRelease)) {
					for (const r of readable) {
						await hydrateReleaseInfo(states[r.id], r, highest, env[r.tokenEnv]);
						if (states[r.id].versions[highest]?.everworksRelease) break;
					}
				}
				const decision = resolveTargetVersion({
					repoVersion: pkg.json.version,
					fingerprint,
					registries: readable.map((r) => states[r.id])
				});
				row.version = decision.version;
				row.reason = decision.reason;
				releaseVersions.set(pkg.name, decision.version);

				// 4. Where it still has to go. A dependency that failed to reach a
				//    registry blocks its dependents there: they would not install.
				const need = [];
				for (const r of readable) {
					if (states[r.id].versions[decision.version] || states[r.id].assumedAbsent) continue;
					const blockedBy = Object.keys({ ...pkg.json.dependencies, ...pkg.json.peerDependencies }).filter(
						(d) => missing.get(d)?.has(r.id)
					);
					if (blockedBy.length) {
						row.errors.push(`${r.id}: blocked — ${blockedBy.join(', ')} did not reach ${r.id}`);
						continue;
					}
					need.push(r);
				}
				/** Registries that will NOT hold decision.version when this package is done. */
				const miss = new Set(
					selected
						.filter((r) => !states[r.id].versions[decision.version] && (!chosen || !need.includes(r)))
						.map((r) => r.id)
				);
				const restrictedOnNpm = states.npm?.restricted === true;
				if (restrictedOnNpm && chosen) {
					restrictedOnNpmList.push(pkg.name);
					row.actions.push('⚠ still private on npm');
				}

				if (!chosen) {
					// Resolved only, for its dependents; a filtered run never publishes it.
					missing.set(pkg.name, miss);
					continue;
				}
				if (opts.plan) {
					row.actions.push(...need.map((r) => `would publish → ${r.id}`));
					if (!need.length && !row.errors.length) row.actions.push('up to date');
					missing.set(pkg.name, miss);
					continue;
				}

				// 5. Pack once, publish the same tarball everywhere.
				if (need.length) {
					const manifest = buildPublishManifest(pkg.json, {
						version: decision.version,
						releaseVersions,
						workspaceNames,
						repositoryUrl,
						directory: pkg.dir
					});
					manifest.everworksRelease = {
						contentHash: fingerprint,
						commit: env.GITHUB_SHA ?? null,
						source: `${repositoryUrl}/tree/${env.GITHUB_SHA ?? 'main'}/${pkg.dir}`
					};
					const tarball = packWithManifest(absDir, files, manifest, tmp);

					for (const r of need) {
						const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0] : null;
						const base = ['publish', tarball, '--registry', `${r.url}/`, '--tag', opts.tag];
						// For a scoped package a configured `@scope:registry` outranks
						// --registry, so pin the scope on the command line as well.
						if (scope) base.push(`--${scope}:registry=${r.url}/`);
						const args = [...base];
						if (r.id === 'npm') {
							// EVERY npm publish carries --access public. A scoped package
							// would otherwise be CREATED private — and for one that is
							// ALREADY private, npm applies the flag exactly as
							// `npm access set status=public` would ("specifying a value
							// of restricted or public during publish will change the
							// access for an existing package", npm-publish docs).
							//
							// That is now the ONLY route left to CI. Since 2026-07-31 an
							// npm granular access token configured to bypass 2FA — which
							// is exactly what NPM_TOKEN is — cannot change package
							// access: `POST /-/package/<pkg>/access` answers 403, and
							// npm's changelog lists "changing package access" among the
							// operations that now need an interactive 2FA challenge. The
							// CLI's fallback is a browser approval PER PACKAGE. Direct
							// publishing from the same token stays permitted until
							// January 2027, so the publish is what flips them.
							args.push('--access', 'public');
							// Provenance is rejected while a package is still private at
							// the moment of upload, so it joins from the next release on.
							if (provenance && !restrictedOnNpm) args.push('--provenance');
						}
						if (opts.dryRun) args.push('--dry-run');
						// If npm ever refuses the access change, publish the version
						// anyway: staying private is the status quo, losing the release
						// is not. Only for a package that is already private — for a new
						// one, publishing without --access would CREATE it private.
						const fallback =
							r.id === 'npm' && restrictedOnNpm ? [...base, ...(opts.dryRun ? ['--dry-run'] : [])] : null;
						try {
							try {
								run('npm', args, { cwd: tmp, env: { ...env, NPM_CONFIG_USERCONFIG: userconfigs[r.id] } });
							} catch (err) {
								const first = describeExecError(err);
								if (!fallback || !/EOTP|one-time pass|E403|forbidden|access/i.test(first)) throw err;
								console.log(
									`::warning::${pkg.name}: npm refused the access change on publish; publishing without it, so the package stays PRIVATE. npm said:
${lastLines(first, 5)}`
								);
								run('npm', fallback, { cwd: tmp, env: { ...env, NPM_CONFIG_USERCONFIG: userconfigs[r.id] } });
								row.actions.push('⚠ published without --access');
							}
							row.actions.push(`${opts.dryRun ? 'dry-run: ' : ''}published → ${r.id}`);
						} catch (err) {
							const msg = describeExecError(err);
							// "Already published" only counts when the registry really
							// holds this version with this content: a burned number or a
							// failed save (E409) must not pass as success.
							let confirmed = false;
							if (/previously published|cannot publish over|EPUBLISHCONFLICT|E409/i.test(msg)) {
								const again = await readRegistry(r, pkg.name, env[r.tokenEnv]);
								await hydrateReleaseInfo(again, r, decision.version, env[r.tokenEnv]);
								confirmed =
									again.versions?.[decision.version]?.everworksRelease?.contentHash === fingerprint;
							}
							if (confirmed) {
								row.actions.push(`already on ${r.id}`);
							} else {
								miss.add(r.id);
								row.errors.push(`${r.id}: publish failed — ${lastLines(msg, 3)}`);
							}
						}
					}
				} else if (!row.errors.length) {
					row.actions.push('up to date');
				}
				missing.set(pkg.name, miss);
			} catch (err) {
				row.errors.push(String(err?.message ?? err));
				missing.set(pkg.name, new Set(selected.map((r) => r.id)));
			} finally {
				// `finally`, so the `continue`s above are counted and logged too.
				if (chosen) {
					if (row.errors.length) failures++;
					console.log(
						`${row.errors.length ? '✖' : '✔'} ${pkg.name.padEnd(48)} ${(row.version || '-').padEnd(10)} ${row.actions.join('; ') || '-'}` +
							(row.reason ? `  (${row.reason})` : '') +
							row.errors.map((e) => `\n    ${e}`).join('')
					);
				}
			}
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	if (restrictedOnNpmList.length) {
		console.log(
			`::warning::${restrictedOnNpmList.length} package(s) were PRIVATE on npmjs.org when this run started; each was published with --access public, which is what flips them. Re-read the registry (or check the job summary) to confirm, and see docs/devops/github-workflows-deep-dive.md if any stayed private.`
		);
	}

	const privateOnGithub =
		!opts.plan && selected.some((r) => r.id === 'github') ? await githubVisibility(targets.map((p) => p.name)) : [];
	for (const p of privateOnGithub) {
		console.log(`::warning::${p.name} is private on GitHub Packages — no API can change that; flip it at ${p.url}`);
	}

	if (env.GITHUB_STEP_SUMMARY) {
		const lines = [
			`## npm release — ${mode}`,
			'',
			`${targets.length} package(s) → ${selected.map((r) => r.id).join(' + ')}${provenance ? ', with provenance' : ''}; ${failures} failed.`,
			'',
			'| Package | Version | Action | Why |',
			'| --- | --- | --- | --- |',
			...rows.map(
				(r) =>
					`| \`${r.name}\` | ${r.version || '-'} | ${[...r.actions, ...r.errors.map((e) => `❌ ${e}`)].join('<br>') || '-'} | ${r.reason || '-'} |`
			)
		];
		if (restrictedOnNpmList.length) {
			lines.push(
				'',
				'### Was private on npmjs.org at the start of this run',
				'',
				`${restrictedOnNpmList.length} package(s). Each was published with \`--access public\`, which npm applies to an existing package exactly as \`npm access set status=public\` would — the only route left to CI, since a 2FA-bypass granular token (what NPM_TOKEN is) cannot change package access at all. Verify with:`,
				'',
				'```bash',
				...restrictedOnNpmList.slice(0, 5).map((n) => `curl -so /dev/null -w '%{http_code} ' https://registry.npmjs.org/${encodeURIComponent(n)}  # 200 = public`),
				'```',
				'',
				'Any that stayed private are flagged `⚠ published without --access` in the table above.'
			);
		}
		if (privateOnGithub.length) {
			lines.push(
				'',
				'### Still private on GitHub Packages',
				'',
				...privateOnGithub.map((p) => `- [\`${p.name}\`](${p.url})`)
			);
		}
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
	}

	console.log(`\n${failures ? `✖ ${failures} package(s) failed.` : '✔ Done.'}`);
	process.exit(failures ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err?.stack ?? err);
		process.exit(1);
	});
}
