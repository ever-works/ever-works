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
 */
export interface NodeResourceLimits {
	maxConcurrentJobs: number;
	/** Refuse to lease while host CPU utilisation exceeds this (1-100), or null. */
	maxCpuPercent: number | null;
	/** Refuse to lease while host memory IN USE exceeds this many MB, or null. */
	maxMemoryMb: number | null;
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
	return {
		maxConcurrentJobs: clampInt(
			input.maxConcurrentJobs,
			MIN_CONCURRENT_JOBS,
			MAX_CONCURRENT_JOBS,
			DEFAULT_RESOURCE_LIMITS.maxConcurrentJobs
		),
		maxCpuPercent: clampOptional(input.maxCpuPercent, MIN_CPU_PERCENT, MAX_CPU_PERCENT),
		maxMemoryMb: clampOptional(input.maxMemoryMb, MIN_MEMORY_MB, MAX_MEMORY_MB)
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
	if (config.name !== undefined) {
		redacted.name = config.name;
	}
	if (config.unsafe !== undefined) {
		redacted.unsafe = { ...config.unsafe };
	}
	return redacted;
}
