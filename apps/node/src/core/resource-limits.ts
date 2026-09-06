import { effectiveMinFreeDiskBytes, type NodeResourceLimits } from './types';

/**
 * Host resource sampling + the admission decision the worker loop makes
 * before it leases new work.
 *
 * Split from `types.ts` so the *decision* stays pure (and therefore fully
 * unit-testable without a machine under load) while the *sampling* lives
 * behind an injected probe — `node-io.ts` supplies the real `node:os`-backed
 * one, tests supply a fake, and the renderer never pulls either in.
 */

/** One observation of how busy the host is right now. */
export interface ResourceSample {
	/** Host CPU utilisation, 0-100. */
	cpuPercent: number;
	/** Host memory currently in use, in MB. */
	usedMemoryMb: number;
	/** Total host memory, in MB. Informational — used for log lines. */
	totalMemoryMb: number;
	/**
	 * Free bytes on the volume that holds the workspace root — NOT the
	 * system drive, which may be a different volume. Absent / null / NaN
	 * means the reading was unavailable, which never blocks (see the rules
	 * on {@link admitByResourceLimits}).
	 */
	diskFreeBytes?: number | null;
}

/** Which ceiling (or floor) refused admission. Set on refusals only. */
export type AdmissionDimension = 'cpu' | 'memory' | 'disk';

/**
 * Sampling seam. `sample()` may be async because a meaningful CPU reading
 * needs two observations separated in time.
 */
export interface ResourceProbe {
	sample(): Promise<ResourceSample> | ResourceSample;
}

/** Outcome of the admission check: either "go ahead" or "why not". */
export interface AdmissionDecision {
	admit: boolean;
	/** Operator-facing reason when `admit` is false; null otherwise. */
	reason: string | null;
	/** The dimension that refused; present on refusals only. */
	dimension?: AdmissionDimension;
}

export const ADMIT: AdmissionDecision = { admit: true, reason: null };

/**
 * Decide whether the node may lease MORE work right now.
 *
 * Rules:
 *   - A dimension with a `null` ceiling never blocks.
 *   - A sample that is missing / non-finite for a dimension never blocks:
 *     an unreadable probe must not silently idle a node forever. The node
 *     is the last line of defence, not the only one — the concurrency cap
 *     is always enforced regardless.
 *   - Otherwise the ceiling blocks when the sample is at or above it.
 *
 * NOTE the asymmetry with `maxConcurrentJobs`: concurrency is enforced by
 * the loop's in-flight bookkeeping (a hard cap it can compute exactly),
 * while CPU/memory are enforced here as an admission gate on a noisy
 * observation. Treating a noisy reading as a hard cap would let one
 * unrelated process on the machine wedge the node permanently.
 *
 * The disk FLOOR follows the same rules with two differences, both in
 * {@link judgeDiskFloor}: it is on unless the operator switched it off
 * (see `effectiveMinFreeDiskBytes`), and a reading that was TAKEN and came
 * back unreadable refuses rather than admits, because the provisioner's
 * gate refuses it too and two gates only compose when the earlier one is
 * at least as strict. A dimension that was never sampled still never
 * blocks. A node with 200 MB free that keeps leasing fails deep inside git
 * or pnpm, after the lease and the plan are already spent — refusing up
 * front hands the job to a machine with room.
 */
export function admitByResourceLimits(
	limits: Pick<NodeResourceLimits, 'maxCpuPercent' | 'maxMemoryMb' | 'minFreeDiskBytes'>,
	sample: ResourceSample | null | undefined
): AdmissionDecision {
	if (!sample) {
		return ADMIT;
	}
	const { maxCpuPercent, maxMemoryMb } = limits;

	if (typeof maxCpuPercent === 'number' && Number.isFinite(sample.cpuPercent)) {
		if (sample.cpuPercent >= maxCpuPercent) {
			return {
				admit: false,
				reason: `host CPU ${Math.round(sample.cpuPercent)}% is at or above the ${maxCpuPercent}% ceiling`,
				dimension: 'cpu'
			};
		}
	}

	if (typeof maxMemoryMb === 'number' && Number.isFinite(sample.usedMemoryMb)) {
		if (sample.usedMemoryMb >= maxMemoryMb) {
			return {
				admit: false,
				reason: `host memory ${Math.round(sample.usedMemoryMb)}MB in use is at or above the ${maxMemoryMb}MB ceiling`,
				dimension: 'memory'
			};
		}
	}

	return judgeDiskFloor(limits, sample) ?? ADMIT;
}

/**
 * The disk floor's own verdict, independent of CPU and memory.
 *
 * Separate from {@link admitByResourceLimits}, which reports only the
 * FIRST refusing dimension, because two callers need the disk answer even
 * when something else refused first: the worker loop's refuse/resume latch
 * (which otherwise logged "the volume is back above the floor" the moment
 * CPU also went over — review AO-7), and any caller that wants to say why
 * a node went quiet. Null means the floor is satisfied or not in force.
 *
 * ## An unreadable reading REFUSES (review AO-11)
 *
 * `undefined` means the disk was never sampled (no probe, or no floor) and
 * never blocks. `null` — and a non-finite number — is different: it is what
 * `measureWorkspaceFreeBytes` returns when it TRIED and could not answer,
 * and it now refuses.
 *
 * It used to admit, on the reasoning that a broken `statfs` must not idle
 * a machine. But the provisioner's `assertWorkspaceDiskHeadroom` refuses
 * that same reading — it is the last gate before a model's whole budget
 * lands on the volume — so the pair did not compose: the node leased every
 * job it was offered and then declined it at provision time, and each
 * deferral silently burned one of the job's attempts (the claim just
 * lapses; nothing is reported) until the platform failed the job with a
 * message that never mentioned disk. On a single-node fleet that is every
 * job, forever.
 *
 * Refusing here instead makes the node THROTTLED with a reason an operator
 * can read in the drawer, in the log and in `ever-works-node doctor` —
 * which is what "see why a node stopped accepting work" means — and
 * `--no-disk-floor` remains the explicit way to switch the control off.
 * `createDiskProbe` documents null as a persistent condition (an
 * unavailable API, an unmounted path, a permission error), not a blip.
 */
export function judgeDiskFloor(
	limits: Pick<NodeResourceLimits, 'minFreeDiskBytes'>,
	sample: Pick<ResourceSample, 'diskFreeBytes'> | null | undefined
): AdmissionDecision | null {
	const floor = effectiveMinFreeDiskBytes(limits);
	if (typeof floor !== 'number' || !sample) return null;
	const free = sample.diskFreeBytes;
	// Never sampled: the control was not asked for on this poll.
	if (free === undefined) return null;
	if (typeof free !== 'number' || !Number.isFinite(free)) {
		return {
			admit: false,
			reason: `free space on the workspace volume could not be measured, so the ${formatBytes(floor)} floor cannot be checked`,
			dimension: 'disk'
		};
	}
	if (free >= floor) return null;
	return {
		admit: false,
		reason: `workspace volume has ${formatBytes(free)} free, below the ${formatBytes(floor)} floor`,
		dimension: 'disk'
	};
}

/** True when at least one CPU/memory ceiling is set (i.e. probing is worth it). */
export function hasAdmissionCeilings(limits: Pick<NodeResourceLimits, 'maxCpuPercent' | 'maxMemoryMb'>): boolean {
	return typeof limits.maxCpuPercent === 'number' || typeof limits.maxMemoryMb === 'number';
}

/** True when the disk floor is in force (i.e. a free-space reading is worth taking). */
export function hasDiskFloor(limits: Pick<NodeResourceLimits, 'minFreeDiskBytes'>): boolean {
	return typeof effectiveMinFreeDiskBytes(limits) === 'number';
}

/**
 * Human-readable byte count for log lines and the CLI: `38 MiB`,
 * `2.0 GiB`.
 *
 * Binary throughout, and LABELLED binary (review AO-14). It divided by
 * 1024 and printed "MB" and "KB", so one refusal line read
 * `524 MB free ... below the 2.0 GiB floor` with two different unit
 * systems in one sentence and only one of them named correctly. The node
 * speaks binary because that is the unit `--min-free-disk` takes and the
 * unit `effectiveMinFreeDiskBytes` clamps in; the Fleet drawer
 * deliberately speaks DECIMAL (`runner-status.shared.ts`) to agree with
 * Explorer and Finder, and the two only reconcile if each says which it
 * is.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
	const gib = 1024 ** 3;
	const mib = 1024 ** 2;
	if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
	if (bytes >= mib) return `${Math.round(bytes / mib)} MiB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
	return `${Math.round(bytes)} B`;
}
