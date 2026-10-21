/**
 * Fleet — viewers on a node-link channel (FL-02, CONTRACTS §3, spec FR-32,
 * FR-33).
 *
 * A browser never talks to a machine. It opens
 * `wss://<api-origin>/ws/fleet/<family>/<target>` on the API, presents a
 * 60-second single-use viewer token in its FIRST message, and the API bridges
 * that socket to one channel of the node's link — on whichever API replica
 * holds the link. The token is minted by the epic that owns the family, from
 * its own CONTRACTS §11.2 attach-token route (FL-04 sessions, FL-07 desktop,
 * FL-08 logs …); there is no generic attach-token route.
 *
 * ## Wire (browser ↔ API)
 *
 *  1. Browser → API, text: `{ "type": "auth", "token": "<viewer token>" }`.
 *  2. API → browser, binary control frame on channel `0`:
 *     `viewer.ready { family, target, role, linkGeneration }` once the node
 *     accepted the channel; or a close with one of
 *     {@link FLEET_LINK_VIEWER_CLOSE_CODES} and nothing else.
 *  3. Both ways: binary link frames (`[channel u32][kind u8][len u32][payload]`)
 *     on channel {@link FLEET_LINK_VIEWER_CHANNEL}, the node channel's frames
 *     with its number rewritten. Control from the API stays on channel `0`:
 *     `viewer.refused { error }` (an input the role may not send — answered to
 *     the sender, never forwarded), `viewer.resumed { linkGeneration }` (the
 *     node's link came back and the channel with it), and `channel.close
 *     { channel: 1, reason, hint? }` just before the socket closes.
 *
 * ## Roles
 *
 *  - `driver` — every frame on the channel is forwarded to the node.
 *  - `viewer` — read-only: only `ACK` credit and the JSON types listed for
 *    the family in {@link FLEET_LINK_VIEWER_JSON_TYPES} are forwarded; any
 *    other inbound frame is answered `viewer.refused` and dropped. The node
 *    is told the role as well where the family carries one (`session`'s
 *    `mode`), so the check is made on both sides.
 */

import {
	FLEET_LINK_FRAME_KINDS,
	FLEET_WS_PATH_PREFIX,
	isFleetLinkFamily,
	type FleetLinkExtensionMessage,
	type FleetLinkFamily
} from './fleet-link.types.js';

/** The channel number a bridged channel uses on the browser's socket. */
export const FLEET_LINK_VIEWER_CHANNEL = 1;

/** How long a viewer token lives (CONTRACTS §10, spec FR-32). */
export const FLEET_LINK_VIEWER_TOKEN_TTL_SEC = 60;

/** Viewer tokens one user may be minted per minute (FL-02 plan §5 rate tiers). */
export const FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT = 30;

/** How long an unauthenticated viewer socket may stay open. */
export const FLEET_LINK_VIEWER_AUTH_TIMEOUT_MS = 5_000;

/** Ping interval on a viewer socket; two missed pongs close it. */
export const FLEET_LINK_VIEWER_PING_INTERVAL_MS = 30_000;

/**
 * Bytes waiting to go out to one viewer before it counts as slow. A viewer
 * that stays slow for `FLEET_LINK_SLOW_READER_MS` (5 s) is closed
 * {@link FLEET_LINK_VIEWER_CLOSE_CODES}.slowReader, so one stalled tab never
 * holds back the channel it shares a link with.
 */
export const FLEET_LINK_VIEWER_SLOW_BUFFER_BYTES = 8 * 1024 * 1024;

/** Past this many bytes waiting, a viewer is closed at once. */
export const FLEET_LINK_VIEWER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Largest params object a viewer token may carry, as JSON. */
export const FLEET_LINK_VIEWER_MAX_PARAMS_BYTES = 512;

export const FLEET_LINK_VIEWER_ROLES = ['viewer', 'driver'] as const;

export type FleetLinkViewerRole = (typeof FLEET_LINK_VIEWER_ROLES)[number];

export function isFleetLinkViewerRole(value: unknown): value is FleetLinkViewerRole {
	return value === 'viewer' || value === 'driver';
}

/** Close codes on a VIEWER's socket (the node link's own are `FLEET_LINK_CLOSE_CODES`). */
export const FLEET_LINK_VIEWER_CLOSE_CODES = {
	/** The channel ended normally (the session ended, the viewer closed it). */
	normal: 1000,
	/** The API process is shutting down. */
	shutdown: 1001,
	/** No valid, unused token for this path within 5 s — one code for every reason. */
	auth: 4001,
	/** Two pings unanswered. */
	silence: 4002,
	/** This deployment does not accept node links. */
	disabled: 4003,
	/** The viewer broke the protocol (a frame on another channel, an undecodable frame). */
	protocol: 4009,
	/** The viewer could not keep up (spec: a slow reader is dropped after 5 s). */
	slowReader: 4011,
	/** The channel could not be opened or was closed by the node or the platform; the reason precedes it. */
	channelClosed: 4013
} as const;

export type FleetLinkViewerCloseCode =
	(typeof FLEET_LINK_VIEWER_CLOSE_CODES)[keyof typeof FLEET_LINK_VIEWER_CLOSE_CODES];

/**
 * The JSON message types a read-only `viewer` may send on each family's
 * channel — view controls that change nothing on the machine. Every other
 * inbound frame from a viewer is refused. A family's epic widens its own row
 * in the PR that ships the family, never in code elsewhere.
 */
export const FLEET_LINK_VIEWER_JSON_TYPES: Readonly<Record<FleetLinkFamily, readonly string[]>> = {
	session: [],
	desktop: ['desktop.quality', 'desktop.refresh', 'desktop.displays'],
	logs: ['logs.read', 'logs.follow', 'logs.pause', 'logs.resume', 'logs.earlier'],
	machine: [],
	files: [],
	command: [],
	schedule: [],
	tunnel: [],
	clip: []
};

/** Frame kinds a `viewer` may send whatever the family: flow-control credit only. */
export const FLEET_LINK_VIEWER_FRAME_KINDS: readonly number[] = [FLEET_LINK_FRAME_KINDS.ACK];

/** A viewer path target: an id (session, view, node …), 1–128 of `[A-Za-z0-9._:-]`. */
const TARGET_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isFleetLinkViewerTarget(value: unknown): value is string {
	return typeof value === 'string' && TARGET_PATTERN.test(value);
}

/** `/ws/fleet/<family>/<target>`, or null for a family or target that cannot be one. */
export function fleetLinkViewerPath(family: FleetLinkFamily, target: string): string | null {
	if (!isFleetLinkFamily(family) || !isFleetLinkViewerTarget(target)) return null;
	return `${FLEET_WS_PATH_PREFIX}${family}/${target}`;
}

/** The family and target of a viewer path, or null for anything else (the link's own path included). */
export function parseFleetLinkViewerPath(path: unknown): { family: FleetLinkFamily; target: string } | null {
	if (typeof path !== 'string' || !path.startsWith(FLEET_WS_PATH_PREFIX)) return null;
	const rest = path.slice(FLEET_WS_PATH_PREFIX.length);
	const slash = rest.indexOf('/');
	if (slash <= 0 || slash !== rest.lastIndexOf('/')) return null;
	const family = rest.slice(0, slash);
	const target = rest.slice(slash + 1);
	if (!isFleetLinkFamily(family) || !isFleetLinkViewerTarget(target)) return null;
	return { family, target };
}

/** The key a viewer token is bound to: one family, one target. */
export function fleetLinkViewerKey(family: FleetLinkFamily, target: string): string {
	return `${family}:${target}`;
}

/** May a `viewer` send this JSON message type on this family's channel? */
export function fleetLinkViewerMaySend(family: FleetLinkFamily, type: unknown): boolean {
	return typeof type === 'string' && (FLEET_LINK_VIEWER_JSON_TYPES[family] ?? []).includes(type);
}

/** API → browser, channel 0: the node accepted the channel. */
export interface FleetLinkViewerReady extends FleetLinkExtensionMessage {
	type: 'viewer.ready';
	family: FleetLinkFamily;
	target: string;
	role: FleetLinkViewerRole;
	linkGeneration: number | null;
}

/** API → browser, channel 0: an inbound frame the role may not send; it was not forwarded. */
export interface FleetLinkViewerRefused extends FleetLinkExtensionMessage {
	type: 'viewer.refused';
	error: { code: 'permission_denied' | 'invalid'; hint: string };
}

/** API → browser, channel 0: the node's link came back, and the channel with it. */
export interface FleetLinkViewerResumed extends FleetLinkExtensionMessage {
	type: 'viewer.resumed';
	linkGeneration: number;
}

export const FLEET_LINK_VIEWER_CONTROL_TYPES = ['viewer.ready', 'viewer.refused', 'viewer.resumed'] as const;
