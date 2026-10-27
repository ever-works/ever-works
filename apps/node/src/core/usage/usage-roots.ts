import { posix, win32 } from 'node:path';
import type { FleetUsageProvider } from '@ever-works/contracts';
import type { UsageFs } from './usage-fs';

/**
 * Usage & cost on the fleet (FL-20, plan §6, T-08) — WHICH folders the
 * transcript scan reads, and nothing else (spec FR-2):
 *
 *  - Claude Code: `<home>/projects` for the CLI config home —
 *    `$CLAUDE_CONFIG_DIR` when set for this user, and `~/.claude` (both, when
 *    they differ);
 *  - Codex: `<home>/sessions` for `$CODEX_HOME` and `~/.codex`.
 *
 * Agent sessions and Task runs MIRROR the provider's real config home into
 * their isolated homes (`MODEL_SESSION_HOME_ENV_NAME`, `isolated-home.ts`), so
 * their records land in these same folders (U6). An embedder may pass extra
 * CLI homes (`extraHomes`), each read the same way.
 *
 * The walk never follows a symbolic link (a link out of a records folder is
 * refused, not read), stays within a bounded depth, and only ever yields
 * `*.jsonl` files.
 */

export interface UsageRoot {
	provider: FleetUsageProvider;
	/** Absolute: `<claude home>/projects` or `<codex home>/sessions`. */
	dir: string;
}

export interface UsageRootsInput {
	env: Record<string, string | undefined>;
	homedir: string;
	platform: string;
	/** Extra CLI homes (`{ provider, home }`) an embedder knows about. */
	extraHomes?: ReadonlyArray<{ provider: FleetUsageProvider; home: string }>;
}

/** Deepest folder level the walk descends (Codex nests `sessions/YYYY/MM/DD/`). */
export const USAGE_WALK_MAX_DEPTH = 5;
/** Most record files one root may contribute to a scan. */
export const USAGE_WALK_MAX_FILES = 20_000;

const RECORDS_DIR: Readonly<Record<FleetUsageProvider, string>> = {
	'claude-code': 'projects',
	codex: 'sessions'
};

function pathApi(platform: string) {
	return platform === 'win32' ? win32 : posix;
}

/** The candidate record folders for this user, de-duplicated, absolute only. */
export function resolveUsageRoots(input: UsageRootsInput): UsageRoot[] {
	const api = pathApi(input.platform);
	const homes: Array<{ provider: FleetUsageProvider; home: string | undefined }> = [
		{ provider: 'claude-code', home: input.env.CLAUDE_CONFIG_DIR?.trim() },
		{ provider: 'claude-code', home: api.join(input.homedir, '.claude') },
		{ provider: 'codex', home: input.env.CODEX_HOME?.trim() },
		{ provider: 'codex', home: api.join(input.homedir, '.codex') },
		...(input.extraHomes ?? [])
	];
	const out: UsageRoot[] = [];
	const seen = new Set<string>();
	for (const { provider, home } of homes) {
		if (!home || !api.isAbsolute(home)) continue;
		const dir = api.join(api.resolve(home), RECORDS_DIR[provider]);
		const key = `${provider}\u0000${input.platform === 'win32' ? dir.toLowerCase() : dir}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ provider, dir });
	}
	return out;
}

/** True when at least one record folder exists (the `usage-scan` tag's condition, CONTRACTS §1.2). */
export function anyUsageRootExists(roots: readonly UsageRoot[], fs: Pick<UsageFs, 'exists'>): boolean {
	return roots.some((root) => fs.exists(root.dir));
}

/** One record file found by the walk. */
export interface UsageRecordFile {
	provider: FleetUsageProvider;
	path: string;
	size: number;
	mtimeMs: number;
}

/**
 * Every `*.jsonl` under `root`, oldest first (so a backlog drains in order).
 * Symbolic links — to a file or a folder — are skipped; so is a root that is
 * itself a link. Missing roots answer nothing.
 */
export async function listUsageRecordFiles(
	root: UsageRoot,
	fs: UsageFs,
	platform: string,
	limits: { maxDepth?: number; maxFiles?: number } = {}
): Promise<UsageRecordFile[]> {
	const api = pathApi(platform);
	const maxDepth = limits.maxDepth ?? USAGE_WALK_MAX_DEPTH;
	const maxFiles = limits.maxFiles ?? USAGE_WALK_MAX_FILES;
	try {
		const top = await fs.lstat(root.dir);
		if (top.isSymbolicLink() || !top.isDirectory()) return [];
	} catch {
		return [];
	}
	const files: UsageRecordFile[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root.dir, depth: 0 }];
	while (queue.length > 0 && files.length < maxFiles) {
		const { dir, depth } = queue.shift()!;
		let entries: Awaited<ReturnType<UsageFs['readdir']>>;
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const path = api.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth + 1 <= maxDepth) queue.push({ dir: path, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
			try {
				const stat = await fs.lstat(path);
				if (stat.isSymbolicLink() || !stat.isFile()) continue;
				files.push({ provider: root.provider, path, size: stat.size, mtimeMs: stat.mtimeMs });
			} catch {
				continue;
			}
			if (files.length >= maxFiles) break;
		}
	}
	return files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}
