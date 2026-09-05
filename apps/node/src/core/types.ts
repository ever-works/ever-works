/**
 * Node-local types, plus the node's view of the shared Fleet contract.
 *
 * The enroll/heartbeat wire shapes and their protocol bounds are NOT
 * defined here any more — they live in `@ever-works/contracts`
 * (`fleet/fleet-node.types.ts`), the zero-dependency package the API,
 * the web tier and this app all already depend on. This file re-exports
 * them under the names the node code has always used, so a change to
 * the contract now breaks the node at COMPILE time instead of at 3am on
 * a machine nobody is watching (which is the entire reason the mirror
 * that used to live here was a bug).
 *
 * What is still genuinely local: {@link NodeConfig} — how THIS app
 * persists its enrollment on disk. That is not a wire shape and the
 * server has no opinion about it.
 */

import {
	FLEET_CREDENTIAL_MAX_LENGTH,
	FLEET_CREDENTIAL_MIN_LENGTH,
	FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH,
	FLEET_DEFAULT_MAX_CAPABILITY_TAGS,
	FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS,
	FLEET_MAX_PLATFORM_LENGTH,
	FLEET_MAX_VERSION_LENGTH,
	type FleetEnrollableNodeKind,
	type FleetNodeSelfDescription
} from '@ever-works/contracts';

export type {
	FleetEnrollableNodeKind,
	FleetEnrollRequest,
	FleetEnrollResponse,
	FleetHeartbeatRequest,
	FleetHeartbeatResponse,
	FleetNodeKind,
	FleetNodeSelfDescription,
	FleetNodeStatus,
	FleetNodeView
} from '@ever-works/contracts';
export { FLEET_ENROLLABLE_NODE_KINDS, isFleetEnrollableNodeKind } from '@ever-works/contracts';

/**
 * The node's historical name for the shared
 * {@link FleetNodeSelfDescription}. Kept as an alias so the whole app
 * did not have to be renamed to adopt the shared contract.
 */
export type NodeSelfDescription = FleetNodeSelfDescription;

/**
 * Server-side caps, re-exported under the node's short names.
 *
 * The tag caps are operator-tunable on the server (`config.fleet.*`);
 * these are the DEFAULTS, which is the best a node can assume — it
 * normalizes to them so what it reports is what the platform stores. A
 * server configured with a LOWER cap still truncates authoritatively;
 * one configured higher simply accepts everything the node sends.
 */
export const MAX_CAPABILITY_TAGS = FLEET_DEFAULT_MAX_CAPABILITY_TAGS;
export const MAX_CAPABILITY_TAG_LENGTH = FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH;
export const MAX_PLATFORM_LENGTH = FLEET_MAX_PLATFORM_LENGTH;
export const MAX_VERSION_LENGTH = FLEET_MAX_VERSION_LENGTH;
export const MIN_CREDENTIAL_LENGTH = FLEET_CREDENTIAL_MIN_LENGTH;
export const MAX_CREDENTIAL_LENGTH = FLEET_CREDENTIAL_MAX_LENGTH;

/** Default heartbeat cadence — comfortably inside the server's stale window. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Backoff ceiling. Capped at the server's DEFAULT offline window
 * (5 minutes): once the platform has already flipped us to `offline`
 * there is nothing to gain from backing off further, and a longer
 * ceiling would leave a recovered node dark for many extra minutes.
 */
export const MAX_HEARTBEAT_BACKOFF_MS = FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS;

/** Floor/ceiling for the operator-configurable heartbeat interval. */
export const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Resource limits (wizard step 4 — "how much of this machine may be used")
// ---------------------------------------------------------------------------

/**
 * Ceilings the operator sets on how much of THIS machine the platform may
 * consume. They are enforced entirely on the node — the platform never learns
 * them and never has to be trusted to respect them, which is the whole point:
 * lending a machine has to be revocable and bounded from the machine's side.
 *
 * - `maxConcurrentJobs` is a hard cap on the worker loop's in-flight set.
 * - `maxCpuPercent` / `maxMemoryMb` are *admission* ceilings: the loop refuses
 *   to lease NEW work while the host is above them. They deliberately do NOT
 *   kill running jobs — a job that is already executing has a lease the
 *   platform is waiting on, and abandoning it mid-flight would just get the
 *   work re-offered to the same over-loaded machine.
 *
 * `null` means "no ceiling for this dimension".
 *
 * `minFreeDiskBytes` is the one FLOOR, and the one dimension that is on by
 * default: a node below it does not lease, and re-checks right before it
 * provisions a workspace (self-build program note §6, OPS-12). The key is
 * OPTIONAL rather than always present so that a config written by an older
 * build — and the exhaustive three-key `toEqual` assertions in
 * `apps/desktop-node` and `capability-selection.spec.ts` that pass through
 * `clampResourceLimits` — keep their shape: absent means "the default floor
 * applies", an explicit `null` means "the operator switched the floor off".
 * Do NOT move it into {@link DEFAULT_RESOURCE_LIMITS}; that is exactly what
 * would red those assertions.
 */
export interface NodeResourceLimits {
	maxConcurrentJobs: number;
	/** Refuse to lease while host CPU utilisation exceeds this (1-100), or null. */
	maxCpuPercent: number | null;
	/** Refuse to lease while host memory IN USE exceeds this many MB, or null. */
	maxMemoryMb: number | null;
	/**
	 * Refuse to lease (and to provision) while the workspace volume has fewer
	 * free bytes than this. Absent = {@link DEFAULT_MIN_FREE_DISK_BYTES};
	 * `null` = no floor.
	 */
	minFreeDiskBytes?: number | null;
}

/** Concurrency bounds. The upper bound matches the server's max lease batch. */
export const MIN_CONCURRENT_JOBS = 1;
export const MAX_CONCURRENT_JOBS = 16;

/** CPU ceiling bounds, in percent of total host CPU. */
export const MIN_CPU_PERCENT = 5;
export const MAX_CPU_PERCENT = 100;

/** Memory ceiling bounds, in MB of host memory in use. */
export const MIN_MEMORY_MB = 256;
export const MAX_MEMORY_MB = 1_024 * 1_024;

/**
 * Disk floor: the default is 2 GiB, which is comfortably more than a git
 * fetch plus a `pnpm install` of this monorepo needs to fail gracefully
 * rather than half-way through, and small enough that a laptop lending
 * its spare capacity is not idled by it. Bounded below at 128 MiB (a
 * smaller floor cannot protect anything) and above at 4 TiB.
 */
export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;
export const MIN_MIN_FREE_DISK_BYTES = 128 * 1024 ** 2;
export const MAX_MIN_FREE_DISK_BYTES = 2 ** 42;

/**
 * Conservative default: one job at a time, no CPU/memory admission gate. A
 * fresh node must behave exactly like it did before limits existed.
 */
export const DEFAULT_RESOURCE_LIMITS: NodeResourceLimits = {
	maxConcurrentJobs: 1,
	maxCpuPercent: null,
	maxMemoryMb: null
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(Math.max(Math.round(value), min), max);
}

function clampOptional(value: unknown, min: number, max: number): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}
	return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Coerce operator input (a wizard form, a CLI flag, a stored config written by
 * an older build) into a coherent {@link NodeResourceLimits}. Nonsense never
 * throws — it collapses to the default for that dimension, because a bad limit
 * must not be the thing that stops a node from starting.
 */
export function clampResourceLimits(input: Partial<NodeResourceLimits> | null | undefined): NodeResourceLimits {
	if (!input || typeof input !== 'object') {
		return { ...DEFAULT_RESOURCE_LIMITS };
	}
	const limits: NodeResourceLimits = {
		maxConcurrentJobs: clampInt(
			input.maxConcurrentJobs,
			MIN_CONCURRENT_JOBS,
			MAX_CONCURRENT_JOBS,
			DEFAULT_RESOURCE_LIMITS.maxConcurrentJobs
		),
		maxCpuPercent: clampOptional(input.maxCpuPercent, MIN_CPU_PERCENT, MAX_CPU_PERCENT),
		maxMemoryMb: clampOptional(input.maxMemoryMb, MIN_MEMORY_MB, MAX_MEMORY_MB)
	};
	// The floor is carried through only when the operator actually said
	// something about it. An absent key stays absent (default floor); an
	// explicit null stays null (floor off); a number is clamped. Nonsense
	// (`"2GB"`, NaN) drops the key rather than becoming null — for a floor
	// the safe fallback is the DEFAULT, not "off".
	const floor = clampDiskFloor(input.minFreeDiskBytes);
	if (floor !== undefined) {
		limits.minFreeDiskBytes = floor;
	}
	return limits;
}

function clampDiskFloor(value: unknown): number | null | undefined {
	if (value === null) {
		return null;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.min(Math.max(Math.round(value), MIN_MIN_FREE_DISK_BYTES), MAX_MIN_FREE_DISK_BYTES);
}

/**
 * The disk floor a node actually enforces: the default when the operator
 * never set one, `null` when they switched it off, their number otherwise.
 */
export function effectiveMinFreeDiskBytes(limits: Pick<NodeResourceLimits, 'minFreeDiskBytes'>): number | null {
	if (limits.minFreeDiskBytes === undefined) {
		return DEFAULT_MIN_FREE_DISK_BYTES;
	}
	return limits.minFreeDiskBytes;
}

// ---------------------------------------------------------------------------
// Workspace housekeeping (self-build program note §6 — R8: nothing ever
// reclaimed the per-Task worktrees, so every Task on every repository
// accumulated on every machine forever)
// ---------------------------------------------------------------------------

/**
 * When the node's workspace reaper may remove a Task worktree it has PROVEN
 * safe to remove (see `workspaces/workspace-reaper.ts` for the proof). Age
 * is measured from the workspace's last provision; the count budget, when
 * set, additionally trims the least-recently-used ELIGIBLE workspaces beyond
 * it. Neither ever overrides a safety rule.
 */
export interface NodeWorkspaceGcPolicy {
	/** Workspaces unused for longer than this are candidates. */
	maxAgeDays: number;
	/** Keep at most this many workspaces (LRU among candidates), or null for no count budget. */
	maxCount: number | null;
}

export const DEFAULT_WORKSPACE_MAX_AGE_DAYS = 14;
export const MIN_WORKSPACE_MAX_AGE_DAYS = 1;
export const MAX_WORKSPACE_MAX_AGE_DAYS = 365;
export const MIN_WORKSPACE_COUNT = 1;
export const MAX_WORKSPACE_COUNT = 10_000;

export const DEFAULT_WORKSPACE_GC_POLICY: NodeWorkspaceGcPolicy = {
	maxAgeDays: DEFAULT_WORKSPACE_MAX_AGE_DAYS,
	maxCount: null
};

/** Coerce a stored / flag-supplied policy into a coherent one; nonsense collapses to the default. */
export function clampWorkspaceGcPolicy(
	input: Partial<NodeWorkspaceGcPolicy> | null | undefined
): NodeWorkspaceGcPolicy {
	if (!input || typeof input !== 'object') {
		return { ...DEFAULT_WORKSPACE_GC_POLICY };
	}
	return {
		maxAgeDays: clampInt(
			input.maxAgeDays,
			MIN_WORKSPACE_MAX_AGE_DAYS,
			MAX_WORKSPACE_MAX_AGE_DAYS,
			DEFAULT_WORKSPACE_MAX_AGE_DAYS
		),
		maxCount: clampOptional(input.maxCount, MIN_WORKSPACE_COUNT, MAX_WORKSPACE_COUNT)
	};
}

/**
 * Where the heartbeat secret physically lives.
 *
 * - `keychain` — the OS credential store (Keychain / Credential Manager /
 *   Secret Service) holds it; the config file carries no credential at all.
 * - `file`     — fallback: the secret is inline in the config file, which is
 *   then locked down to the owner (0600 on POSIX, an inheritance-stripped
 *   owner-only ACL on Windows). Always announced with a loud warning.
 */
export type NodeSecretStorage = 'keychain' | 'file';

/** Durable local fail-closed marker for an unverified child process tree. */
export interface NodeUnsafeState {
	since: string;
	reason: string;
}

/**
 * Everything the node needs to resume operating after a restart.
 *
 * `secret` is a credential and must never be logged or sent to a renderer
 * process. It is held in the OS keychain when one is available and only
 * falls back to the config file otherwise — see {@link NodeSecretStorage}.
 */
export interface NodeConfig {
	/** Platform API origin, no trailing slash (e.g. `https://api.ever.works`). */
	apiUrl: string;
	nodeId: string;
	/** Heartbeat credential, minted once at enroll. NEVER log this. */
	secret: string;
	kind: FleetEnrollableNodeKind;
	capabilities: string[];
	/**
	 * Operator's capability opt-in (wizard step 3). When present, only these
	 * tags may be advertised: re-detection on each heartbeat is intersected
	 * with this set, so installing Docker on a node whose owner did not offer
	 * `docker` does NOT silently start attracting Docker work. Absent means
	 * "advertise everything detected" — the pre-selection behaviour.
	 */
	capabilitySelection?: string[];
	/** Ceilings this machine enforces on itself (wizard step 4). */
	limits?: NodeResourceLimits;
	/**
	 * Workspace reaper policy (`start --workspace-max-age` / `enroll
	 * --workspace-max-age`). Absent means the default policy; the key is
	 * only written once an operator sets it, so older configs round-trip
	 * byte-for-byte.
	 */
	workspaceGc?: NodeWorkspaceGcPolicy;
	/**
	 * The workspace root this node actually runs against, recorded by
	 * `start --workspace-root` (node housekeeping, EW-803).
	 *
	 * Stored so that `doctor` and `gc` inspect the SAME tree the service
	 * uses. They resolved it independently before — flag, else
	 * `defaultFleetTaskWorkspaceRoot`, which falls back to `homedir()` —
	 * and the Windows installer's preflight ERRORS unless the operator
	 * passes `-WorkspaceRoot D:\...`, so `doctor` routinely reported
	 * `0 worktree(s), 0 B` about an empty directory in the admin's own
	 * profile while the node was refusing every job for want of space on
	 * D:. Both disk-refusal messages send the operator to exactly those two
	 * commands, so they have to land on the right tree.
	 *
	 * Absent means "never set on this machine" — the default applies, and
	 * a config that never carried the key round-trips without it.
	 */
	workspaceRoot?: string;
	/** Local display label; the authoritative name lives on the platform. */
	name?: string;
	heartbeatIntervalMs: number;
	enrolledAt: string;
	/**
	 * Where {@link NodeConfig.secret} is stored. Absent means `file`, so
	 * configs written before keychain support still load unchanged.
	 */
	secretStorage?: NodeSecretStorage;
	/**
	 * Operator drain flag set by `ever-works-node pause`. A paused node
	 * still heartbeats (so it stays observable) but leases no new work.
	 */
	paused?: boolean;
	/** Survives service restarts until an operator explicitly verifies/clears it. */
	unsafe?: NodeUnsafeState;
}

/** Credential-free projection of {@link NodeConfig}, safe to log or render. */
export interface RedactedNodeConfig {
	apiUrl: string;
	nodeId: string;
	kind: FleetEnrollableNodeKind;
	capabilities: string[];
	capabilitySelection?: string[];
	limits: NodeResourceLimits;
	workspaceGc?: NodeWorkspaceGcPolicy;
	/** Where this node keeps its worktrees; a path, never a credential. */
	workspaceRoot?: string;
	name?: string;
	heartbeatIntervalMs: number;
	enrolledAt: string;
	/** True when a heartbeat secret is stored — the value itself never leaves the config store. */
	hasSecret: boolean;
	/** Where the secret is kept. Safe to show: it names a location, not a value. */
	secretStorage: NodeSecretStorage;
	/** True when the operator has drained this node locally. */
	paused: boolean;
	/** Safe lifecycle diagnostic; contains no credential values. */
	unsafe?: NodeUnsafeState;
}

/** Drop the credential from a config so it can cross a log or IPC boundary. */
export function redactConfig(config: NodeConfig): RedactedNodeConfig {
	const redacted: RedactedNodeConfig = {
		apiUrl: config.apiUrl,
		nodeId: config.nodeId,
		kind: config.kind,
		capabilities: [...config.capabilities],
		limits: clampResourceLimits(config.limits),
		heartbeatIntervalMs: config.heartbeatIntervalMs,
		enrolledAt: config.enrolledAt,
		hasSecret: typeof config.secret === 'string' && config.secret.length > 0,
		secretStorage: config.secretStorage ?? 'file',
		paused: config.paused === true
	};
	if (config.capabilitySelection !== undefined) {
		redacted.capabilitySelection = [...config.capabilitySelection];
	}
	if (config.workspaceGc !== undefined) {
		redacted.workspaceGc = clampWorkspaceGcPolicy(config.workspaceGc);
	}
	if (config.workspaceRoot !== undefined) {
		redacted.workspaceRoot = config.workspaceRoot;
	}
	if (config.name !== undefined) {
		redacted.name = config.name;
	}
	if (config.unsafe !== undefined) {
		redacted.unsafe = { ...config.unsafe };
	}
	return redacted;
}
