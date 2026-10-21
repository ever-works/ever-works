import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Fleet node link — the ONE allowed-roots resolver (CONTRACTS R-18, R-39,
 * R-41). Logs (FL-08), files (FL-11), checkouts (FL-14) and Docker bind
 * mounts (FL-09) see only these folders on the machine:
 *
 *  - every checkout in state `ready` (R-41 — `creating`, `missing` and
 *    `archived` ones are not roots);
 *  - the node's workspace root;
 *  - any extra root the machine's owner lists in the node's local config
 *    (`--files-root`), set on the machine only.
 *
 * The home directory is never a root by default. Every root and every
 * candidate is canonicalised (`realpath`), so a symlink that escapes a root
 * is refused, and a candidate must exist. Created by FL-09 P2, the first epic
 * to land that needs it; the others import it and never define a second one.
 * (The OS log directories are a logs-only root FL-08 adds through
 * {@link AllowedRootsSources.extraRoots} for its own reads.)
 */

export interface AllowedRootsSources {
	/** The node's workspace root, when it has one. */
	workspaceRoot?: string | null;
	/** The `ready` checkout paths (FL-14's `CheckoutsModule.readyPaths`). */
	readyCheckouts?: () => Promise<string[]>;
	/** Owner-listed roots from the machine's own config. */
	extraRoots?: readonly string[];
}

export interface AllowedRootsFs {
	realpath(target: string): Promise<string>;
}

const defaultFs: AllowedRootsFs = { realpath: (target) => realpath(target) };

function comparable(value: string, platform: string): string {
	const normalized = path.normalize(value);
	return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

/** The canonical roots, de-duplicated, roots that do not exist dropped. */
export async function resolveAllowedRoots(
	sources: AllowedRootsSources,
	fs: AllowedRootsFs = defaultFs
): Promise<string[]> {
	const candidates: string[] = [];
	if (sources.workspaceRoot) candidates.push(sources.workspaceRoot);
	for (const root of sources.extraRoots ?? []) candidates.push(root);
	if (sources.readyCheckouts) {
		try {
			candidates.push(...(await sources.readyCheckouts()));
		} catch {
			// a registry that cannot be read contributes nothing
		}
	}
	const out: string[] = [];
	for (const candidate of candidates) {
		if (!candidate || !path.isAbsolute(candidate)) continue;
		try {
			const real = await fs.realpath(candidate);
			if (!out.includes(real)) out.push(real);
		} catch {
			// a root that is not there is not a root
		}
	}
	return out;
}

/** True when `target` (after `realpath`) is one of `roots` or inside one. A target that does not exist is outside. */
export async function isUnderAllowedRoots(
	target: string,
	roots: readonly string[],
	platform: string = process.platform,
	fs: AllowedRootsFs = defaultFs
): Promise<boolean> {
	if (!target || !path.isAbsolute(target)) return false;
	let real: string;
	try {
		real = await fs.realpath(target);
	} catch {
		return false;
	}
	const candidate = comparable(real, platform);
	return roots.some((root) => {
		const base = comparable(root, platform);
		if (candidate === base) return true;
		const withSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
		return candidate.startsWith(withSep);
	});
}
