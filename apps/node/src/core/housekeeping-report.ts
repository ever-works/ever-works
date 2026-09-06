import { FLEET_MAX_DISK_FREE_BYTES, FLEET_MAX_WORKSPACE_COUNT } from '@ever-works/contracts';
import type { WorkspaceReapResult } from './workspaces/workspace-reaper';

/**
 * What the heartbeat says about this machine's HOUSEKEEPING (EW-803,
 * self-build program note §6, findings OPS-12 and R8).
 *
 * The defect this closes: both halves of node housekeeping were invisible
 * from the platform. A node refusing work because its workspace volume
 * had fallen under the floor reported `throttled` with a reason — good —
 * but the floor itself was never reported, so `12.4 GB free` in the
 * drawer could not be read as "fine" or "about to stop". And the reaper,
 * the thing that actually reclaims those gigabytes, wrote its outcome to
 * the node's own log file and nowhere else: from Fleet there was no way
 * to tell a machine whose reaper is keeping up from one where it has not
 * run since March.
 *
 * ## This reports; it does not obey
 *
 * `minFreeDiskBytes` travels UP only. The floor is still evaluated
 * entirely on the node — `admitByResourceLimits` at the lease,
 * `FleetTaskWorkspaceProvisioner.assertDiskHeadroom` before the first
 * byte — and nothing on the platform sets it, reads it back down, or is
 * entitled to assume a node respects it. That is deliberate and it is
 * the invariant in `types.ts`: lending a machine has to stay bounded from
 * the machine's own side. Publishing a read-only figure for an operator
 * to look at does not weaken that; accepting one from the platform would,
 * which is why no such path exists.
 *
 * The CPU and memory ceilings are NOT reported. They have the same
 * enforcement story, but no reported figure beside them to make sense of
 * — the node sends no CPU or memory reading at all — so a ceiling on its
 * own would be a number with nothing to compare it against.
 *
 * ## Every field is optional, and absent is not zero
 *
 * A field the node cannot vouch for is OMITTED rather than sent as a
 * zero or a null, because the server reads an absent field as "leave the
 * stored value alone". A machine whose first reclaim sweep has not run
 * yet reports the floor and nothing else, and the drawer says "unknown"
 * — never "0 workspaces", which would read as a tidy machine rather than
 * an unmeasured one.
 */
export interface NodeHousekeepingReport {
	/** The disk floor in force, in bytes; `null` when the operator switched it off. */
	minFreeDiskBytes?: number | null;
	/** Workspaces retained by the last completed sweep. */
	workspaceCount?: number;
	/** Bytes those retained workspaces occupy. */
	workspaceBytes?: number;
	/** ISO-8601 instant the last sweep completed, on this machine's clock. */
	lastReclaimAt?: string;
	/** Bytes that sweep reclaimed. */
	lastReclaimFreedBytes?: number;
}

/** The post-sweep picture, derived from a reap result alone. */
export interface WorkspaceReapSummary {
	/** Worktrees still on disk when the sweep finished. */
	workspaceCount: number;
	/** Bytes those worktrees and their retained pools occupy. */
	workspaceBytes: number;
	/** Bytes the sweep actually reclaimed (always 0 for a dry run). */
	freedBytes: number;
	/** True when the sweep only planned; nothing was removed. */
	dryRun: boolean;
}

/**
 * Project a reap result onto the figures the heartbeat carries.
 *
 * Read off `kept`, not off the inventory the scan started from, because
 * `kept` is the POST-sweep truth: it holds the plan's keeps plus every
 * removal that failed its final re-check, which is exactly the set still
 * occupying the volume. Deriving it as `totalBytes - freedBytes` instead
 * would quietly drift the moment a removal was refused.
 *
 * A dry run reports the inventory it measured but claims NO reclaim: its
 * `freedBytes` is what could be freed, and reporting a hypothetical as an
 * accomplished reclaim is the one way this figure could actively mislead.
 */
export function summarizeWorkspaceReap(result: WorkspaceReapResult): WorkspaceReapSummary {
	const dryRun = result.dryRun === true;
	// A dry run leaves everything on disk, so its retained set is
	// `kept` PLUS everything it merely planned to remove.
	const worktrees = dryRun ? result.kept.length + result.removed.length : result.kept.length;
	const keptBytes = result.kept.reduce((sum, verdict) => sum + safeBytes(verdict.record.sizeBytes), 0);
	const keptPoolBytes = result.keptPools.reduce((sum, verdict) => sum + safeBytes(verdict.pool.sizeBytes), 0);
	const plannedBytes = dryRun
		? result.removed.reduce((sum, entry) => sum + safeBytes(entry.freedBytes), 0) +
			result.removedPools.reduce((sum, entry) => sum + safeBytes(entry.freedBytes), 0)
		: 0;
	return {
		workspaceCount: worktrees,
		workspaceBytes: keptBytes + keptPoolBytes + plannedBytes,
		freedBytes: dryRun ? 0 : safeBytes(result.freedBytes),
		dryRun
	};
}

function safeBytes(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface NodeHousekeepingReporterOptions {
	/** The floor in force on this node, from `effectiveMinFreeDiskBytes(limits)`. */
	minFreeDiskBytes: number | null;
	/** Wall clock for the reclaim stamp; tests inject one. */
	now?: () => number;
}

/**
 * Holds what the last reclaim sweep found, so the heartbeat can report
 * it.
 *
 * A tiny mutable box on purpose. The reaper timer is started by the CLI
 * shell, AFTER `createNodeRuntime` has already built the `describe`
 * closure the beat calls — the same ordering constraint `telemetry.
 * workerHealth` lives with — so the two are joined by an object both can
 * reach rather than by passing the result through a constructor.
 */
export class NodeHousekeepingReporter {
	private readonly minFreeDiskBytes: number | null;
	private readonly now: () => number;
	/** What is on disk. Refreshed by EVERY sweep, dry runs included — they measure too. */
	private inventory: { workspaceCount: number; workspaceBytes: number } | null = null;
	/**
	 * The last real reclaim. The instant and the bytes are held TOGETHER,
	 * as one value, because they are only meaningful as a pair: a dry run
	 * that refreshed the bytes but not the instant would report "0 bytes
	 * freed" against a real sweep that freed four gigabytes.
	 */
	private reclaim: { at: number; freedBytes: number } | null = null;

	constructor(options: NodeHousekeepingReporterOptions) {
		this.minFreeDiskBytes = options.minFreeDiskBytes;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Record a completed sweep. Called by the reaper timer after every
	 * cycle, including one that removed nothing — "it ran and found
	 * nothing to take" is the reassuring answer, and it is only reassuring
	 * if the timestamp moves.
	 */
	record(result: WorkspaceReapResult): void {
		const summary = summarizeWorkspaceReap(result);
		this.inventory = {
			workspaceCount: summary.workspaceCount,
			workspaceBytes: summary.workspaceBytes
		};
		// A dry run is not a reclaim and must not touch the reclaim pair:
		// `gc --dry-run` in a second process would otherwise make an
		// in-process reaper that has been dead for weeks look freshly run.
		if (!summary.dryRun) this.reclaim = { at: this.now(), freedBytes: summary.freedBytes };
	}

	/** The heartbeat's view. Never throws; a field it cannot vouch for is absent. */
	describe(): NodeHousekeepingReport {
		const report: NodeHousekeepingReport = {};
		// The floor is reported even as `null` ("switched off"), because
		// that is a decision an operator made and needs to see, and it is
		// known from startup rather than waiting on the first sweep.
		if (this.minFreeDiskBytes === null || isReportableBytes(this.minFreeDiskBytes)) {
			report.minFreeDiskBytes = this.minFreeDiskBytes;
		}
		const inventory = this.inventory;
		if (inventory) {
			// Dropped, not clamped, past the contract's ceiling: a clamped
			// count is one an operator would believe.
			if (
				Number.isInteger(inventory.workspaceCount) &&
				inventory.workspaceCount >= 0 &&
				inventory.workspaceCount <= FLEET_MAX_WORKSPACE_COUNT
			) {
				report.workspaceCount = inventory.workspaceCount;
			}
			if (isReportableBytes(inventory.workspaceBytes)) {
				report.workspaceBytes = Math.floor(inventory.workspaceBytes);
			}
		}
		const reclaim = this.reclaim;
		if (reclaim && Number.isFinite(reclaim.at)) {
			const stamp = new Date(reclaim.at);
			// All or nothing: a freed-bytes figure with no instant attached
			// is unreadable, and an instant is worth reporting on its own.
			if (!Number.isNaN(stamp.getTime())) {
				report.lastReclaimAt = stamp.toISOString();
				if (isReportableBytes(reclaim.freedBytes)) {
					report.lastReclaimFreedBytes = Math.floor(reclaim.freedBytes);
				}
			}
		}
		return report;
	}
}

/** A byte count this node is willing to put on the wire: finite, non-negative, under the contract ceiling. */
function isReportableBytes(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= FLEET_MAX_DISK_FREE_BYTES;
}
