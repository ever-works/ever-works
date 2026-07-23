/**
 * Streaming-terminal wire protocol — codec + guards.
 *
 * Hand-rolled (this package is zero-dependency by design) and hardened
 * for a hot wire path: every helper returns `null`/`false` on malformed
 * input — none of them ever throws — and decoding constructs the
 * returned frame field-by-field so unknown properties, oversized
 * payloads, and `__proto__`-style keys never survive validation.
 * See `terminal-frame.types.ts` for the protocol invariants.
 */

import {
	TERMINAL_CLIENT_TO_SERVER_KINDS,
	TERMINAL_EXIT_REASONS,
	TERMINAL_MAX_AUTH_TOKEN_LENGTH,
	TERMINAL_MAX_DIMENSION,
	TERMINAL_MAX_ERROR_MESSAGE_LENGTH,
	TERMINAL_MAX_FRAME_BYTES,
	TERMINAL_MIN_DIMENSION,
	TERMINAL_SERVER_TO_CLIENT_KINDS,
	type TerminalClientToServerFrame,
	type TerminalExitReason,
	type TerminalFrame,
	type TerminalServerToClientFrame
} from './terminal-frame.types.js';

/**
 * Canonical base64 (RFC 4648, with padding, no whitespace). The data
 * fields carry raw PTY bytes — anything that is not clean base64 is a
 * protocol violation, not something to repair. Canonical includes the
 * final quantum's unused bits being zero: a 2-pad quantum must end in
 * one of `AQgw`, a 1-pad quantum in one of `AEIMQUYcgkosw048` — so a
 * given byte sequence has exactly ONE wire representation (`AB==` and
 * `AA==` decode to the same byte; only `AA==` is canonical).
 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

/**
 * Shape gate for an AgentRun id: 8-4-4-4-12 hex. Deliberately does NOT
 * enforce RFC 4122 version/variant bits — this is an injection barrier
 * in front of registry/DB lookups (no traversal, no metacharacters,
 * bounded length), not a UUID authenticity check; a well-shaped id that
 * matches no row is simply not found. Version-agnosticism keeps ids
 * from fixtures, imports, or a future non-v4 generator valid.
 */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ASCII control characters (base64/JWT payloads must not contain any). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBase64(value: unknown): value is string {
	return typeof value === 'string' && BASE64_PATTERN.test(value);
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Byte-size gate, run BEFORE any parsing. Exact when handed bytes; for
 * strings the cheap UTF-16 length check short-circuits the common case
 * and `TextEncoder` is only consulted in the narrow band where
 * multi-byte characters could push an under-length string over the cap.
 */
export function isTerminalFrameWithinSizeCap(raw: string | Uint8Array): boolean {
	if (typeof raw !== 'string') {
		return raw.byteLength <= TERMINAL_MAX_FRAME_BYTES;
	}
	if (raw.length > TERMINAL_MAX_FRAME_BYTES) {
		return false;
	}
	// Every UTF-16 code unit encodes to at most 3 UTF-8 bytes (surrogate
	// pairs: 2 units → 4 bytes < 2×3), so below a third of the cap the
	// string cannot overflow it.
	if (raw.length * 3 <= TERMINAL_MAX_FRAME_BYTES) {
		return true;
	}
	return new TextEncoder().encode(raw).byteLength <= TERMINAL_MAX_FRAME_BYTES;
}

/**
 * Decode + validate a single wire frame. Returns a freshly-constructed,
 * fully-validated frame — or `null` for anything else: oversize input,
 * invalid JSON, wrong shape, out-of-range values, unknown kind. Never
 * throws.
 */
export function decodeTerminalFrame(raw: string | Uint8Array): TerminalFrame | null {
	if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
		return null;
	}
	if (!isTerminalFrameWithinSizeCap(raw)) {
		return null;
	}

	let text: string;
	let parsed: unknown;
	try {
		text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
		parsed = JSON.parse(text);
	} catch {
		return null;
	}

	return normalizeTerminalFrame(parsed);
}

/**
 * Validate an already-parsed value and rebuild it as a canonical frame.
 * Exposed for callers that receive structured payloads (e.g. the batch
 * publish endpoint body) rather than raw socket text.
 *
 * The JSON.parse path can never hand us live getters, but a STRUCTURED
 * caller could pass a Proxy / accessor object whose property reads
 * throw — the try/catch preserves the null-never-throw contract even
 * against a hostile object graph.
 */
export function normalizeTerminalFrame(value: unknown): TerminalFrame | null {
	try {
		return normalizeTerminalFrameUnsafe(value);
	} catch {
		return null;
	}
}

function normalizeTerminalFrameUnsafe(value: unknown): TerminalFrame | null {
	if (!isRecord(value)) {
		return null;
	}

	// Own-property lookup only: `value.kind` on a crafted object could
	// otherwise resolve through the prototype chain.
	const kind = Object.prototype.hasOwnProperty.call(value, 'kind') ? value.kind : undefined;

	switch (kind) {
		case 'stdout': {
			const { seq, data } = value;
			if (!isBoundedInt(seq, 0, Number.MAX_SAFE_INTEGER) || !isBase64(data)) {
				return null;
			}
			return { kind: 'stdout', seq, data };
		}
		case 'stdin': {
			const { data } = value;
			if (!isBase64(data)) {
				return null;
			}
			return { kind: 'stdin', data };
		}
		case 'resize': {
			const { cols, rows } = value;
			if (
				!isBoundedInt(cols, TERMINAL_MIN_DIMENSION, TERMINAL_MAX_DIMENSION) ||
				!isBoundedInt(rows, TERMINAL_MIN_DIMENSION, TERMINAL_MAX_DIMENSION)
			) {
				return null;
			}
			return { kind: 'resize', cols, rows };
		}
		case 'exit': {
			const { code, reason } = value;
			if (!isBoundedInt(code, -2147483648, 2147483647)) {
				return null;
			}
			if (typeof reason !== 'string' || !(TERMINAL_EXIT_REASONS as readonly string[]).includes(reason)) {
				return null;
			}
			return { kind: 'exit', code, reason: reason as TerminalExitReason };
		}
		case 'error': {
			const { message } = value;
			if (typeof message !== 'string' || message.length > TERMINAL_MAX_ERROR_MESSAGE_LENGTH) {
				return null;
			}
			return { kind: 'error', message };
		}
		case 'auth': {
			const { token } = value;
			if (
				typeof token !== 'string' ||
				token.length === 0 ||
				token.length > TERMINAL_MAX_AUTH_TOKEN_LENGTH ||
				CONTROL_CHAR_PATTERN.test(token) ||
				/\s/.test(token)
			) {
				return null;
			}
			return { kind: 'auth', token };
		}
		default:
			return null;
	}
}

/**
 * Encode a frame for the wire. Validates through the same normalizer —
 * an invalid frame (out-of-range values, unknown kind) encodes to
 * `null` rather than shipping garbage that peers would drop anyway.
 */
export function encodeTerminalFrame(frame: TerminalFrame): string | null {
	const normalized = normalizeTerminalFrame(frame);
	if (normalized === null) {
		return null;
	}
	const encoded = JSON.stringify(normalized);
	return isTerminalFrameWithinSizeCap(encoded) ? encoded : null;
}

/**
 * Build an `error` banner frame from arbitrary text, truncating instead
 * of rejecting — banner construction sites (spawn preambles, guard
 * responses) must always succeed.
 */
export function makeTerminalErrorFrame(message: string): TerminalFrame {
	const text = typeof message === 'string' ? message : String(message);
	return {
		kind: 'error',
		message:
			text.length > TERMINAL_MAX_ERROR_MESSAGE_LENGTH
				? `${text.slice(0, TERMINAL_MAX_ERROR_MESSAGE_LENGTH - 1)}…`
				: text
	};
}

/** Direction guard — may this frame travel client → server? */
export function isTerminalClientToServerFrame(frame: TerminalFrame): frame is TerminalClientToServerFrame {
	return (TERMINAL_CLIENT_TO_SERVER_KINDS as readonly string[]).includes(frame.kind);
}

/** Direction guard — may this frame travel server → client? */
export function isTerminalServerToClientFrame(frame: TerminalFrame): frame is TerminalServerToClientFrame {
	return (TERMINAL_SERVER_TO_CLIENT_KINDS as readonly string[]).includes(frame.kind);
}

/**
 * Shape gate for a relay channel id (an AgentRun UUID), applied before
 * any registry lookup or DB touch.
 */
export function isValidTerminalRunId(value: unknown): value is string {
	return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/**
 * Attach-URL guard: `wss:` anywhere; plain `ws:` only to loopback hosts
 * (local dev / docker compose). Anything else — other protocols, ws to
 * a routable host, unparseable input — is refused.
 */
export function isAllowedTerminalWsUrl(value: unknown): boolean {
	if (typeof value !== 'string') {
		return false;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === 'wss:') {
		return true;
	}
	if (url.protocol !== 'ws:') {
		return false;
	}
	const host = url.hostname.toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
