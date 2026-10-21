import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	FLEET_CHECKOUTS_DISCOVERY_BUDGET_MS,
	FLEET_CHECKOUTS_DISCOVERY_CAP,
	FLEET_CHECKOUTS_DISCOVERY_MAX_DEPTH,
	FLEET_CHECKOUTS_DISCOVERY_SKIP_DIRS
} from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14, spec FR-3, FR-4, S1, U5) — find the git
 * clones under the code folders the machine owner listed (`--code-folder`).
 *
 * The walk is bounded every way a laptop needs it to be:
 *
 *  - at most {@link FLEET_CHECKOUTS_DISCOVERY_MAX_DEPTH} folders below a code
 *    folder (the code folder itself is depth 0 and may itself be a clone);
 *  - it stops descending at the first `.git` in a branch of the tree — a
 *    clone's own subfolders (and its submodules) are part of that clone;
 *  - dependency and build folders, and hidden folders, are never entered;
 *  - symbolic links and Windows junctions are never followed, so a link out
 *    of a code folder cannot widen what is scanned;
 *  - it stops at {@link FLEET_CHECKOUTS_DISCOVERY_CAP} checkouts or after
 *    {@link FLEET_CHECKOUTS_DISCOVERY_BUDGET_MS}, saying so (`truncated`).
 *
 * The platform never chooses the folders (FR-3): they come from this
 * machine's own config, and a home directory as a whole is refused when the
 * owner sets them (`parseCodeFolders`).
 */

export interface DiscoveryResult {
	/** Absolute paths of the checkouts found, in walk order. */
	paths: string[];
	truncated: boolean;
}

export interface DiscoveryOptions {
	cap?: number;
	maxDepth?: number;
	budgetMs?: number;
	signal?: AbortSignal;
	now?: () => number;
	/** Injected for specs. */
	readdir?: (path: string) => Promise<Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
	lstat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean } | null>;
}

const SKIP = new Set(FLEET_CHECKOUTS_DISCOVERY_SKIP_DIRS);

async function defaultReaddir(
	path: string
): Promise<Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>> {
	try {
		return await fs.readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function defaultLstat(
	path: string
): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean } | null> {
	try {
		return await fs.lstat(path);
	} catch {
		return null;
	}
}

/** Walk the code folders; never throws for an unreadable folder (it is skipped). */
export async function discoverCheckouts(
	codeFolders: readonly string[],
	options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
	const cap = options.cap ?? FLEET_CHECKOUTS_DISCOVERY_CAP;
	const maxDepth = options.maxDepth ?? FLEET_CHECKOUTS_DISCOVERY_MAX_DEPTH;
	const budgetMs = options.budgetMs ?? FLEET_CHECKOUTS_DISCOVERY_BUDGET_MS;
	const now = options.now ?? (() => Date.now());
	const readdir = options.readdir ?? defaultReaddir;
	const lstat = options.lstat ?? defaultLstat;
	const deadline = now() + budgetMs;
	const found: string[] = [];
	const seen = new Set<string>();
	let truncated = false;

	for (const folder of codeFolders) {
		const root = resolve(folder);
		const rootStats = await lstat(root);
		// The code folder itself must be a real directory, never a link.
		if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) continue;
		// Breadth-first, so a cap or a budget keeps the shallow clones (the ones people mean).
		const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
		while (queue.length > 0) {
			if (options.signal?.aborted) return { paths: found, truncated: true };
			if (found.length >= cap || now() > deadline) {
				truncated = true;
				break;
			}
			const { path, depth } = queue.shift()!;
			const gitEntry = await lstat(join(path, '.git'));
			if (gitEntry && !gitEntry.isSymbolicLink() && (gitEntry.isDirectory() || gitEntry.isFile())) {
				const key = process.platform === 'win32' ? path.toLowerCase() : path;
				if (!seen.has(key)) {
					seen.add(key);
					found.push(path);
				}
				continue; // a clone's subfolders are that clone
			}
			if (depth >= maxDepth) continue;
			for (const entry of await readdir(path)) {
				if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
				if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
				queue.push({ path: join(path, entry.name), depth: depth + 1 });
			}
		}
		if (truncated) break;
	}
	return { paths: found, truncated };
}
