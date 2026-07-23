/**
 * Streaming-terminal wire protocol — frame types + protocol constants.
 *
 * The contract every streaming-terminal party speaks: the worker-side
 * session host publishing PTY bytes, the API relay/gateway fanning them
 * out, and the browser terminal pane. Lives in `@ever-works/contracts`
 * so all three consume one frozen definition without dragging in NestJS,
 * `ws`, or any schema library — this package is intentionally
 * zero-dependency, so validation is hand-rolled in the sibling codec
 * module (`terminal-frame.codec.ts`).
 *
 * Protocol invariants (enforced by the codec, tested exhaustively):
 *
 *  - **Size-capped before parse.** A frame over
 *    {@link TERMINAL_MAX_FRAME_BYTES} is rejected without ever reaching
 *    `JSON.parse` — an oversized payload cannot buy CPU or memory.
 *  - **Null, never throw.** Every decode/guard helper returns
 *    `null`/`false` on ANY malformed input. Wire handling code must be
 *    able to drop garbage frames without try/catch at each call site.
 *  - **Direction-mapped kinds.** Each frame kind is valid in exactly one
 *    direction (see {@link TERMINAL_CLIENT_TO_SERVER_KINDS} /
 *    {@link TERMINAL_SERVER_TO_CLIENT_KINDS}), so a replayed scrollback
 *    `stdout` can never be smuggled back into a session as keystrokes,
 *    and a malicious client can never inject fake terminal output.
 *  - **Normalized construction.** Decoding builds a fresh object
 *    field-by-field from the parsed input — unknown/extra properties
 *    (including `__proto__`-style keys) never survive into the returned
 *    frame.
 */

/** Hard cap on a single encoded frame, checked BEFORE `JSON.parse`. */
export const TERMINAL_MAX_FRAME_BYTES = 1024 * 1024;

/** Inclusive bounds for terminal resize dimensions (cols / rows). */
export const TERMINAL_MIN_DIMENSION = 1;
export const TERMINAL_MAX_DIMENSION = 1000;

/** Cap on `error` frame messages (banner text, not a data channel). */
export const TERMINAL_MAX_ERROR_MESSAGE_LENGTH = 8192;

/** Cap on the first-message `auth` frame token (a signed attach JWT). */
export const TERMINAL_MAX_AUTH_TOKEN_LENGTH = 4096;

/**
 * Why a terminal session ended.
 *
 *  - `completed` — the child process exited on its own.
 *  - `crashed`   — spawn failure, pump failure, or heartbeat-sweeper
 *                  verdict on a session that stopped reporting.
 *  - `closed`    — an authorized party explicitly ended the session.
 *  - `parked`    — the platform killed the idle/awaiting-input process
 *                  but kept the conversation resumable (the run stores
 *                  the CLI's own resume id); the UI offers Resume.
 */
export const TERMINAL_EXIT_REASONS = ['completed', 'crashed', 'closed', 'parked'] as const;

export type TerminalExitReason = (typeof TERMINAL_EXIT_REASONS)[number];

/**
 * PTY output. `seq` is the per-session monotonic sequence number the
 * publisher assigns — attach-time replay merges persisted transcript,
 * relay backlog, and the live tail deduplicated on it.
 */
export interface TerminalStdoutFrame {
	readonly kind: 'stdout';
	/** Non-negative safe integer, monotonic per session. */
	readonly seq: number;
	/** Raw PTY bytes, base64. */
	readonly data: string;
}

/** Keystrokes from the driving viewer. Base64 bytes. */
export interface TerminalStdinFrame {
	readonly kind: 'stdin';
	readonly data: string;
}

/** Viewport resize from the driving viewer. Bounded integers. */
export interface TerminalResizeFrame {
	readonly kind: 'resize';
	readonly cols: number;
	readonly rows: number;
}

/**
 * Terminal end-of-session. Published exactly once per session and
 * pinned by the relay so every current AND future attach learns the
 * session is over — never a silently-frozen pane.
 */
export interface TerminalExitFrame {
	readonly kind: 'exit';
	/** Child exit code (or a platform sentinel for crashed/parked). */
	readonly code: number;
	readonly reason: TerminalExitReason;
}

/**
 * Human-readable banner published into the stream — used for the
 * pre-spawn preamble ("provider not configured", "starting …") and for
 * protocol violations answered to a specific client. Never carries
 * terminal bytes.
 */
export interface TerminalErrorFrame {
	readonly kind: 'error';
	readonly message: string;
}

/**
 * First message a connecting socket MUST send: the short-lived signed
 * attach token minted by the REST attach endpoint. Carried in the frame
 * body — deliberately never in the URL, so tokens stay out of proxy and
 * access logs. Consumed by the gateway during the handshake; never
 * persisted, never fanned out, never part of replay.
 */
export interface TerminalAuthFrame {
	readonly kind: 'auth';
	readonly token: string;
}

/** Every frame that can appear on the wire. */
export type TerminalFrame =
	| TerminalStdoutFrame
	| TerminalStdinFrame
	| TerminalResizeFrame
	| TerminalExitFrame
	| TerminalErrorFrame
	| TerminalAuthFrame;

export type TerminalFrameKind = TerminalFrame['kind'];

/**
 * Direction map — client (browser / attached worker socket) → server.
 * Everything else arriving on an inbound socket leg is dropped by the
 * gateway (after decode) regardless of shape validity.
 */
export const TERMINAL_CLIENT_TO_SERVER_KINDS = ['auth', 'stdin', 'resize'] as const;

/** Direction map — server (relay fan-out) → client. */
export const TERMINAL_SERVER_TO_CLIENT_KINDS = ['stdout', 'exit', 'error'] as const;

export type TerminalClientToServerFrame = TerminalStdinFrame | TerminalResizeFrame | TerminalAuthFrame;
export type TerminalServerToClientFrame = TerminalStdoutFrame | TerminalExitFrame | TerminalErrorFrame;
