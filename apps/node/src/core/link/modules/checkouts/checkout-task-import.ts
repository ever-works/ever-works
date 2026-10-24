import { stripFleetRemoteCredential, type FleetNodeCheckoutRecord } from '@ever-works/contracts';
import type { WorkspaceInventory } from '../../../workspaces/workspace-inventory';

/**
 * Checkouts on computers (FL-14, spec FR-7, ACC-FL14-04) — the node's own
 * per-Task worktrees, shown as checkouts of kind `worktree` created by
 * `task`, WITHOUT changing how the node provisions or reaps them.
 *
 * Read from the workspace inventory (`scanWorkspaceRoot`, offline — no remote
 * round trip), which already knows each worktree's branch, HEAD, size, lease
 * and last use; the remote comes from its bare pool. The reaper keeps its own
 * rules; the row only says when the reaper would tidy it (spec §5.2).
 */

export interface TaskImportOptions {
	/** The reaper's max age, to say "would be tidied in N d" (null: no age rule). */
	reaperMaxAgeMs?: number | null;
	now?: () => number;
}

function days(ms: number): number {
	return Math.max(0, Math.round(ms / 86_400_000));
}

/** The note a Task worktree's row carries about the reaper, or null. Pure. */
export function reaperNoteFor(
	lastUsedAt: number | null,
	owned: boolean,
	maxAgeMs: number | null | undefined,
	now: number
): string | null {
	if (!owned || lastUsedAt === null || !maxAgeMs || maxAgeMs <= 0) return null;
	const unused = now - lastUsedAt;
	const remaining = maxAgeMs - unused;
	if (remaining <= 0) return `Would be tidied at the next clean-up (unused ${days(unused)} d)`;
	return `Would be tidied in ${Math.max(1, days(remaining))} d (unused ${days(unused)} d)`;
}

/** Task worktrees as checkout records (no git line yet: the module reads it). Pure over the inventory. */
export function taskCheckoutRecords(
	inventory: WorkspaceInventory,
	options: TaskImportOptions = {}
): FleetNodeCheckoutRecord[] {
	const now = (options.now ?? (() => Date.now()))();
	const records: FleetNodeCheckoutRecord[] = [];
	for (const repository of inventory.repositories) {
		for (const tree of repository.worktrees) {
			const pool = tree.poolPath
				? repository.pools.find((candidate) => candidate.path === tree.poolPath)
				: undefined;
			const remote = pool?.remoteUrl ? stripFleetRemoteCredential(pool.remoteUrl) : null;
			const busy = tree.lease?.alive ? 'lease' : tree.intentPending ? 'operation' : null;
			records.push({
				path: tree.path,
				checkoutId: null,
				kind: 'worktree',
				origin: 'task',
				parentPath: null,
				remoteUrl: remote?.url ?? null,
				remoteHadCredential: remote?.hadCredential === true,
				branch: tree.branch,
				baseRef: null,
				headSha: tree.headSha && /^[0-9a-f]{7,64}$/i.test(tree.headSha) ? tree.headSha : null,
				isolation: 'host',
				present: true,
				gitLine: null,
				sizeBytes: Number.isFinite(tree.sizeBytes) && tree.sizeBytes > 0 ? tree.sizeBytes : null,
				busy,
				reaperNote: reaperNoteFor(tree.lastUsedAt, tree.owned, options.reaperMaxAgeMs, now),
				lastUsedAt: tree.lastUsedAt !== null ? new Date(tree.lastUsedAt).toISOString() : null
			});
		}
	}
	return records;
}
