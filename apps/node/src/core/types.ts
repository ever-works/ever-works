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
	kind: FleetEnrollableNodeKind;
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
	kind: FleetEnrollableNodeKind;
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
