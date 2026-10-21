import { promises as fs } from 'fs';
import * as nodePath from 'path';

/**
 * Fleet node link — the ONE allowed-roots resolver (CONTRACTS R-18, R-39,
 * R-41). Logs (FL-08) created it; files (FL-11) and checkouts (FL-14) import
 * it and never define a second one.
 *
 * What a dashboard may see on this machine's disk is exactly:
 *
 *  - every `ready` checkout's path (R-41; FL-14 hands them in);
 *  - the node's workspace root (the per-Task worktrees);
 *  - every extra folder the machine's owner named with `--files-root`;
 *  - for logs only, the operating system's standard log directories
 *    ({@link standardLogDirs}).
 *
 * The home directory is never a root by default, and neither is a
 * filesystem root (`/`, `C:\`): naming one is refused here, not trusted.
 *
 * ## The rule (the lookup rule of `executors/command-roots.ts`)
 *
 * A path a person or an Agent types is never JOINED onto a root. It is
 * canonicalised on its own (`realpath`: every symlink and junction resolved,
 * `..` collapsed) and then PROVED to sit under a root that was canonicalised
 * the same way. A symlink inside a root that points at `/etc` therefore
 * resolves to `/etc` and is refused; so is a sibling folder whose name merely
 * starts with the root's (`/srv/app-old` is not under `/srv/app`). On Windows
 * the comparison folds case, as the filesystem does.
 */

export type AllowedRootKind = 'log-dir' | 'checkout' | 'workspace' | 'files-root';

export interface AllowedRoot {
	/** Canonical, absolute. */
	path: string;
	kind: AllowedRootKind;
}

export interface AllowedRootsInput {
	/** `process.platform`. */
	platform: string;
	homedir: string;
	workspaceRoot?: string | null;
	/** `--files-root` folders (process-scoped, like `--manage`). */
	filesRoots?: readonly string[];
	/** `ready` checkout paths (R-41). */
	checkouts?: readonly string[];
	/** The standard log directories — passed for logs only (R-18). */
	logDirs?: readonly string[];
}

/** Filesystem seam (tests drive symlinks and case without a real link farm). */
export interface RootsFs {
	realpath(path: string): Promise<string>;
}

export const defaultRootsFs: RootsFs = {
	realpath: (path) => fs.realpath(path)
};

export interface ResolvedAllowedRoots {
	roots: AllowedRoot[];
	/** Candidates that were named but refused (missing, relative, home, a filesystem root). */
	refused: Array<{ path: string; kind: AllowedRootKind; reason: 'missing' | 'relative' | 'home' | 'filesystem-root' }>;
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

/** True when `candidate` is `root` or sits under it (both canonical). */
export function isInsideRoot(candidate: string, root: string, platform: string): boolean {
	const api = pathApi(platform);
	const relative = api.relative(fold(root, platform), fold(candidate, platform));
	if (relative === '') return true;
	if (api.isAbsolute(relative)) return false; // another drive on Windows
	return relative !== '..' && !relative.startsWith(`..${api.sep}`);
}

/** The operating system's standard log directories (R-18, spec §8b for Windows). */
export function standardLogDirs(platform: string, homedir: string): string[] {
	switch (platform) {
		case 'darwin':
			return ['/var/log', '/Library/Logs', nodePath.posix.join(homedir, 'Library', 'Logs')];
		case 'win32':
			// Spec §8b default: no Windows system folder is listed
			// (`C:\Windows\Logs` is administrator-only and noisy); the roots and
			// `--files-root` folders are.
			return [];
		default:
			return ['/var/log'];
	}
}

/**
 * Canonicalise every named root. A missing one is skipped (a checkout being
 * created, a `--files-root` on an unplugged drive); a relative one, the home
 * directory itself and a filesystem root are refused and reported, so the
 * caller can log one line about each. Order is kept, duplicates are dropped.
 */
export async function resolveAllowedRoots(
	input: AllowedRootsInput,
	rootsFs: RootsFs = defaultRootsFs
): Promise<ResolvedAllowedRoots> {
	const api = pathApi(input.platform);
	const candidates: Array<{ path: string; kind: AllowedRootKind }> = [
		...(input.logDirs ?? []).map((path) => ({ path, kind: 'log-dir' as const })),
		...(input.checkouts ?? []).map((path) => ({ path, kind: 'checkout' as const })),
		...(input.workspaceRoot ? [{ path: input.workspaceRoot, kind: 'workspace' as const }] : []),
		...(input.filesRoots ?? []).map((path) => ({ path, kind: 'files-root' as const }))
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
		if (isFilesystemRoot(canonical, input.platform)) {
			refused.push({ ...candidate, reason: 'filesystem-root' });
			continue;
		}
		if (home && fold(api.normalize(canonical), input.platform) === fold(api.normalize(home), input.platform)) {
			refused.push({ ...candidate, reason: 'home' });
			continue;
		}
		const key = fold(canonical, input.platform);
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
 * Prove a typed path sits under one of `roots` ({@link resolveAllowedRoots}'s
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
