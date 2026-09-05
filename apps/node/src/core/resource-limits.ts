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
 * The disk FLOOR follows the same three rules, with one difference in
 * defaults: it is on unless the operator switched it off (see
 * `effectiveMinFreeDiskBytes`). A node with 200 MB free that keeps leasing
 * fails deep inside git or pnpm, after the lease and the plan are already
 * spent — refusing up front hands the job to a machine with room.
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

	const floor = effectiveMinFreeDiskBytes(limits);
	const free = sample.diskFreeBytes;
	if (typeof floor === 'number' && typeof free === 'number' && Number.isFinite(free)) {
		if (free < floor) {
			return {
				admit: false,
				reason: `workspace volume has ${formatBytes(free)} free, below the ${formatBytes(floor)} floor`,
				dimension: 'disk'
			};
		}
	}

	return ADMIT;
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
 * Human-readable byte count for log lines and the CLI: `38 MB`, `2.0 GiB`.
 * Binary units above the MB mark because that is what the floor is set in
 * and what an operator compares against a disk-usage dialog.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
	const gib = 1024 ** 3;
	const mib = 1024 ** 2;
	if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
	if (bytes >= mib) return `${Math.round(bytes / mib)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Math.round(bytes)} B`;
}
