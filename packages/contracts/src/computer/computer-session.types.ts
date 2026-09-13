/**
 * Agent computers — the session view types.
 *
 * A computer session is one episode of an owner watching (and, later,
 * controlling) the machine an Agent works on. It is NOT a Run: a Run is the
 * Agent's execution, a session is a person's observation of a Node, and it
 * can exist with no Run in flight. "Computer" is UI copy for a Fleet Node;
 * the entity behind every id here stays `FleetNode`.
 */

import type { FleetNodeKind, FleetNodeStatus } from '../fleet/fleet-node.types.js';
import {
	COMPUTER_CLOSE_REASONS,
	COMPUTER_CONTROL_RELEASE_REASONS,
	COMPUTER_QUALITIES,
	type ComputerCloseReason,
	type ComputerControlReleaseReason,
	type ComputerQuality
} from './computer-frame.types.js';

export function isComputerCloseReason(value: unknown): value is ComputerCloseReason {
	return typeof value === 'string' && (COMPUTER_CLOSE_REASONS as readonly string[]).includes(value);
}

export function isComputerControlReleaseReason(value: unknown): value is ComputerControlReleaseReason {
	return typeof value === 'string' && (COMPUTER_CONTROL_RELEASE_REASONS as readonly string[]).includes(value);
}

/**
 * Session lifecycle: `requested` (no node has claimed it yet) → `live`
 * (pictures are arriving) ⇄ `stalled` (they stopped) → `ended`.
 */
export const COMPUTER_SESSION_STATUSES = ['requested', 'live', 'stalled', 'ended'] as const;
export type ComputerSessionStatus = (typeof COMPUTER_SESSION_STATUSES)[number];

/** Statuses that still count against the session caps. */
export const COMPUTER_SESSION_OPEN_STATUSES: readonly ComputerSessionStatus[] = ['requested', 'live', 'stalled'];

export function isComputerSessionStatus(value: unknown): value is ComputerSessionStatus {
	return typeof value === 'string' && (COMPUTER_SESSION_STATUSES as readonly string[]).includes(value);
}

/** The two things a session can show: the Agent's browser, or its shell. */
export const COMPUTER_CHANNELS = ['screen', 'terminal'] as const;
export type ComputerChannel = (typeof COMPUTER_CHANNELS)[number];

export function isComputerChannel(value: unknown): value is ComputerChannel {
	return typeof value === 'string' && (COMPUTER_CHANNELS as readonly string[]).includes(value);
}

export function isComputerQuality(value: unknown): value is ComputerQuality {
	return typeof value === 'string' && (COMPUTER_QUALITIES as readonly string[]).includes(value);
}

/**
 * Why a Node cannot be watched — a closed set, in the precedence order the
 * policy checks them, so a Node that is BOTH offline and missing a browser
 * says the thing the owner must fix first.
 *
 * The first six refuse the whole machine. The last three are PER CHANNEL:
 * `no-browser` and `no-display` take away only the screen channel and
 * `no-terminal` only the terminal channel, so a machine with no display can
 * still be watchable on its terminal.
 */
export const COMPUTER_UNWATCHABLE_REASONS = [
	'cluster',
	'disabled',
	'paused',
	'draining',
	'offline',
	'not-attended',
	'no-browser',
	'no-display',
	'no-terminal'
] as const;
export type ComputerUnwatchableReason = (typeof COMPUTER_UNWATCHABLE_REASONS)[number];

export function isComputerUnwatchableReason(value: unknown): value is ComputerUnwatchableReason {
	return typeof value === 'string' && (COMPUTER_UNWATCHABLE_REASONS as readonly string[]).includes(value);
}

/** Who may take control of a Node. Owner-only unless the owner widens it. */
export const COMPUTER_CONTROL_POLICIES = ['owner', 'org-admins', 'org-members'] as const;
export type ComputerControlPolicy = (typeof COMPUTER_CONTROL_POLICIES)[number];

export function isComputerControlPolicy(value: unknown): value is ComputerControlPolicy {
	return typeof value === 'string' && (COMPUTER_CONTROL_POLICIES as readonly string[]).includes(value);
}

/** One stretch of one person holding control. */
export interface ComputerControlSpan {
	userId: string;
	startedAt: string;
	endedAt: string | null;
	reason: ComputerControlReleaseReason | null;
}

/** Most control spans a session keeps. */
export const COMPUTER_MAX_CONTROL_SPANS = 50;

/** A session on the wire. Never carries picture bytes or a profile path. */
export interface ComputerSessionView {
	id: string;
	agentId: string;
	nodeId: string;
	openedByUserId: string;
	/** The Run the node was executing for this Agent when the first picture arrived. */
	runId: string | null;
	channels: ComputerChannel[];
	activeChannel: ComputerChannel;
	quality: ComputerQuality;
	status: ComputerSessionStatus;
	closeReason: ComputerCloseReason | null;
	controlSpans: ComputerControlSpan[];
	recorded: boolean;
	recordingSkippedReason: string | null;
	frameCount: number;
	/** Bytes published since the session opened — the bandwidth readout. */
	bytesOut: number;
	lastFrameAt: string | null;
	startedAt: string | null;
	endedAt: string | null;
	createdAt: string | null;
}

/** A live session as the over-limit message lists it: who holds it, since when. */
export interface ComputerSessionHolderView {
	sessionId: string;
	nodeId: string;
	openedByUserId: string;
	status: ComputerSessionStatus;
	since: string | null;
}

/** One row of the Node picker. */
export interface ComputerNodeOption {
	id: string;
	name: string;
	kind: FleetNodeKind;
	status: FleetNodeStatus;
	platform: string | null;
	lastHeartbeatAt: string | null;
	/** The channels this Node can serve today. Empty exactly when it is not watchable. */
	servableChannels: ComputerChannel[];
	/**
	 * Why each channel the Node cannot serve is unavailable, so the picker can
	 * show "Terminal" as watchable with the screen's "No display session"
	 * beside it. A channel absent from this map is servable, or is refused by
	 * a whole-machine reason in {@link unwatchableReason}.
	 */
	channelReasons: Partial<Record<ComputerChannel, ComputerUnwatchableReason>>;
	/** True when at least one channel can be served. */
	watchable: boolean;
	/** The one reason to show when {@link watchable} is false; null otherwise. */
	unwatchableReason: ComputerUnwatchableReason | null;
	/** True when this is the Node the Agent's work is pinned to. */
	boundToAgent: boolean;
	controlPolicy: ComputerControlPolicy;
}

/**
 * One Agent's own profile on one Node. `profileRef` is the opaque id the
 * Node maps to a directory on its own disk; the platform never stores or
 * returns a filesystem path.
 */
export interface NodeAgentProfileView {
	nodeId: string;
	agentId: string;
	profileRef: string;
	createdAt: string | null;
	lastUsedAt: string | null;
	signedInSiteCount: number;
	diskBytes: number;
	lastResetAt: string | null;
}
