/**
 * Wire types and limits shared with the platform Fleet API.
 *
 * These MIRROR the server contract (`apps/api/src/fleet/dto/fleet.dto.ts` +
 * `packages/agent/src/fleet/fleet.service.ts`) — they are a client-side copy so
 * the node apps stay dependency-free, and they must not drift from it. The
 * server re-validates and sanitizes everything anyway; the limits below exist
 * so the node never sends a value the server would silently truncate or drop.
 */

/** App shapes a machine can enroll as (server: `FLEET_ENROLLABLE_KINDS`). */
export type FleetNodeKind = 'desktop-node' | 'node';

/** Node lifecycle as reported by the platform. */
export type FleetNodeStatus = 'enrolling' | 'online' | 'offline' | 'disabled';

/** Wire view of one fleet node — never carries credentials. */
export interface FleetNodeView {
	id: string;
	name: string;
	kind: FleetNodeKind;
	status: FleetNodeStatus;
	platform: string | null;
	version: string | null;
	capabilities: string[];
	lastHeartbeatAt: string | null;
	createdAt: string | null;
	persisted: boolean;
}

/** Self-description sent on enroll and refreshed on every heartbeat. */
export interface NodeSelfDescription {
	platform?: string;
	version?: string;
	capabilities?: string[];
}

/** Server: `FLEET_MAX_CAPABILITY_TAGS`. */
export const MAX_CAPABILITY_TAGS = 16;
/** Server: `FLEET_MAX_CAPABILITY_TAG_LENGTH`. */
export const MAX_CAPABILITY_TAG_LENGTH = 32;
/** Server: `sanitizeText(input.platform, 64)`. */
export const MAX_PLATFORM_LENGTH = 64;
/** Server: `sanitizeText(input.version, 32)`. */
export const MAX_VERSION_LENGTH = 32;
/** Server: `CREDENTIAL_MIN_LENGTH` / `CREDENTIAL_MAX_LENGTH`. */
export const MIN_CREDENTIAL_LENGTH = 16;
export const MAX_CREDENTIAL_LENGTH = 256;

/** Default heartbeat cadence — comfortably inside the server's 5-minute stale window. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Backoff ceiling. Capped at the server's `FLEET_NODE_OFFLINE_AFTER_MS`
 * (5 minutes): once the platform has already flipped us to `offline` there is
 * nothing to gain from backing off further, and a longer ceiling would leave a
 * recovered node dark for many extra minutes.
 */
export const MAX_HEARTBEAT_BACKOFF_MS = 5 * 60_000;

/** Floor/ceiling for the operator-configurable heartbeat interval. */
export const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 15 * 60_000;

/**
 * Everything the node needs to resume operating after a restart. Persisted to
 * the OS config directory with 0600 permissions where the platform supports
 * them — `secret` is a credential and must never be logged or sent to a
 * renderer process.
 */
export interface NodeConfig {
	/** Platform API origin, no trailing slash (e.g. `https://api.ever.works`). */
	apiUrl: string;
	nodeId: string;
	/** Heartbeat credential, minted once at enroll. NEVER log this. */
	secret: string;
	kind: FleetNodeKind;
	capabilities: string[];
	/** Local display label; the authoritative name lives on the platform. */
	name?: string;
	heartbeatIntervalMs: number;
	enrolledAt: string;
}

/** Credential-free projection of {@link NodeConfig}, safe to log or render. */
export interface RedactedNodeConfig {
	apiUrl: string;
	nodeId: string;
	kind: FleetNodeKind;
	capabilities: string[];
	name?: string;
	heartbeatIntervalMs: number;
	enrolledAt: string;
	/** True when a heartbeat secret is stored — the value itself never leaves the config store. */
	hasSecret: boolean;
}

/** Drop the credential from a config so it can cross a log or IPC boundary. */
export function redactConfig(config: NodeConfig): RedactedNodeConfig {
	const redacted: RedactedNodeConfig = {
		apiUrl: config.apiUrl,
		nodeId: config.nodeId,
		kind: config.kind,
		capabilities: [...config.capabilities],
		heartbeatIntervalMs: config.heartbeatIntervalMs,
		enrolledAt: config.enrolledAt,
		hasSecret: typeof config.secret === 'string' && config.secret.length > 0
	};
	if (config.name !== undefined) {
		redacted.name = config.name;
	}
	return redacted;
}
