/**
 * Fleet computer health (FL-03) — the per-beat health snapshot a node
 * reports, the bounds both ends hold it to, and the two pure judgements
 * every surface shares: which plain-language STATE a computer is in, and
 * how low its disk is.
 *
 * ## Report, never obey
 *
 * Health flows up only. The node measures and says what it measured; the
 * platform stores what it was told and derives words from it. Nothing in
 * here is ever pushed down to a machine or enforced on it — the same rule
 * the node's housekeeping report states for the disk floor.
 *
 * ## Absent is not zero
 *
 * Every field of {@link FleetNodeHealthSnapshot} is optional and is ABSENT
 * when its probe failed, timed out, or does not exist on that operating
 * system (load average on Windows, pending reboot on macOS). Surfaces
 * render an absent value as "—", never as `0`: "0 failed services" and "we
 * could not ask" are different facts, and only the first is reassuring.
 * {@link sanitizeFleetNodeHealthSnapshot} enforces that at both ends by
 * DROPPING a value it cannot trust rather than clamping it into range —
 * a clamped 100% CPU would be a number the machine never reported.
 *
 * `gpu` is the one field with three states: absent (not known), `null`
 * (the machine was asked and has no GPU), or a list of the GPUs it has.
 *
 * Shape: CONTRACTS §4.5 (revision 3) — one sample's columns plus
 * `cpuCores`, `memUsedMiB`, `diskTotalMiB` and the GPU list.
 */

import { FLEET_NODE_UPGRADE_COMMAND, type FleetNodeStatus, type FleetNodeWorkerState } from './fleet-node.types.js';
import type { FleetNodeModelThrottleView } from './fleet-model-usage-limit.types.js';

// ─── Limits (CONTRACTS §10) ─────────────────────────────────────────────────

/** A node probe gets this long per fact; a fact that takes longer is dropped for that beat (FR-6). */
export const FLEET_HEALTH_PROBE_TIMEOUT_MS = 2_000;

/** At most one stored sample per computer per this many ms (FR-18; the beat is 60 s). */
export const FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS = 55_000;

/** Raw samples are kept this long (CONTRACTS §4.5, §10: 7 days). */
export const FLEET_HEALTH_RAW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Hourly roll-ups are kept this long (CONTRACTS §4.5, §10: 90 days). */
export const FLEET_HEALTH_HOURLY_RETENTION_MS = 90 * 24 * 60 * 60_000;

/**
 * The hourly roll-up + retention pass, at :07 — off the top of the hour and
 * off the other sweeps. Shared by the Trigger.dev task and the API's
 * in-process fallback (used only when Trigger.dev is not the runtime), so the
 * pass runs on the same schedule whichever scheduler fires it.
 */
export const FLEET_HEALTH_ROLLUP_CRON = '7 * * * *';

/** The history endpoint answers at most this many points per series (FR-20). */
export const FLEET_HEALTH_MAX_HISTORY_POINTS = 500;

/** `disk-low` is critical at or below the node's own floor plus this margin (FR-12). */
export const FLEET_HEALTH_DISK_CRITICAL_MARGIN_BYTES = 1024 ** 3;

/** `disk-low` is a warning below this fraction of the volume free (FR-12). */
export const FLEET_HEALTH_DISK_WARN_FREE_FRACTION = 0.1;

/** The GPU name string is bounded and sanitised like `workerStateReason`. */
export const FLEET_HEALTH_MAX_GPU_MODEL_LENGTH = 64;

/** At most this many GPUs are reported per machine. */
export const FLEET_HEALTH_MAX_GPUS = 16;

/** Upper bound for any MiB figure: 1 EiB. Anything above is certainly nonsense. */
export const FLEET_HEALTH_MAX_MIB = 2 ** 40;

/** Upper bound for the one-minute load average. */
export const FLEET_HEALTH_MAX_LOAD_AVG = 100_000;

/** Upper bound for the reported logical core count. */
export const FLEET_HEALTH_MAX_CORES = 4_096;

/** Upper bound for uptime: a century, in seconds. */
export const FLEET_HEALTH_MAX_UPTIME_SEC = 100 * 365 * 24 * 60 * 60;

/** Upper bound for the failed-service count. */
export const FLEET_HEALTH_MAX_FAILED_SERVICES = 10_000;

/**
 * The exact command that lifts a node's self-quarantine, printed for the
 * owner to run ON that machine. The platform cannot do it: quarantine is
 * the node's own fail-closed stop and is cleared only at its keyboard.
 */
export const FLEET_NODE_CLEAR_QUARANTINE_COMMAND = 'ever-works-node clear-quarantine --confirm-process-tree-stopped';

/**
 * The named command a "needs a look" row runs for **Clear limit now**
 * (CONTRACTS §4.6: an action navigates to a route or runs a named command the
 * web tier knows). The web maps it to the existing, audited
 * `POST /api/fleet/nodes/:id/clear-model-throttle` for the row's node, with
 * no provider: every usage limit in force on that computer, which is what
 * the row says.
 */
export const FLEET_CLEAR_MODEL_THROTTLE_COMMAND = 'fleet.clear-model-throttle';

// ─── Snapshot ───────────────────────────────────────────────────────────────

/** GPU vendors the node classifies (mirrors the node's `gpu-probe`). */
export type FleetNodeGpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';

export const FLEET_NODE_GPU_VENDORS: readonly FleetNodeGpuVendor[] = ['nvidia', 'amd', 'intel', 'apple', 'other'];

/** One GPU's facts. Utilisation and memory only where the vendor tool exposes them. */
export interface FleetNodeGpuHealth {
	vendor: FleetNodeGpuVendor;
	/** Adapter name as the vendor tool reported it, bounded; null when unknown. */
	name: string | null;
	utilPercent?: number;
	memUsedMiB?: number;
	memTotalMiB?: number;
}

/**
 * One beat's health facts (CONTRACTS §4.5 columns, plus the three the
 * metric cards need: used memory, total disk, cores). Every field is
 * optional — see the module comment for why absent is never zero.
 */
export interface FleetNodeHealthSnapshot {
	/** Host CPU busy, 0-100, averaged since the previous beat. */
	cpuPercent?: number;
	/** Host memory in use, 0-100. */
	memPercent?: number;
	memTotalMiB?: number;
	memUsedMiB?: number;
	/** How full the workspace volume is, 0-100 (used / (used + available), as `df` reports it). */
	diskPercent?: number;
	/** Bytes an unprivileged process may still write on the workspace volume, in MiB. */
	diskFreeMiB?: number;
	diskTotalMiB?: number;
	/** One-minute load average. Absent on Windows, where it is not meaningful. */
	loadAvg1?: number;
	/** Logical cores, so a load figure has its scale. */
	cpuCores?: number;
	/** How long the machine has been up — a duration, never a boot instant (U12). */
	uptimeSec?: number;
	/** Absent = not known; `null` = asked, no GPU; a list = the GPUs, first adapter first. */
	gpu?: FleetNodeGpuHealth[] | null;
	/** The operating system is waiting for a restart. Absent where it is not exposed. */
	pendingReboot?: boolean;
	/** Services the service manager reports as failed. Absent where not cheaply knowable. */
	failedServices?: number;
}

/** Every field a node reports in a snapshot — what {@link hasFleetNodeHealthReading} looks for. */
const SNAPSHOT_FIELDS: readonly (keyof FleetNodeHealthSnapshot)[] = [
	'cpuPercent',
	'memPercent',
	'memTotalMiB',
	'memUsedMiB',
	'diskPercent',
	'diskFreeMiB',
	'diskTotalMiB',
	'loadAvg1',
	'cpuCores',
	'uptimeSec',
	'gpu',
	'pendingReboot',
	'failedServices'
];

/**
 * True when a stored health value holds at least one fact the NODE reported.
 *
 * A row can also hold only the platform's own disk-low marker: a daemon
 * older than the snapshot reports free disk and its floor but no snapshot,
 * and the platform still needs one stable instant for its `disk-low` item
 * (FR-17). Such a value is `{ at, diskLowSince }` and is NOT a reading — every
 * surface that shows metrics, or answers "this version reports no health",
 * asks this first. `gpu: null` counts: it means "asked, no GPU".
 */
export function hasFleetNodeHealthReading(stored: FleetNodeHealthSnapshot | null | undefined): boolean {
	if (!stored || typeof stored !== 'object') return false;
	return SNAPSHOT_FIELDS.some((field) => stored[field] !== undefined);
}

/** The snapshot as the platform stores and serves it: stamped with the platform's RECEIPT time. */
export interface FleetNodeHealthStored extends FleetNodeHealthSnapshot {
	/** ISO instant the platform received the beat (never the machine's clock — U12). */
	at: string;
	/**
	 * Platform bookkeeping, not a machine fact: the receipt time of the
	 * first beat in the current run of beats whose disk was low
	 * ({@link diskLowSeverity} non-null). Carried forward beat to beat and
	 * dropped the first beat the disk is no longer low, so the `disk-low`
	 * item keeps one `since` for as long as its condition lasts (FR-17).
	 */
	diskLowSince?: string;
	/**
	 * Platform bookkeeping, not a machine fact: the receipt time of the last
	 * beat whose snapshot was written to the history. Read back from the row
	 * on the next beat, so "at most one sample per computer per 55 s" (FR-18)
	 * holds across every API replica — a node may beat every 5 s, and an
	 * in-process memory of the last write would let each replica write its
	 * own. Absent while history is switched off.
	 */
	sampledAt?: string;
}

/** `GET /api/fleet/nodes/:id/health` — one computer's health, as every surface reads it. */
export interface FleetNodeHealthView {
	nodeId: string;
	/** The latest snapshot, stamped with the platform's receipt time; null = this node version reports none. */
	snapshot: FleetNodeHealthStored | null;
	/** Older than the offline threshold: shown dimmed with its age, never as current (FR-5, FR-30). */
	stale: boolean;
	/** The plain-language state and its one fix (FR-7, FR-8). */
	state: ComputerStateResolution;
	/** Whether this deployment keeps health history (`FLEET_HEALTH_HISTORY_ENABLED`). */
	historyEnabled: boolean;
}

/** History resolutions — one table, one discriminator (CONTRACTS §4.5). */
export type FleetNodeHealthResolution = 'raw' | 'hourly';

export const FLEET_NODE_HEALTH_RESOLUTIONS: readonly FleetNodeHealthResolution[] = ['raw', 'hourly'];

/** History ranges the chart offers (spec §5.7). */
export type FleetNodeHealthRange = '1h' | '24h' | '7d' | '90d';

export const FLEET_NODE_HEALTH_RANGES: readonly FleetNodeHealthRange[] = ['1h', '24h', '7d', '90d'];

// ─── Sanitising ─────────────────────────────────────────────────────────────

function finiteIn(value: unknown, min: number, max: number): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (value < min || value > max) return null;
	return value;
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function percent(value: unknown): number | null {
	const v = finiteIn(value, 0, 100);
	return v === null ? null : round(v, 1);
}

function wholeIn(value: unknown, min: number, max: number): number | null {
	const v = finiteIn(value, min, max);
	return v === null ? null : Math.floor(v);
}

/** One line, no control characters, bounded — so a model name renders in a card. */
function boundedText(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value
		.replace(/[\u0000-\u001F\u007F]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned ? cleaned.slice(0, max) : null;
}

function sanitizeOneGpu(raw: unknown): FleetNodeGpuHealth | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	const vendor = FLEET_NODE_GPU_VENDORS.includes(source.vendor as FleetNodeGpuVendor)
		? (source.vendor as FleetNodeGpuVendor)
		: 'other';
	const gpu: FleetNodeGpuHealth = {
		vendor,
		name: boundedText(source.name, FLEET_HEALTH_MAX_GPU_MODEL_LENGTH)
	};
	const util = percent(source.utilPercent);
	if (util !== null) gpu.utilPercent = util;
	const used = wholeIn(source.memUsedMiB, 0, FLEET_HEALTH_MAX_MIB);
	const total = wholeIn(source.memTotalMiB, 0, FLEET_HEALTH_MAX_MIB);
	// A used figure larger than the total is a broken reading: drop the pair
	// rather than show "9 / 8 GiB".
	if (used !== null && total !== null && used > total) return gpu;
	if (used !== null) gpu.memUsedMiB = used;
	if (total !== null) gpu.memTotalMiB = total;
	return gpu;
}

/** `null` stays "no GPU"; a list keeps its sane entries (bounded); anything else is "not known". */
function sanitizeGpu(raw: unknown): FleetNodeGpuHealth[] | null | undefined {
	if (raw === null) return null;
	if (!Array.isArray(raw)) return undefined;
	const gpus = raw
		.slice(0, FLEET_HEALTH_MAX_GPUS)
		.map(sanitizeOneGpu)
		.filter((gpu): gpu is FleetNodeGpuHealth => gpu !== null);
	// An empty list is "asked, none" — the same fact as null, said one way.
	if (gpus.length === 0) return raw.length === 0 ? null : undefined;
	return gpus;
}

/**
 * Keep only the snapshot fields this build knows, each within its bounds.
 *
 * Used at BOTH ends: the node runs it before sending (so a probe bug never
 * puts a nonsense figure on the wire), the platform runs it on receipt (so
 * an older or broken node never stores one). A value outside its bounds is
 * DROPPED, not clamped — the stored snapshot must only ever hold numbers
 * the machine actually reported (FR-4, FR-30). Unknown keys are ignored.
 *
 * Returns null when nothing usable remains, so "no snapshot" stays "no
 * snapshot" rather than an empty object that would render as all dashes
 * with a fresh timestamp.
 */
export function sanitizeFleetNodeHealthSnapshot(raw: unknown): FleetNodeHealthSnapshot | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	const out: FleetNodeHealthSnapshot = {};

	const cpu = percent(source.cpuPercent);
	if (cpu !== null) out.cpuPercent = cpu;
	const mem = percent(source.memPercent);
	if (mem !== null) out.memPercent = mem;
	const memTotal = wholeIn(source.memTotalMiB, 0, FLEET_HEALTH_MAX_MIB);
	const memUsed = wholeIn(source.memUsedMiB, 0, FLEET_HEALTH_MAX_MIB);
	if (memTotal !== null) out.memTotalMiB = memTotal;
	if (memUsed !== null && (memTotal === null || memUsed <= memTotal)) out.memUsedMiB = memUsed;

	const disk = percent(source.diskPercent);
	if (disk !== null) out.diskPercent = disk;
	const diskFree = wholeIn(source.diskFreeMiB, 0, FLEET_HEALTH_MAX_MIB);
	const diskTotal = wholeIn(source.diskTotalMiB, 0, FLEET_HEALTH_MAX_MIB);
	if (diskTotal !== null) out.diskTotalMiB = diskTotal;
	if (diskFree !== null && (diskTotal === null || diskFree <= diskTotal)) out.diskFreeMiB = diskFree;

	const load = finiteIn(source.loadAvg1, 0, FLEET_HEALTH_MAX_LOAD_AVG);
	if (load !== null) out.loadAvg1 = round(load, 2);
	const cores = wholeIn(source.cpuCores, 1, FLEET_HEALTH_MAX_CORES);
	if (cores !== null) out.cpuCores = cores;
	const uptime = wholeIn(source.uptimeSec, 0, FLEET_HEALTH_MAX_UPTIME_SEC);
	if (uptime !== null) out.uptimeSec = uptime;

	const gpu = sanitizeGpu(source.gpu);
	if (gpu !== undefined) out.gpu = gpu;

	if (typeof source.pendingReboot === 'boolean') out.pendingReboot = source.pendingReboot;
	const failed = wholeIn(source.failedServices, 0, FLEET_HEALTH_MAX_FAILED_SERVICES);
	if (failed !== null) out.failedServices = failed;

	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Is a stored snapshot too old to be shown as current (FR-5, FR-30)?
 *
 * Judged against the same silence after which the platform sweeps a node
 * offline, so "stale" and "offline" agree. An unparseable stamp is stale:
 * a value we cannot date is never presented as fresh.
 */
export function isFleetNodeHealthStale(
	stored: Pick<FleetNodeHealthStored, 'at'> | null | undefined,
	now: number | Date,
	thresholdMs: number
): boolean {
	if (!stored) return true;
	const at = Date.parse(stored.at);
	if (!Number.isFinite(at)) return true;
	const nowMs = typeof now === 'number' ? now : now.getTime();
	return nowMs - at > thresholdMs;
}

// ─── Disk low (FR-12) ───────────────────────────────────────────────────────

export type FleetDiskLowSeverity = 'critical' | 'warn';

export interface FleetDiskLowInput {
	/** Free bytes on the workspace volume, or null when unknown. */
	freeBytes: number | null | undefined;
	/** Volume size in bytes, or null when unknown (an older node reports free only). */
	totalBytes: number | null | undefined;
	/**
	 * The node's own free-space floor, or null when it is switched off or
	 * was never reported — in which case only the percentage rule applies
	 * (spec §8b: a floor that is not in force is not "the number at which
	 * the machine stops").
	 */
	floorBytes: number | null | undefined;
}

function finiteNonNegative(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * How low is this computer's disk?
 *
 *   - `critical` at or below the node's own floor plus 1 GiB: within a
 *     gigabyte of the point where the machine refuses work;
 *   - `warn` below 10% of the volume free;
 *   - null otherwise, and null when free space is unknown.
 */
export function diskLowSeverity(input: FleetDiskLowInput): FleetDiskLowSeverity | null {
	const free = finiteNonNegative(input.freeBytes);
	if (free === null) return null;
	const floor = finiteNonNegative(input.floorBytes);
	if (floor !== null && free <= floor + FLEET_HEALTH_DISK_CRITICAL_MARGIN_BYTES) return 'critical';
	const total = finiteNonNegative(input.totalBytes);
	if (total !== null && total > 0 && free < total * FLEET_HEALTH_DISK_WARN_FREE_FRACTION) return 'warn';
	return null;
}

/** Bytes in one MiB — the unit every health figure travels in. */
export const FLEET_HEALTH_BYTES_PER_MIB = 1024 * 1024;

/**
 * The disk-low input for one computer, built the same way by every caller:
 * free space from the byte-precise `diskFreeBytes` the beat already carries
 * (falling back to the snapshot's MiB figure), the volume size from the
 * snapshot (older nodes do not report it, so only the floor rule can fire
 * for them), and the floor the node reports enforcing.
 */
export function fleetNodeDiskLowInput(node: {
	diskFreeBytes?: number | null;
	minFreeDiskBytes?: number | null;
	health?: Pick<FleetNodeHealthSnapshot, 'diskFreeMiB' | 'diskTotalMiB'> | null;
}): FleetDiskLowInput {
	const healthFree =
		typeof node.health?.diskFreeMiB === 'number' ? node.health.diskFreeMiB * FLEET_HEALTH_BYTES_PER_MIB : null;
	const total =
		typeof node.health?.diskTotalMiB === 'number' ? node.health.diskTotalMiB * FLEET_HEALTH_BYTES_PER_MIB : null;
	return {
		freeBytes: finiteNonNegative(node.diskFreeBytes) ?? healthFree,
		totalBytes: total,
		floorBytes: node.minFreeDiskBytes ?? null
	};
}

// ─── Computer state (FR-7, FR-8) ────────────────────────────────────────────

/**
 * The closed set of plain-language states a computer is in. `limited` is a
 * model CLI's usage limit; `throttled` is a resource ceiling (CPU, memory,
 * disk floor). Exactly one applies at a time.
 */
export type ComputerState =
	| 'online'
	| 'busy'
	| 'offline'
	| 'enrolling'
	| 'paused'
	| 'disabled'
	| 'draining'
	| 'quarantined'
	| 'throttled'
	| 'limited'
	| 'upgrade-required';

export const COMPUTER_STATES: readonly ComputerState[] = [
	'online',
	'busy',
	'offline',
	'enrolling',
	'paused',
	'disabled',
	'draining',
	'quarantined',
	'throttled',
	'limited',
	'upgrade-required'
];

/** The one fix a state offers (FR-8). Rendered by each surface in its own words. */
export type ComputerStateAction =
	/** Offline, and a sibling on the same network can wake it (FL-03 P2). */
	| { kind: 'wake' }
	/** A command the owner runs ON the machine; the platform cannot do it. */
	| { kind: 'copy-command'; command: string }
	/** The existing `POST /api/fleet/nodes/:id/clear-model-throttle`; no provider = all. */
	| { kind: 'clear-model-throttle'; provider?: string }
	/** The existing limits section (remote node limits). */
	| { kind: 'change-limits' };

/** Which resource ceiling refused new work. */
export type ComputerThrottleDimension = 'cpu' | 'memory' | 'disk';

/**
 * Values a state's sentence interpolates. Every one is a value the node or
 * the platform reported — never one inferred here (FR-30).
 */
export interface ComputerStateParams {
	/** `busy`: jobs in flight, when the job service reported them. */
	jobs?: number;
	/** `offline`: the last accepted beat. */
	lastSeenAt?: string | null;
	/** `quarantined` / generic `throttled`: the node's own reason. */
	reason?: string | null;
	/** `throttled`: the dimension, and the reading and ceiling the node reported. */
	dimension?: ComputerThrottleDimension;
	value?: number;
	limit?: number;
	/** `limited`: the CLI whose limit resets FIRST, and when. */
	provider?: string;
	until?: string;
	/** `limited`: how many CLIs are out of quota (sentence switches to plural above 1). */
	limitedCount?: number;
}

export interface ComputerStateResolution {
	state: ComputerState;
	params: ComputerStateParams;
	/** At most one fix (FR-8); null for states that have none. */
	action: ComputerStateAction | null;
}

/** The facts the state is derived from — a structural subset of `FleetNodeView`. */
export interface ComputerStateInput {
	status: FleetNodeStatus;
	capabilities?: readonly string[] | null;
	lastHeartbeatAt?: string | null;
	workerState?: FleetNodeWorkerState | null;
	workerStateReason?: string | null;
	modelThrottles?: readonly FleetNodeModelThrottleView[] | null;
	upgradeRequired?: boolean;
	load?: { activeJobCount?: number | null } | null;
	health?: FleetNodeHealthStored | null;
	diskFreeBytes?: number | null;
	minFreeDiskBytes?: number | null;
	effectiveLimits?: { maxCpuPercent?: number | null; maxMemoryMb?: number | null } | null;
}

export interface ResolveComputerStateOptions {
	/** "Now", for discarding expired model throttles. */
	now?: number | Date;
	/** FL-03 P2: whether Wake is possible for this computer (offline only). */
	canWake?: boolean;
	/**
	 * The silence after which a computer is offline (the platform's
	 * `FLEET_NODE_OFFLINE_AFTER_MS`). When given, a computer whose last beat is
	 * older than this — or that never beat — reads `offline` whatever its stored
	 * `status` says: the offline sweep runs only on the owner's list reads and
	 * flips only `online` rows, so a single-computer read, or a paused or
	 * disabled row, can still say `online` / `paused` / `disabled` hours after
	 * the machine went silent (FR-30: a stale fact is never shown as current).
	 * Omit it only where the caller has just swept.
	 */
	offlineAfterMs?: number;
}

/** True when a threshold is given and the last beat is older than it (or absent / unparseable). */
function isSilent(lastHeartbeatAt: string | null | undefined, nowMs: number, thresholdMs: number | undefined): boolean {
	if (thresholdMs === undefined || !Number.isFinite(thresholdMs)) return false;
	const at = typeof lastHeartbeatAt === 'string' ? Date.parse(lastHeartbeatAt) : NaN;
	if (!Number.isFinite(at)) return true;
	return nowMs - at > thresholdMs;
}

/** Model CLIs a node advertises as capability tags, which are also the throttle provider ids. */
const MODEL_CLI_TAGS: readonly string[] = ['claude-code', 'codex'];

function activeThrottles(
	throttles: readonly FleetNodeModelThrottleView[] | null | undefined,
	nowMs: number
): FleetNodeModelThrottleView[] {
	if (!Array.isArray(throttles)) return [];
	return throttles
		.filter((throttle) => {
			const until = Date.parse(throttle?.until);
			return typeof throttle?.provider === 'string' && Number.isFinite(until) && until > nowMs;
		})
		.sort((a, b) => Date.parse(a.until) - Date.parse(b.until));
}

/**
 * Which resource ceiling the node is over, from the STRUCTURED numbers it
 * reported (its health reading against the limit it says it enforces), in
 * the order the node's own admission gate checks them. Null when no
 * dimension can be shown to be over — the caller then falls back to the
 * node's own sentence rather than guessing.
 */
function overCeiling(input: ComputerStateInput): Pick<ComputerStateParams, 'dimension' | 'value' | 'limit'> | null {
	const health = input.health;
	const limits = input.effectiveLimits;
	const maxCpu = finiteNonNegative(limits?.maxCpuPercent);
	if (maxCpu !== null && typeof health?.cpuPercent === 'number' && health.cpuPercent >= maxCpu) {
		return { dimension: 'cpu', value: Math.round(health.cpuPercent), limit: maxCpu };
	}
	const maxMem = finiteNonNegative(limits?.maxMemoryMb);
	if (maxMem !== null && typeof health?.memUsedMiB === 'number' && health.memUsedMiB >= maxMem) {
		return { dimension: 'memory', value: health.memUsedMiB, limit: maxMem };
	}
	const floor = finiteNonNegative(input.minFreeDiskBytes);
	const free = finiteNonNegative(input.diskFreeBytes);
	if (floor !== null && free !== null && free < floor) {
		return { dimension: 'disk', value: free, limit: floor };
	}
	return null;
}

/**
 * Map a computer to exactly one state, with the values its sentence needs
 * and at most one fix.
 *
 * Precedence, most specific first — each step answers "will this machine
 * take my work, and if not, why not" with the fact the owner can act on:
 *
 *  1. `enrolling` — no first check-in yet.
 *  2. `offline` — unreachable; any other fact about it may be stale.
 *  3. `quarantined` — the machine stopped ITSELF and only its keyboard can
 *     clear it. It outranks the owner's own pause or drain: those are
 *     choices, this is a fault that persists through them.
 *  4. `draining` / `disabled` — the owner's harder stop; draining while it
 *     still finishes jobs it held.
 *  5. `paused` — by the owner (status) or the node (`ever-works-node pause`).
 *  6. `upgrade-required` — below the platform's version floor; no work.
 *  7. `throttled` — over a resource ceiling the node reported; else
 *     `limited` when a model CLI is out of quota; else `throttled` with
 *     the node's own reason.
 *  8. `limited` — no worker throttle reported, but every model CLI the
 *     node advertises is out of quota (an older node that predates the
 *     worker-side throttle). A node with one CLI still usable is NOT
 *     limited: it is taking that CLI's work.
 *  9. `busy` — jobs in flight.
 * 10. `online`.
 *
 * `online`/`busy`/`offline`/`paused`/`disabled`/`enrolling` agree with the
 * footer runner pill (`runnerRowState`) whenever no worker fact overrides
 * them.
 */
export function resolveComputerState(
	input: ComputerStateInput,
	options: ResolveComputerStateOptions = {}
): ComputerStateResolution {
	const nowMs =
		options.now === undefined ? Date.now() : typeof options.now === 'number' ? options.now : options.now.getTime();
	const jobs = finiteNonNegative(input.load?.activeJobCount ?? null);

	if (input.status === 'enrolling') return { state: 'enrolling', params: {}, action: null };
	if (input.status === 'offline' || isSilent(input.lastHeartbeatAt, nowMs, options.offlineAfterMs)) {
		return {
			state: 'offline',
			params: { lastSeenAt: input.lastHeartbeatAt ?? null },
			action: options.canWake === true ? { kind: 'wake' } : null
		};
	}
	if (input.workerState === 'quarantined') {
		return {
			state: 'quarantined',
			params: { reason: input.workerStateReason ?? null },
			action: { kind: 'copy-command', command: FLEET_NODE_CLEAR_QUARANTINE_COMMAND }
		};
	}
	if (input.status === 'disabled') {
		return jobs !== null && jobs > 0
			? { state: 'draining', params: { jobs }, action: null }
			: { state: 'disabled', params: {}, action: null };
	}
	if (input.status === 'paused' || input.workerState === 'paused') {
		return { state: 'paused', params: {}, action: null };
	}
	if (input.upgradeRequired === true) {
		return {
			state: 'upgrade-required',
			params: {},
			action: { kind: 'copy-command', command: FLEET_NODE_UPGRADE_COMMAND }
		};
	}

	const throttles = activeThrottles(input.modelThrottles, nowMs);
	const limited = (): ComputerStateResolution => {
		const first = throttles[0];
		const action: ComputerStateAction =
			throttles.length === 1
				? { kind: 'clear-model-throttle', provider: first.provider }
				: { kind: 'clear-model-throttle' };
		return {
			state: 'limited',
			params: { provider: first.provider, until: first.until, limitedCount: throttles.length },
			action
		};
	};

	if (input.workerState === 'throttled') {
		const over = overCeiling(input);
		if (over) return { state: 'throttled', params: over, action: { kind: 'change-limits' } };
		if (throttles.length > 0) return limited();
		return {
			state: 'throttled',
			params: { reason: input.workerStateReason ?? null },
			action: { kind: 'change-limits' }
		};
	}

	if (throttles.length > 0 && (jobs === null || jobs === 0) && input.workerState !== 'working') {
		const advertised = (input.capabilities ?? []).filter((tag) => MODEL_CLI_TAGS.includes(tag));
		const throttled = new Set(throttles.map((throttle) => throttle.provider));
		if (advertised.length > 0 && advertised.every((tag) => throttled.has(tag))) return limited();
	}

	if ((jobs !== null && jobs > 0) || input.workerState === 'working') {
		return { state: 'busy', params: jobs !== null && jobs > 0 ? { jobs } : {}, action: null };
	}
	return { state: 'online', params: {}, action: null };
}
