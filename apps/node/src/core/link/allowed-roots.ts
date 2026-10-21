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
