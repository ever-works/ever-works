/**
 * Fleet — the node link (FL-02, CONTRACTS §1.1, §3, §8, §10).
 *
 * One outbound, multiplexed WebSocket per node. The node opens it to
 * `wss://<api-origin>/ws/fleet/link` after its first accepted heartbeat,
 * and only when its owner switched on at least one of `--work`, `--attend`
 * or `--manage`; a node that is merely enrolled never opens it. Nothing
 * ever connects INTO a node: the link is the generalisation of the
 * computer-session leg, not an inbound port.
 *
 * ## Wire
 *
 * Every WebSocket message is ONE binary frame
 * `[channel u32][kind u8][len u32][payload]`, big-endian, at most
 * {@link FLEET_LINK_MAX_FRAME_BYTES} in total, refused before its payload
 * is parsed when larger. Channel `0` is control: JSON payloads with a
 * `type`. Channels above `0` are opened by the PLATFORM only (never by the
 * node) with `channel.open { channel, family, params }`; the node answers
 * `channel.ready` or `channel.refused { error: { code, hint } }`; either
 * side closes with `channel.close`. A closed channel number is never
 * reused on the same link generation.
 *
 * ## Lifecycle
 *
 * ```
 *  node                                    platform
 *  POST /api/fleet/link-token ───────────► 5 min, single use, bound to the node
 *  wss …/ws/fleet/link
 *  ch0 link.hello { nodeId, linkVersion, capabilities, consents, token, resume? }
 *                               ◄───────── ch0 link.ready { linkGeneration, limits, serverTime, resumed, closed }
 *  ch0 link.ping { t } every 15 s ───────►
 *                               ◄───────── ch0 link.pong { t }
 *  45 s without a frame: both ends close; the node reconnects 1 s → 30 s with jitter
 * ```
 *
 * Heartbeat and job leasing stay on HTTPS; the 60-second heartbeat remains
 * the source of a node's online/offline status.
 */

import { FLEET_ACTION_FAMILIES, isFleetActionFamily, type FleetActionFamily } from './fleet-access.types.js';

// ─── Limits (CONTRACTS §10) ─────────────────────────────────────────────────

/** Protocol version a node presents in `link.hello`. */
export const FLEET_LINK_VERSION = 1;

/** The node's upgrade path on the API origin. */
export const FLEET_LINK_WS_PATH = '/ws/fleet/link';

/** Every fleet socket path (the link and the viewer bridge) lives under this prefix. */
export const FLEET_WS_PATH_PREFIX = '/ws/fleet/';

/** Largest frame (header + payload), in bytes. */
export const FLEET_LINK_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** `[channel u32][kind u8][len u32]`. */
export const FLEET_LINK_FRAME_HEADER_BYTES = 9;

/** Largest payload a frame may carry. */
export const FLEET_LINK_MAX_PAYLOAD_BYTES = FLEET_LINK_MAX_FRAME_BYTES - FLEET_LINK_FRAME_HEADER_BYTES;

/**
 * Largest JSON control message, in bytes. Control messages are small by
 * design (ids, codes, hints); a megabyte of JSON on channel 0 is an
 * attack or a bug, never a legitimate message.
 */
export const FLEET_LINK_MAX_JSON_BYTES = 1024 * 1024;

/** Highest channel number (`u32`). Channel numbers are allocated by the platform from 1 upward. */
export const FLEET_LINK_MAX_CHANNEL_NUMBER = 0xffff_ffff;

/** Open channels one link may carry at once; the 65th open is refused with `limit_exceeded`. */
export const FLEET_LINK_MAX_CHANNELS = 64;

/** How often the node sends `link.ping`. */
export const FLEET_LINK_PING_INTERVAL_MS = 15_000;

/** A link with no frame for this long is closed by both ends. */
export const FLEET_LINK_SILENCE_MS = 45_000;

/** Reconnect backoff: first wait. */
export const FLEET_LINK_BACKOFF_BASE_MS = 1_000;

/** Reconnect backoff: ceiling. */
export const FLEET_LINK_BACKOFF_MAX_MS = 30_000;

/**
 * How long a node waits before trying again when the platform does not
 * accept links (`FLEET_NODE_LINK_ENABLED` off, or an older platform without
 * the route). One log line per refusal, then this.
 */
export const FLEET_LINK_REFUSED_RETRY_MS = 5 * 60_000;

/** Lifetime of a link token, seconds. */
export const FLEET_LINK_TOKEN_TTL_SEC = 300;

/** Hellos one node may present per minute before it is refused for {@link FLEET_LINK_HELLO_BLOCK_MS}. */
export const FLEET_LINK_HELLO_RATE_LIMIT = 10;

/** Window of {@link FLEET_LINK_HELLO_RATE_LIMIT}. */
export const FLEET_LINK_HELLO_RATE_WINDOW_MS = 60_000;

/** How long a node presenting too many hellos is refused. */
export const FLEET_LINK_HELLO_BLOCK_MS = 60_000;

/** An unauthenticated link socket is closed after this. */
export const FLEET_LINK_AUTH_TIMEOUT_MS = 5_000;

/**
 * A request the node cannot answer within this long replies at once with
 * an `operationId` and reports progress and completion on channel 0.
 */
export const FLEET_LINK_INLINE_REPLY_MS = 2_000;

/** How long the platform waits for a request's first reply before answering `unreachable`. */
export const FLEET_LINK_REQUEST_TIMEOUT_MS = 30_000;

/** How long the platform waits for `channel.ready` / `channel.refused`. */
export const FLEET_LINK_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

/**
 * How long the platform keeps the channels of a dropped link for a
 * reconnect to resume. Covers the backoff ceiling twice over.
 */
export const FLEET_LINK_RESUME_WINDOW_MS = 120_000;

/** An operation stays readable this long after it completes. */
export const FLEET_OPERATION_RETENTION_MS = 60 * 60_000;

/** A viewer socket that cannot keep up for this long is dropped (one slow tab never stalls a channel). */
export const FLEET_LINK_SLOW_READER_MS = 5_000;

/** Kill-switch pause / resume reaches every open link within this long. */
export const FLEET_LINK_KILL_SWITCH_POLL_MS = 2_500;

/** Drain-all gives owner sessions this long before ending them (CONTRACTS R-24). */
export const FLEET_LINK_DRAIN_GRACE_SEC = 60;

/** The limits a platform announces in `link.ready`. */
export interface FleetLinkLimits {
	maxFrameBytes: number;
	maxChannels: number;
	pingIntervalMs: number;
	silenceMs: number;
	inlineReplyMs: number;
}

export const FLEET_LINK_DEFAULT_LIMITS: FleetLinkLimits = {
	maxFrameBytes: FLEET_LINK_MAX_FRAME_BYTES,
	maxChannels: FLEET_LINK_MAX_CHANNELS,
	pingIntervalMs: FLEET_LINK_PING_INTERVAL_MS,
	silenceMs: FLEET_LINK_SILENCE_MS,
	inlineReplyMs: FLEET_LINK_INLINE_REPLY_MS
};

/**
 * WebSocket close codes on the link. Every credential refusal — a used,
 * expired, foreign or malformed token, an unknown or disabled node, an
 * auth timeout — shares {@link FLEET_LINK_CLOSE_CODES.auth}, so a socket
 * can never learn which of those it was.
 */
export const FLEET_LINK_CLOSE_CODES = {
	/** Normal close (a node shutting down, a channel-less link released). */
	normal: 1000,
	/** The API process is shutting down. */
	shutdown: 1001,
	/** Undifferentiated credential refusal. */
	auth: 4001,
	/** 45 s without a frame. */
	silence: 4002,
	/** This deployment does not accept node links (`FLEET_NODE_LINK_ENABLED` off). */
	disabled: 4003,
	/** Too many hellos (CONTRACTS U9). */
	rateLimited: 4008,
	/** The other side broke the protocol (bad first frame, a node-opened channel, …). */
	protocol: 4009,
	/** A newer link from the same node replaced this one. */
	replaced: 4010,
	/** The node presented no consent that allows a link (work, attend, manage all off). */
	noConsent: 4012
} as const;

export type FleetLinkCloseCode = (typeof FLEET_LINK_CLOSE_CODES)[keyof typeof FLEET_LINK_CLOSE_CODES];

// ─── Frame kinds (CONTRACTS §3.2) ───────────────────────────────────────────

export const FLEET_LINK_FRAME_KINDS = {
	/** Raw bytes: terminal output/input, log lines, file chunks. */
	DATA: 1,
	/** `[cols u16][rows u16]`. */
	RESIZE: 2,
	/** `[code i32]`. */
	EXIT: 3,
	/** UTF-8 JSON control message. */
	JSON: 10,
	/** UTF-8 reason code. */
	CLOSE: 11,
	/** A full picture (the existing computer-frame encoding). */
	FRAME: 20,
	/** A pointer / key / text event (the existing computer input encoding). */
	INPUT: 21,
	/** Changed tiles `[w][h][count]{x,y,w,h,len,jpeg}`. */
	TILES: 23,
	/** `[bytes u32]` credit. */
	ACK: 30,
	/** End of a stream. */
	END: 31,
	/** UTF-8 text ≤ 256 KiB, pasted into a desktop. */
	CLIP: 40
} as const;

export type FleetLinkFrameKindName = keyof typeof FLEET_LINK_FRAME_KINDS;
export type FleetLinkFrameKind = (typeof FLEET_LINK_FRAME_KINDS)[FleetLinkFrameKindName];

const FRAME_KIND_VALUES: ReadonlySet<number> = new Set(Object.values(FLEET_LINK_FRAME_KINDS));

export function isFleetLinkFrameKind(value: unknown): value is FleetLinkFrameKind {
	return typeof value === 'number' && FRAME_KIND_VALUES.has(value);
}

/** Largest clipboard text a `CLIP` frame may carry (CONTRACTS §10). */
export const FLEET_LINK_MAX_CLIP_BYTES = 256 * 1024;

/**
 * Flow control for bulk channels (CONTRACTS §3.2 `ACK`, §10 file transfer):
 * a sender on a credit family starts with this many bytes of `DATA` credit
 * and may send more only as the receiver returns `ACK [bytes u32]`. One
 * bulk transfer therefore never fills the link a terminal shares.
 */
export const FLEET_LINK_CREDIT_WINDOW_BYTES = 8 * 1024 * 1024;

/** Families whose `DATA` is credit-controlled. */
export const FLEET_LINK_CREDIT_FAMILIES: readonly FleetLinkFamily[] = ['files', 'logs'];

// ─── Consents (CONTRACTS §1.1) ──────────────────────────────────────────────

/**
 * What the machine's owner switched on when starting the node. Reported in
 * every heartbeat and in `link.hello`; stored on the node row. Enrolment
 * itself (heartbeat, inventory, health) needs no consent and has no key.
 */
export interface FleetConsents {
	/** `--work`: lease jobs; Agent sessions; checkouts for Tasks; Actions runner jobs. */
	work: boolean;
	/** `--attend`: live viewing — screen, desktop, take-over, recording, open-on-desktop. */
	attend: boolean;
	/** `--manage`: owner sessions, logs, services, Docker, processes, ports, files, commands, schedules, checkout discovery, wake, VM creation. */
	manage: boolean;
	/** `--usage-scan`: the periodic transcript scan for usage and cost — counts only, never content. */
	usageScan: boolean;
}

export type FleetConsentKey = keyof FleetConsents;

export const FLEET_CONSENT_KEYS: readonly FleetConsentKey[] = ['work', 'attend', 'manage', 'usageScan'];

/** The `ever-works-node start` flag behind each consent. */
export const FLEET_CONSENT_FLAGS: Readonly<Record<FleetConsentKey, string>> = {
	work: '--work',
	attend: '--attend',
	manage: '--manage',
	usageScan: '--usage-scan'
};

/** No consent at all — what an enrolled-only node reports. */
export const FLEET_NO_CONSENTS: Readonly<FleetConsents> = Object.freeze({
	work: false,
	attend: false,
	manage: false,
	usageScan: false
});

/**
 * Read a consents object off the wire or a stored column. `null` when the
 * value is not an object at all (an older daemon that never reported one);
 * otherwise every key is `true` only when it is literally `true` — a
 * missing or malformed key is a consent NOT given, never one assumed.
 */
export function normalizeFleetConsents(value: unknown): FleetConsents | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return {
		work: record.work === true,
		attend: record.attend === true,
		manage: record.manage === true,
		usageScan: record.usageScan === true
	};
}

/** The subset of a node the consent inference reads. */
export interface FleetConsentSubject {
	consents?: unknown;
	capabilities?: readonly string[] | null;
	workerState?: string | null;
}

/**
 * The consents a node is treated as holding.
 *
 * A node that reported `consents` is taken at its word. One that never did
 * — a daemon older than FL-02 — gets the best-effort inference CONTRACTS
 * U12 fixes: `manage` and `usageScan` false (they did not exist), `attend`
 * from the `attended` tag the node already advertised under `--attend`,
 * and `work` true when the node has ever reported a worker state (only a
 * node started with `--work` runs a worker). The inference never grants
 * `manage`: a node that cannot say it was started with `--manage` was not.
 */
export function effectiveConsents(node: FleetConsentSubject | null | undefined): FleetConsents {
	if (!node) return { ...FLEET_NO_CONSENTS };
	const reported = normalizeFleetConsents(node.consents);
	if (reported) return reported;
	const tags = Array.isArray(node.capabilities) ? node.capabilities : [];
	return {
		work: typeof node.workerState === 'string' && node.workerState.length > 0,
		attend: tags.includes('attended'),
		manage: false,
		usageScan: false
	};
}

/** A node opens the link when any of `work`, `attend`, `manage` is on (README D2). */
export function isFleetLinkEligible(consents: FleetConsents | null | undefined): boolean {
	return Boolean(consents && (consents.work || consents.attend || consents.manage));
}

/** True when two consent sets differ in any key. */
export function fleetConsentsDiffer(a: FleetConsents | null, b: FleetConsents | null): boolean {
	if (a === null || b === null) return a !== b;
	return FLEET_CONSENT_KEYS.some((key) => a[key] !== b[key]);
}

// ─── Channel families (CONTRACTS §3.3) ──────────────────────────────────────

export const FLEET_LINK_FAMILIES = [
	'session',
	'desktop',
	'logs',
	'machine',
	'files',
	'command',
	'schedule',
	'tunnel',
	'clip'
] as const;

export type FleetLinkFamily = (typeof FLEET_LINK_FAMILIES)[number];

export function isFleetLinkFamily(value: unknown): value is FleetLinkFamily {
	return typeof value === 'string' && (FLEET_LINK_FAMILIES as readonly string[]).includes(value);
}

/**
 * The consent a family (or one verb on the `machine` family) needs.
 *
 *  - `link` — nothing beyond the link itself being open (CONTRACTS R-31:
 *    `health.now`);
 *  - `work-or-manage` — either consent (a session channel: Agent sessions
 *    need `work`, owner sessions `manage`; the opener names which when it
 *    knows, CONTRACTS R-5).
 */
export type FleetLinkConsentRequirement = 'link' | 'work' | 'attend' | 'manage' | 'work-or-manage';

export const FLEET_LINK_CONSENT_REQUIREMENTS: readonly FleetLinkConsentRequirement[] = [
	'link',
	'work',
	'attend',
	'manage',
	'work-or-manage'
];

export function isFleetLinkConsentRequirement(value: unknown): value is FleetLinkConsentRequirement {
	return typeof value === 'string' && (FLEET_LINK_CONSENT_REQUIREMENTS as readonly string[]).includes(value);
}

/** The consent each family needs (CONTRACTS §3.3). */
export const FLEET_LINK_FAMILY_CONSENT: Readonly<Record<FleetLinkFamily, FleetLinkConsentRequirement>> = {
	session: 'work-or-manage',
	desktop: 'attend',
	logs: 'manage',
	machine: 'manage',
	files: 'manage',
	command: 'manage',
	schedule: 'manage',
	tunnel: 'manage',
	clip: 'attend'
};

/**
 * Per-verb consent exceptions on the `machine` family (CONTRACTS §3.3, R-31):
 * the family needs `manage`, except the verbs listed here. The ONE place a
 * later epic adds an exception — never a branch in code, on the platform or
 * on the node.
 */
export const FLEET_LINK_VERB_CONSENT_OVERRIDES: Readonly<Record<string, FleetLinkConsentRequirement>> = {
	/** A read allowed on any open link. */
	'health.now': 'link'
};

/** The consent one `machine` verb needs: its exception, else the family's. */
export function fleetLinkVerbConsent(verb: string): FleetLinkConsentRequirement {
	return Object.prototype.hasOwnProperty.call(FLEET_LINK_VERB_CONSENT_OVERRIDES, verb)
		? FLEET_LINK_VERB_CONSENT_OVERRIDES[verb]
		: FLEET_LINK_FAMILY_CONSENT.machine;
}

/**
 * The consent needed to OPEN a channel of `family`. The family's own
 * requirement — except `machine`, which opens on any link whenever a verb
 * exception exists, because each of its requests is checked against its
 * verb's consent instead (a `--work`-only node still answers `health.now`).
 */
export function fleetLinkChannelOpenConsent(family: FleetLinkFamily): FleetLinkConsentRequirement {
	if (family === 'machine' && Object.keys(FLEET_LINK_VERB_CONSENT_OVERRIDES).length > 0) return 'link';
	return FLEET_LINK_FAMILY_CONSENT[family];
}

/** True when `consents` satisfy `requirement`. */
export function fleetConsentSatisfies(
	consents: FleetConsents | null | undefined,
	requirement: FleetLinkConsentRequirement
): boolean {
	if (!consents) return false;
	switch (requirement) {
		case 'link':
			return isFleetLinkEligible(consents);
		case 'work':
			return consents.work;
		case 'attend':
			return consents.attend;
		case 'manage':
			return consents.manage;
		case 'work-or-manage':
			return consents.work || consents.manage;
		default:
			return false;
	}
}

/** The flag(s) that would satisfy a requirement, as the node's owner types them. */
export function fleetConsentFlagsFor(requirement: FleetLinkConsentRequirement): string[] {
	switch (requirement) {
		case 'work':
			return [FLEET_CONSENT_FLAGS.work];
		case 'attend':
			return [FLEET_CONSENT_FLAGS.attend];
		case 'manage':
			return [FLEET_CONSENT_FLAGS.manage];
		case 'work-or-manage':
			return [FLEET_CONSENT_FLAGS.work, FLEET_CONSENT_FLAGS.manage];
		case 'link':
		default:
			return [FLEET_CONSENT_FLAGS.work, FLEET_CONSENT_FLAGS.attend, FLEET_CONSENT_FLAGS.manage];
	}
}

/** `start the node with --manage on build-01` — the CONTRACTS §8 hint for `consent_missing`. */
export function fleetConsentMissingHint(requirement: FleetLinkConsentRequirement, nodeName: string): string {
	const flags = fleetConsentFlagsFor(requirement);
	const joined = flags.length === 1 ? flags[0] : `${flags.slice(0, -1).join(', ')} or ${flags[flags.length - 1]}`;
	return `start the node with ${joined} on ${nodeName}`;
}

/**
 * The action families of a node's control policy (CONTRACTS §2.1), as the
 * link's authorisation step names them. They ARE the Fleet hub's families
 * (`fleet-access.types.ts`, FL-01) — the same list object, the same type —
 * so a family added there is a family the link knows; these names only say
 * which side of the program is asking.
 */
export const FLEET_LINK_ACTION_FAMILIES: typeof FLEET_ACTION_FAMILIES = FLEET_ACTION_FAMILIES;

export type FleetLinkActionFamily = FleetActionFamily;

export function isFleetLinkActionFamily(value: unknown): value is FleetLinkActionFamily {
	return isFleetActionFamily(value);
}

/** The action family a channel family answers to by default. */
export const FLEET_LINK_FAMILY_ACTION_FAMILY: Readonly<Record<FleetLinkFamily, FleetLinkActionFamily>> = {
	session: 'sessions',
	desktop: 'desktop',
	logs: 'logs',
	machine: 'view',
	files: 'files',
	command: 'commands',
	schedule: 'schedules',
	tunnel: 'ports',
	clip: 'desktop'
};

/**
 * Families whose channels CHANGE the machine when opened: opening one writes
 * a `node.link.channel-open` audit row (CONTRACTS §7, spec FR-25). Read-only
 * families (`logs`, `desktop` watching, `machine`) are not audited on open;
 * the `machine` family's state-changing verbs are audited per verb by the
 * epic that owns them.
 */
export const FLEET_LINK_STATE_CHANGING_FAMILIES: readonly FleetLinkFamily[] = [
	'session',
	'files',
	'command',
	'schedule',
	'tunnel',
	'clip'
];

export function isFleetLinkStateChangingFamily(family: FleetLinkFamily): boolean {
	return (FLEET_LINK_STATE_CHANGING_FAMILIES as readonly string[]).includes(family);
}

/**
 * The default action family of a `machine` verb, by its prefix (CONTRACTS
 * §2.1 mapping). A verb with no entry answers to `machines`, the strictest
 * family; the caller may always name a narrower one for its own verb.
 */
export const FLEET_LINK_MACHINE_VERB_ACTION_FAMILY: Readonly<Record<string, FleetLinkActionFamily>> = {
	'health.now': 'view',
	'ports.list': 'view',
	'ports.open': 'ports',
	'ports.preview': 'ports',
	'git.identity': 'checkouts',
	'git.setIdentity': 'commands',
	'wake.send': 'machines',
	// CONTRACTS §3.3 (rev 4): `logs.sources` is a machine verb (a list needs no open channel).
	logs: 'logs',
	services: 'services',
	docker: 'docker',
	compose: 'docker',
	processes: 'processes',
	checkouts: 'checkouts',
	vm: 'machines',
	runner: 'machines'
};

/** The action family a `machine` verb answers to (exact entry first, then its prefix, then `machines`). */
export function fleetLinkMachineVerbActionFamily(verb: string): FleetLinkActionFamily {
	// Own keys only: `constructor` or `toString` must never read off the prototype.
	const own = (key: string): FleetLinkActionFamily | undefined =>
		Object.prototype.hasOwnProperty.call(FLEET_LINK_MACHINE_VERB_ACTION_FAMILY, key)
			? FLEET_LINK_MACHINE_VERB_ACTION_FAMILY[key]
			: undefined;
	const exact = own(verb);
	if (exact) return exact;
	const dot = verb.indexOf('.');
	return own(dot > 0 ? verb.slice(0, dot) : verb) ?? 'machines';
}

/** `health.now`, `services.list`, `docker.container.start` — dotted, lower camel segments, bounded. */
const VERB_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}(?:\.[a-z][a-zA-Z0-9]{0,31}){0,3}$/;

export function isFleetLinkVerb(value: unknown): value is string {
	return typeof value === 'string' && VERB_PATTERN.test(value);
}

// ─── Errors (CONTRACTS §8) ──────────────────────────────────────────────────

export const FLEET_LINK_ERROR_CODES = [
	'not_found',
	'invalid',
	'unreachable',
	'consent_missing',
	'permission_denied',
	'confirmation_required',
	'root_required',
	'kill_switch',
	'limit_exceeded',
	'unsupported_on_node',
	'busy',
	'operation_failed',
	'internal',
	/** A channel the reconnect could not resume (CONTRACTS §3.1). */
	'resume_failed'
] as const;

export type FleetLinkErrorCode = (typeof FLEET_LINK_ERROR_CODES)[number];

export function isFleetLinkErrorCode(value: unknown): value is FleetLinkErrorCode {
	return typeof value === 'string' && (FLEET_LINK_ERROR_CODES as readonly string[]).includes(value);
}

/** The HTTP status each code answers with on a REST surface. */
export const FLEET_LINK_ERROR_HTTP_STATUS: Readonly<Record<FleetLinkErrorCode, number>> = {
	not_found: 404,
	invalid: 400,
	unreachable: 503,
	consent_missing: 409,
	permission_denied: 403,
	confirmation_required: 409,
	root_required: 409,
	kill_switch: 423,
	limit_exceeded: 429,
	unsupported_on_node: 422,
	busy: 409,
	operation_failed: 500,
	internal: 500,
	resume_failed: 503
};

/** Bound on an error's `hint`: one sentence a person reads. */
export const FLEET_LINK_MAX_HINT_LENGTH = 500;

/**
 * The one error envelope every link reply, REST refusal and tool error
 * carries (CONTRACTS §8): `{ error: { code, hint, details } }`.
 */
export interface FleetLinkError {
	code: FleetLinkErrorCode;
	/** What to do about it — the command to run on the machine, or who to ask. Never a secret. */
	hint: string;
	details?: Record<string, unknown>;
}

export interface FleetLinkErrorEnvelope {
	error: FleetLinkError;
}

// ─── Control messages (channel 0) ───────────────────────────────────────────

/** One channel a reconnecting node still holds and asks to keep. */
export interface FleetLinkResumeChannel {
	channel: number;
	family: FleetLinkFamily;
	/** Opaque per-channel key the node chose when it accepted the channel. */
	resumeKey?: string;
}

export interface FleetLinkHello {
	type: 'link.hello';
	nodeId: string;
	linkVersion: number;
	capabilities: string[];
	consents: FleetConsents;
	/** The short-lived link token (`POST /api/fleet/link-token`). Never logged. */
	token: string;
	/** The node's daemon version, for `unsupported_on_node` hints. */
	nodeVersion?: string;
	/** Present on a reconnect: the generation the node lost and the channels it still holds. */
	resume?: { linkGeneration: number; channels: FleetLinkResumeChannel[] };
}

export interface FleetLinkReady {
	type: 'link.ready';
	linkGeneration: number;
	limits: FleetLinkLimits;
	/** ISO-8601 instant on the platform's clock. */
	serverTime: string;
	/** Channels of the previous generation carried over to this one. */
	resumed: number[];
	/** Channels of the previous generation the platform closed (`resume_failed` / `consent_missing`). */
	closed: number[];
}

export interface FleetLinkPing {
	type: 'link.ping';
	/** Sender's clock, echoed in the pong. */
	t: number;
}

export interface FleetLinkPong {
	type: 'link.pong';
	t: number;
}

/** The kill switch is on: block input and state-changing requests; replies in flight continue. */
export interface FleetLinkPause {
	type: 'link.pause';
	reason: 'kill_switch';
}

/** The kill switch was cleared: lift the pause, no reconnect needed. */
export interface FleetLinkResume {
	type: 'link.resume';
}

/** Drain-all: owner sessions get this many seconds' warning before they are ended. */
export interface FleetLinkDrain {
	type: 'link.drain';
	graceSec: number;
}

export interface FleetLinkChannelOpen {
	type: 'channel.open';
	channel: number;
	family: FleetLinkFamily;
	params: Record<string, unknown>;
	requestId: string;
}

export interface FleetLinkChannelReady {
	type: 'channel.ready';
	channel: number;
	requestId: string;
	/** Opaque key the node presents in `link.hello.resume` to keep this channel across a reconnect. */
	resumeKey?: string;
}

export interface FleetLinkChannelRefused {
	type: 'channel.refused';
	channel: number;
	requestId: string;
	error: FleetLinkError;
}

/** Why a channel closed. A {@link FleetLinkErrorCode}, or `normal` for an orderly close. */
export type FleetLinkCloseReason = FleetLinkErrorCode | 'normal';

export interface FleetLinkChannelClose {
	type: 'channel.close';
	channel: number;
	reason: FleetLinkCloseReason;
	hint?: string;
}

export interface FleetLinkOperationProgressValue {
	/** 0–100 when the node can tell. */
	percent?: number;
	/** One line a person reads. */
	message?: string;
}

export interface FleetLinkOperationProgress {
	type: 'operation.progress';
	operationId: string;
	progress: FleetLinkOperationProgressValue;
}

export interface FleetLinkOperationDone {
	type: 'operation.done';
	operationId: string;
	result?: unknown;
	error?: FleetLinkError;
}

export interface FleetLinkOperationCancel {
	type: 'operation.cancel';
	operationId: string;
}

/** Every channel-0 message the link itself defines. Families add their own `type`s (CONTRACTS §3.3). */
export type FleetLinkControlMessage =
	| FleetLinkHello
	| FleetLinkReady
	| FleetLinkPing
	| FleetLinkPong
	| FleetLinkPause
	| FleetLinkResume
	| FleetLinkDrain
	| FleetLinkChannelOpen
	| FleetLinkChannelReady
	| FleetLinkChannelRefused
	| FleetLinkChannelClose
	| FleetLinkOperationProgress
	| FleetLinkOperationDone
	| FleetLinkOperationCancel;

export type FleetLinkControlType = FleetLinkControlMessage['type'];

export const FLEET_LINK_CONTROL_TYPES: readonly FleetLinkControlType[] = [
	'link.hello',
	'link.ready',
	'link.ping',
	'link.pong',
	'link.pause',
	'link.resume',
	'link.drain',
	'channel.open',
	'channel.ready',
	'channel.refused',
	'channel.close',
	'operation.progress',
	'operation.done',
	'operation.cancel'
];

/**
 * A family's own channel-0 message (`session.event`, `session.status`, …):
 * a `type` the link does not define, carried through untouched for the
 * module that registered it.
 */
export interface FleetLinkExtensionMessage {
	type: string;
	[key: string]: unknown;
}

// ─── Requests and replies on a channel (> 0) ────────────────────────────────

/** A request on a channel: `{ requestId, type: '<verb>', params? }`. */
export interface FleetLinkRequest {
	requestId: string;
	type: string;
	params?: Record<string, unknown>;
}

/** A reply: exactly one of `result`, `error`, or `operationId` (a long request). */
export type FleetLinkReply =
	| { requestId: string; result: unknown }
	| { requestId: string; error: FleetLinkError }
	| { requestId: string; operationId: string };

/** `requestId` / `operationId`: 1–64 of `[A-Za-z0-9_-]`. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isFleetLinkId(value: unknown): value is string {
	return typeof value === 'string' && ID_PATTERN.test(value);
}

// ─── What the platform shows about a link ───────────────────────────────────

/**
 * The link as the platform's own socket sees it — never inferred from a
 * heartbeat (spec FR-42).
 *
 *  - `connected` — the platform holds the node's link right now;
 *  - `reconnecting` — it held one recently and the node is expected back;
 *  - `not-open` — the node has no consent that opens a link, or never opened one;
 *  - `refused` — this deployment does not accept links (`FLEET_NODE_LINK_ENABLED` off);
 *  - `unsupported-kind` — this kind of node cannot report consents yet (CONTRACTS R-10).
 */
export const FLEET_NODE_LINK_STATES = ['connected', 'reconnecting', 'not-open', 'refused', 'unsupported-kind'] as const;

export type FleetNodeLinkState = (typeof FLEET_NODE_LINK_STATES)[number];

export interface FleetNodeLinkView {
	state: FleetNodeLinkState;
	/** ISO instant the current state began (connected since, or last seen connected). */
	since?: string | null;
	/** The current link generation while connected. */
	linkGeneration?: number | null;
	/** Bytes received from / sent to the node over this link since it connected. */
	bytesIn: number;
	bytesOut: number;
	openChannels: number;
}
