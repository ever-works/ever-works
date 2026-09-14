/**
 * Agent computers — the live-view wire protocol: frame types + constants.
 *
 * What an owner's browser, the API relay and an enrolled node speak when
 * the owner watches (and, later, drives) the machine an Agent works on.
 * It is the streaming terminal's protocol one level over, and it is
 * written to the SAME invariants (see `terminal/terminal-frame.types.ts`)
 * because it rides the same relay, the same attach tokens and the same
 * WebSocket gateway:
 *
 *  - **Size-capped before parse.** A wire frame over
 *    {@link COMPUTER_MAX_WIRE_FRAME_BYTES} is rejected without reaching
 *    `JSON.parse`; a picture over {@link COMPUTER_MAX_FRAME_BYTES}
 *    decoded is rejected by the codec.
 *  - **Null, never throw.** Every decode / guard helper answers
 *    `null` / `false` on malformed input.
 *  - **Direction-mapped kinds.** A kind is valid in exactly one direction
 *    per leg ({@link COMPUTER_CLIENT_TO_SERVER_KINDS},
 *    {@link COMPUTER_SERVER_TO_CLIENT_KINDS},
 *    {@link COMPUTER_NODE_TO_SERVER_KINDS}): a replayed picture can never
 *    re-enter as input, and a browser can never publish a picture.
 *  - **Normalized construction.** Decoding rebuilds each frame field by
 *    field; unknown keys (including `__proto__`) never survive.
 *
 * The terminal channel is NOT redefined here: a {@link ComputerTerminalFrame}
 * wraps a `TerminalFrame` from the sibling module, so one pane renders both
 * sources with one renderer.
 */

import type { TerminalFrame } from '../terminal/terminal-frame.types.js';

/** Largest single picture, DECODED bytes. */
export const COMPUTER_MAX_FRAME_BYTES = 512 * 1024;

/** Most pictures one node publish may carry. */
export const COMPUTER_MAX_BATCH_FRAMES = 8;

/** Most decoded picture bytes one node publish may carry in total. */
export const COMPUTER_MAX_BATCH_BYTES = 512 * 1024;

/**
 * Pre-parse cap on one encoded wire frame: a max-size picture in base64
 * (4/3 of {@link COMPUTER_MAX_FRAME_BYTES}) plus room for its envelope.
 */
export const COMPUTER_MAX_WIRE_FRAME_BYTES = Math.ceil((COMPUTER_MAX_FRAME_BYTES * 4) / 3) + 4096;

export const COMPUTER_MAX_ERROR_MESSAGE_LENGTH = 8192;
export const COMPUTER_MAX_AUTH_TOKEN_LENGTH = 4096;
export const COMPUTER_MAX_TEXT_LENGTH = 4096;

/** Inclusive bound for picture dimensions and pointer coordinates, in picture pixels. */
export const COMPUTER_MAX_DIMENSION = 8192;

/** The three named quality settings, sharpest first. */
export const COMPUTER_QUALITIES = ['sharp', 'smooth', 'steady'] as const;
export type ComputerQuality = (typeof COMPUTER_QUALITIES)[number];

export interface ComputerQualityPreset {
	/** Picture width in pixels; height follows the aspect ratio. */
	readonly width: number;
	/** Most pictures per second. */
	readonly maxFps: number;
	/** A full picture at least this often, in milliseconds. */
	readonly keyframeMs: number;
	/** Encoder quality, 1–100. */
	readonly q: number;
}

/**
 * Fixed parameters per quality setting. A capture backend reads these; it
 * never re-declares the numbers.
 */
export const COMPUTER_QUALITY_PRESETS: Readonly<Record<ComputerQuality, ComputerQualityPreset>> = Object.freeze({
	sharp: Object.freeze({ width: 1280, maxFps: 8, keyframeMs: 5000, q: 70 }),
	smooth: Object.freeze({ width: 960, maxFps: 15, keyframeMs: 5000, q: 55 }),
	steady: Object.freeze({ width: 800, maxFps: 2, keyframeMs: 2000, q: 45 })
});

/**
 * Why a session ended — a closed set, so a UI can switch on it and an
 * audit reader can count it.
 */
export const COMPUTER_CLOSE_REASONS = [
	'closed-by-user',
	'no-viewer',
	'session-ceiling',
	'stalled',
	'node-restarted',
	'node-unavailable',
	'stopped',
	'access-revoked',
	'abandoned',
	'error'
] as const;
export type ComputerCloseReason = (typeof COMPUTER_CLOSE_REASONS)[number];

/** Why a stretch of control ended. */
export const COMPUTER_CONTROL_RELEASE_REASONS = [
	'given-back',
	'idle',
	'disconnected',
	'ceiling',
	'handed-over',
	'revoked',
	'session-ended'
] as const;
export type ComputerControlReleaseReason = (typeof COMPUTER_CONTROL_RELEASE_REASONS)[number];

/** Encodings a picture may carry. */
export const COMPUTER_FRAME_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ComputerFrameMime = (typeof COMPUTER_FRAME_MIMES)[number];

/** One picture of the captured surface. `seq` is monotonic per session. */
export interface ComputerScreenFrame {
	readonly kind: 'frame';
	readonly seq: number;
	/** A full picture (as opposed to one a backend may diff against). */
	readonly keyframe: boolean;
	readonly width: number;
	readonly height: number;
	readonly mime: ComputerFrameMime;
	/** Picture bytes, canonical base64. */
	readonly data: string;
}

/** A terminal frame carried on the computer channel, unchanged. */
export interface ComputerTerminalFrame {
	readonly kind: 'terminal';
	readonly frame: TerminalFrame;
}

/**
 * What the identity strip and the quality readout need. `nodeLocalTime` is
 * the NODE's wall clock as an ISO-8601 string with its own offset — the
 * strip shows the machine's time, never the viewer's.
 */
export interface ComputerStatsFrame {
	readonly kind: 'stats';
	readonly nodeLocalTime: string | null;
	/** The quality the owner chose. */
	readonly quality: ComputerQuality;
	/** The quality actually streaming (lower when the link is slow). */
	readonly effectiveQuality: ComputerQuality;
	readonly fps: number;
	/** Pictures captured but not yet published. */
	readonly backlog: number;
	/** Bytes published since the session opened. */
	readonly bytesOut: number;
}

export const COMPUTER_MODES = ['watching', 'controlling'] as const;
export type ComputerMode = (typeof COMPUTER_MODES)[number];

/** The session's mode changed. */
export interface ComputerModeFrame {
	readonly kind: 'mode';
	readonly mode: ComputerMode;
}

/** A human-readable banner. Never carries picture bytes. */
export interface ComputerErrorFrame {
	readonly kind: 'error';
	readonly message: string;
}

/** End of session, pinned by the relay and replayed to every later attach. */
export interface ComputerEndFrame {
	readonly kind: 'end';
	readonly reason: ComputerCloseReason;
}

/** First message on a socket: the short-lived attach token, never in a URL. */
export interface ComputerAuthFrame {
	readonly kind: 'auth';
	readonly token: string;
}

export const COMPUTER_POINTER_ACTIONS = ['move', 'down', 'up'] as const;
export type ComputerPointerAction = (typeof COMPUTER_POINTER_ACTIONS)[number];
export const COMPUTER_POINTER_BUTTONS = ['left', 'middle', 'right'] as const;
export type ComputerPointerButton = (typeof COMPUTER_POINTER_BUTTONS)[number];

/** Pointer input, in picture pixels. */
export interface ComputerPointerFrame {
	readonly kind: 'pointer';
	readonly action: ComputerPointerAction;
	readonly x: number;
	readonly y: number;
	readonly button: ComputerPointerButton | null;
}

export const COMPUTER_KEY_ACTIONS = ['down', 'up'] as const;
export type ComputerKeyAction = (typeof COMPUTER_KEY_ACTIONS)[number];

/** Largest `key` / `code` name accepted (`ArrowLeft`, `MediaTrackNext`, …). */
export const COMPUTER_MAX_KEY_NAME_LENGTH = 32;

/** A key press. `modifiers` is a bitmask: 1 alt, 2 ctrl, 4 meta, 8 shift. */
export interface ComputerKeyFrame {
	readonly kind: 'key';
	readonly action: ComputerKeyAction;
	readonly key: string;
	readonly code: string;
	readonly modifiers: number;
}

/** Typed text, delivered as one insertion. */
export interface ComputerTextFrame {
	readonly kind: 'text';
	readonly text: string;
}

/** Largest wheel delta accepted per axis. */
export const COMPUTER_MAX_SCROLL_DELTA = 10_000;

/** Wheel input at a point. */
export interface ComputerScrollFrame {
	readonly kind: 'scroll';
	readonly x: number;
	readonly y: number;
	readonly dx: number;
	readonly dy: number;
}

/** Ask for a different quality setting. */
export interface ComputerQualityFrame {
	readonly kind: 'quality';
	readonly quality: ComputerQuality;
}

/** Ask for a full picture now. */
export interface ComputerRefreshFrame {
	readonly kind: 'refresh';
}

export const COMPUTER_CONTROL_ACTIONS = ['request', 'release', 'keep'] as const;
export type ComputerControlAction = (typeof COMPUTER_CONTROL_ACTIONS)[number];

/** A control-flow intent from the socket that holds (or wants) control. */
export interface ComputerControlFrame {
	readonly kind: 'control';
	readonly action: ComputerControlAction;
}

/** Every frame that can appear on the wire. */
export type ComputerFrame =
	| ComputerScreenFrame
	| ComputerTerminalFrame
	| ComputerStatsFrame
	| ComputerModeFrame
	| ComputerErrorFrame
	| ComputerEndFrame
	| ComputerAuthFrame
	| ComputerPointerFrame
	| ComputerKeyFrame
	| ComputerTextFrame
	| ComputerScrollFrame
	| ComputerQualityFrame
	| ComputerRefreshFrame
	| ComputerControlFrame;

export type ComputerFrameKind = ComputerFrame['kind'];

/** Browser (or the node's own attached socket) → server. */
export const COMPUTER_CLIENT_TO_SERVER_KINDS = [
	'auth',
	'pointer',
	'key',
	'text',
	'scroll',
	'quality',
	'refresh',
	'control'
] as const;

/** Relay fan-out → attached sockets. */
export const COMPUTER_SERVER_TO_CLIENT_KINDS = ['frame', 'terminal', 'stats', 'mode', 'error', 'end'] as const;

/** Node publish leg → server (the internal HTTP endpoint). */
export const COMPUTER_NODE_TO_SERVER_KINDS = ['frame', 'terminal', 'stats', 'error', 'end'] as const;

/** Input kinds: what a controlling socket forwards to the machine. */
export const COMPUTER_INPUT_KINDS = ['pointer', 'key', 'text', 'scroll'] as const;

export type ComputerClientToServerFrame =
	| ComputerAuthFrame
	| ComputerPointerFrame
	| ComputerKeyFrame
	| ComputerTextFrame
	| ComputerScrollFrame
	| ComputerQualityFrame
	| ComputerRefreshFrame
	| ComputerControlFrame;

export type ComputerServerToClientFrame =
	| ComputerScreenFrame
	| ComputerTerminalFrame
	| ComputerStatsFrame
	| ComputerModeFrame
	| ComputerErrorFrame
	| ComputerEndFrame;

export type ComputerNodeToServerFrame =
	| ComputerScreenFrame
	| ComputerTerminalFrame
	| ComputerStatsFrame
	| ComputerErrorFrame
	| ComputerEndFrame;

export type ComputerInputFrame = ComputerPointerFrame | ComputerKeyFrame | ComputerTextFrame | ComputerScrollFrame;
