import { promises as fs } from 'fs';
import * as nodePath from 'path';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Fleet node link — THE allowed-roots resolver (CONTRACTS R-18, R-39, R-41).
 *
 * The Files tab (FL-11), the Logs file source (FL-08) and checkouts (FL-14)
 * see only these folders on a machine:
 *
 *  - every checkout in state `ready` (R-41: `creating`, `missing` and
 *    `archived` ones are not roots) — the checkouts module's `readyPaths()`;
 *  - the node's workspace root (its Task pool);
 *  - the OS standard log directories — for logs only (`purpose: 'logs'`);
 *  - any extra root the machine owner listed in the node's local config
 *    (`--files-root`, FL-11).
 *
 * The home directory is never a root by default. Paths are canonicalised; a
 * candidate is inside a root only as a strict descendant or the root itself,
 * compared without case on Windows. Symlinks escaping a root are the
 * caller's to refuse (it holds the real path); this module answers the
 * lexical question exactly one way for everyone.
 *
 * Created by FL-14 (the first of FL-08 / FL-11 / FL-14 to land, R-39); the
 * others import it and never define a second resolver.
 *
 * FL-08 (logs) adds, in this same module, the FILESYSTEM half its callers
 * need on top of the lexical one: {@link resolveCanonicalAllowedRoots} (each
 * root `realpath`-ed, a missing one skipped, the home directory itself and a
 * filesystem root refused and reported) and {@link resolveUnderRoots} (a
 * typed path canonicalised on its own — every symlink and junction resolved,
 * never JOINED onto a root — then proved to sit under a canonical root, so a
 * link from a root to `/etc` is refused), plus {@link standardLogDirs}.
 */

export type AllowedRootsPurpose = 'files' | 'logs' | 'checkouts';

export interface AllowedRootsInput {
	/** `ready` checkout paths (the checkouts module's `readyPaths()`). */
	checkouts?: readonly string[];
	/** The node's workspace root, when it keeps a Task pool. */
	workspaceRoot?: string | null;
	/** Extra roots the owner listed on the machine (`--files-root`). */
	extraRoots?: readonly string[];
	/** OS log directories — included for `purpose: 'logs'` only. */
	logDirs?: readonly string[];
	purpose?: AllowedRootsPurpose;
	platform?: string;
}

function keyOf(path: string, platform: string): string {
	return platform === 'win32' ? path.toLowerCase() : path;
}

/** The canonical, de-duplicated root list, in a stable order. */
export function resolveAllowedRoots(input: AllowedRootsInput): string[] {
	const platform = input.platform ?? process.platform;
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (path: string | null | undefined): void => {
		if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) return;
		const normalized = resolve(path);
		const key = keyOf(normalized, platform);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(normalized);
	};
	for (const path of input.checkouts ?? []) add(path);
	add(input.workspaceRoot ?? null);
	for (const path of input.extraRoots ?? []) add(path);
	if (input.purpose === 'logs') for (const path of input.logDirs ?? []) add(path);
	return out;
}

/** True when `candidate` is a root or strictly inside one. */
export function isWithinAllowedRoots(
	candidate: string,
	roots: readonly string[],
	platform: string = process.platform
): boolean {
	if (!isAbsolute(candidate)) return false;
	const target = resolve(candidate);
	for (const root of roots) {
		const base = resolve(root);
		const rel = relative(base, target);
		if (rel === '') return true;
		const first = rel.split(/[\\/]/)[0];
		if (first !== '..' && !isAbsolute(rel)) {
			// `relative` already compares case-insensitively on win32 drives;
			// keep the explicit platform branch for injected test platforms.
			if (platform !== 'win32' || keyOf(target, platform).startsWith(keyOf(base, platform))) return true;
		}
	}
	return false;
}

// ─── FL-08: the filesystem half (realpath, home, filesystem roots) ──────────

export type AllowedRootKind = 'checkout' | 'workspace' | 'files-root' | 'log-dir';

export interface AllowedRoot {
	/** Canonical, absolute (`realpath`). */
	path: string;
	kind: AllowedRootKind;
}

/** Filesystem seam (specs drive symlinks and case without a real link farm). */
export interface RootsFs {
	realpath(path: string): Promise<string>;
}

export const defaultRootsFs: RootsFs = {
	realpath: (path) => fs.realpath(path)
};

export interface CanonicalAllowedRootsInput extends AllowedRootsInput {
	/** Never a root as a whole; a root that resolves to it is refused. */
	homedir: string;
}

export interface ResolvedAllowedRoots {
	roots: AllowedRoot[];
	/** Candidates that were named but refused (missing, relative, home, a filesystem root). */
	refused: Array<{
		path: string;
		kind: AllowedRootKind;
		reason: 'missing' | 'relative' | 'home' | 'filesystem-root';
	}>;
}

function pathApi(platform: string): typeof nodePath.posix {
	return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function fold(value: string, platform: string): string {
	return platform === 'win32' ? value.toLowerCase() : value;
}

/** `/`, `C:\`, `\\server\share\` — a root no dashboard is ever handed whole. */
export function isFilesystemRoot(path: string, platform: string): boolean {
	const api = pathApi(platform);
	const normal = api.normalize(path);
	return api.parse(normal).root === normal || api.dirname(normal) === normal;
}

/** True when `candidate` is `root` or sits under it (both canonical), for an injected platform. */
export function isInsideRoot(candidate: string, root: string, platform: string): boolean {
	const api = pathApi(platform);
	const rel = api.relative(fold(root, platform), fold(candidate, platform));
	if (rel === '') return true;
	if (api.isAbsolute(rel)) return false; // another drive on Windows
	return rel !== '..' && !rel.startsWith(`..${api.sep}`);
}

/** The operating system's standard log directories (R-18; spec FL-08 §8b for Windows). */
export function standardLogDirs(platform: string, homedir: string): string[] {
	switch (platform) {
		case 'darwin':
			return ['/var/log', '/Library/Logs', nodePath.posix.join(homedir, 'Library', 'Logs')];
		case 'win32':
			// FL-08 spec §8b default: no Windows system folder is listed
			// (`C:\Windows\Logs` is administrator-only and noisy); the roots and
			// `--files-root` folders are.
			return [];
		default:
			return ['/var/log'];
	}
}

/**
 * The roots of {@link resolveAllowedRoots}' order (checkouts, workspace,
 * extra roots, then — for logs — the log directories), each canonicalised
 * with `realpath`. A missing one is skipped (a checkout being created, a
 * `--files-root` on an unplugged drive); a relative one, the home directory
 * itself and a filesystem root are refused and reported. Duplicates (after
 * canonicalisation) are dropped.
 */
export async function resolveCanonicalAllowedRoots(
	input: CanonicalAllowedRootsInput,
	rootsFs: RootsFs = defaultRootsFs
): Promise<ResolvedAllowedRoots> {
	const platform = input.platform ?? process.platform;
	const api = pathApi(platform);
	const candidates: Array<{ path: string; kind: AllowedRootKind }> = [
		...(input.checkouts ?? []).map((path) => ({ path, kind: 'checkout' as const })),
		...(input.workspaceRoot ? [{ path: input.workspaceRoot, kind: 'workspace' as const }] : []),
		...(input.extraRoots ?? []).map((path) => ({ path, kind: 'files-root' as const })),
		...(input.purpose === 'logs' ? (input.logDirs ?? []).map((path) => ({ path, kind: 'log-dir' as const })) : [])
	];
	let home: string | null = null;
	try {
		home = await rootsFs.realpath(input.homedir);
	} catch {
		home = input.homedir ? api.normalize(input.homedir) : null;
	}
	const roots: AllowedRoot[] = [];
	const refused: ResolvedAllowedRoots['refused'] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate.path !== 'string' || candidate.path.length === 0 || candidate.path.includes('\0')) continue;
		if (!api.isAbsolute(candidate.path)) {
			refused.push({ ...candidate, reason: 'relative' });
			continue;
		}
		let canonical: string;
		try {
			canonical = await rootsFs.realpath(candidate.path);
		} catch {
			refused.push({ ...candidate, reason: 'missing' });
			continue;
		}
		if (isFilesystemRoot(canonical, platform)) {
			refused.push({ ...candidate, reason: 'filesystem-root' });
			continue;
		}
		if (home && fold(api.normalize(canonical), platform) === fold(api.normalize(home), platform)) {
			refused.push({ ...candidate, reason: 'home' });
			continue;
		}
		const key = fold(canonical, platform);
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push({ path: canonical, kind: candidate.kind });
	}
	return { roots, refused };
}

export type UnderRootsResult =
	| { ok: true; canonical: string; root: AllowedRoot }
	| { ok: false; reason: 'not-absolute' | 'missing' | 'outside' };

/**
 * Prove a typed path sits under one of `roots` ({@link resolveCanonicalAllowedRoots}'
 * output). The path is canonicalised on its own — never joined — so a symlink
 * escaping a root is refused, as is `..`.
 */
export async function resolveUnderRoots(
	path: string,
	roots: readonly AllowedRoot[],
	platform: string,
	rootsFs: RootsFs = defaultRootsFs
): Promise<UnderRootsResult> {
	const api = pathApi(platform);
	if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !api.isAbsolute(path)) {
		return { ok: false, reason: 'not-absolute' };
	}
	let canonical: string;
	try {
		canonical = await rootsFs.realpath(path);
	} catch {
		return { ok: false, reason: 'missing' };
	}
	for (const root of roots) {
		if (isInsideRoot(canonical, root.path, platform)) return { ok: true, canonical, root };
	}
	return { ok: false, reason: 'outside' };
}
