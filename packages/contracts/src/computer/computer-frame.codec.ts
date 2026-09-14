/**
 * Agent computers — live-view codec + guards.
 *
 * Hand-rolled (this package is zero-dependency) with the terminal codec's
 * posture: every helper answers `null` / `false` on malformed input and
 * none of them throws; decoding rebuilds each frame field by field. See
 * `computer-frame.types.ts` for the invariants.
 */

import { normalizeTerminalFrame } from '../terminal/terminal-frame.codec.js';
import {
	COMPUTER_CLIENT_TO_SERVER_KINDS,
	COMPUTER_CLOSE_REASONS,
	COMPUTER_CONTROL_ACTIONS,
	COMPUTER_FRAME_MIMES,
	COMPUTER_INPUT_KINDS,
	COMPUTER_KEY_ACTIONS,
	COMPUTER_MAX_AUTH_TOKEN_LENGTH,
	COMPUTER_MAX_BATCH_BYTES,
	COMPUTER_MAX_BATCH_FRAMES,
	COMPUTER_MAX_DIMENSION,
	COMPUTER_MAX_ERROR_MESSAGE_LENGTH,
	COMPUTER_MAX_FRAME_BYTES,
	COMPUTER_MAX_KEY_NAME_LENGTH,
	COMPUTER_MAX_SCROLL_DELTA,
	COMPUTER_MAX_TEXT_LENGTH,
	COMPUTER_MAX_WIRE_FRAME_BYTES,
	COMPUTER_MODES,
	COMPUTER_NODE_TO_SERVER_KINDS,
	COMPUTER_POINTER_ACTIONS,
	COMPUTER_POINTER_BUTTONS,
	COMPUTER_QUALITIES,
	COMPUTER_SERVER_TO_CLIENT_KINDS,
	type ComputerClientToServerFrame,
	type ComputerFrame,
	type ComputerInputFrame,
	type ComputerNodeToServerFrame,
	type ComputerPointerButton,
	type ComputerQuality,
	type ComputerServerToClientFrame
} from './computer-frame.types.js';

/** Canonical base64 — the same gate the terminal codec applies to its bytes. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** An ISO-8601 instant carrying its own offset (the node's clock, as the node sees it). */
const ISO_WITH_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
	return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** Decoded size of a canonical base64 string. */
export function decodedComputerBase64Bytes(data: string): number {
	if (data.length === 0) return 0;
	let padding = 0;
	if (data.endsWith('==')) padding = 2;
	else if (data.endsWith('=')) padding = 1;
	return (data.length / 4) * 3 - padding;
}

/** Pre-parse byte gate on one encoded frame. */
export function isComputerFrameWithinSizeCap(raw: string | Uint8Array): boolean {
	if (typeof raw !== 'string') {
		return raw.byteLength <= COMPUTER_MAX_WIRE_FRAME_BYTES;
	}
	if (raw.length > COMPUTER_MAX_WIRE_FRAME_BYTES) {
		return false;
	}
	if (raw.length * 3 <= COMPUTER_MAX_WIRE_FRAME_BYTES) {
		return true;
	}
	return new TextEncoder().encode(raw).byteLength <= COMPUTER_MAX_WIRE_FRAME_BYTES;
}

/** Decode one wire frame, or `null` for anything invalid. Never throws. */
export function decodeComputerFrame(raw: string | Uint8Array): ComputerFrame | null {
	if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
		return null;
	}
	if (!isComputerFrameWithinSizeCap(raw)) {
		return null;
	}
	let parsed: unknown;
	try {
		const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return normalizeComputerFrame(parsed);
}

/** Validate an already-parsed value and rebuild it canonically. Never throws. */
export function normalizeComputerFrame(value: unknown): ComputerFrame | null {
	try {
		return normalizeUnsafe(value);
	} catch {
		return null;
	}
}

function normalizeUnsafe(value: unknown): ComputerFrame | null {
	if (!isRecord(value)) {
		return null;
	}
	const kind = own(value, 'kind');
	switch (kind) {
		case 'frame': {
			const seq = own(value, 'seq');
			const keyframe = own(value, 'keyframe');
			const width = own(value, 'width');
			const height = own(value, 'height');
			const mime = own(value, 'mime');
			const data = own(value, 'data');
			if (
				!isBoundedInt(seq, 0, Number.MAX_SAFE_INTEGER) ||
				typeof keyframe !== 'boolean' ||
				!isBoundedInt(width, 1, COMPUTER_MAX_DIMENSION) ||
				!isBoundedInt(height, 1, COMPUTER_MAX_DIMENSION) ||
				!isOneOf(COMPUTER_FRAME_MIMES, mime) ||
				typeof data !== 'string' ||
				data.length === 0 ||
				!BASE64_PATTERN.test(data) ||
				decodedComputerBase64Bytes(data) > COMPUTER_MAX_FRAME_BYTES
			) {
				return null;
			}
			return { kind: 'frame', seq, keyframe, width, height, mime, data };
		}
		case 'terminal': {
			const frame = normalizeTerminalFrame(own(value, 'frame'));
			return frame ? { kind: 'terminal', frame } : null;
		}
		case 'stats': {
			const nodeLocalTime = own(value, 'nodeLocalTime');
			const quality = own(value, 'quality');
			const effectiveQuality = own(value, 'effectiveQuality');
			const fps = own(value, 'fps');
			const backlog = own(value, 'backlog');
			const bytesOut = own(value, 'bytesOut');
			if (
				!(
					nodeLocalTime === null ||
					(typeof nodeLocalTime === 'string' && ISO_WITH_OFFSET_PATTERN.test(nodeLocalTime))
				) ||
				!isOneOf(COMPUTER_QUALITIES, quality) ||
				!isOneOf(COMPUTER_QUALITIES, effectiveQuality) ||
				!isBoundedInt(fps, 0, 1000) ||
				!isBoundedInt(backlog, 0, 1_000_000) ||
				!isBoundedInt(bytesOut, 0, Number.MAX_SAFE_INTEGER)
			) {
				return null;
			}
			return {
				kind: 'stats',
				// Narrowed above; restated because some consumers compile without strict null checks.
				nodeLocalTime: nodeLocalTime as string | null,
				quality,
				effectiveQuality,
				fps,
				backlog,
				bytesOut
			};
		}
		case 'mode': {
			const mode = own(value, 'mode');
			return isOneOf(COMPUTER_MODES, mode) ? { kind: 'mode', mode } : null;
		}
		case 'error': {
			const message = own(value, 'message');
			if (typeof message !== 'string' || message.length > COMPUTER_MAX_ERROR_MESSAGE_LENGTH) {
				return null;
			}
			return { kind: 'error', message };
		}
		case 'end': {
			const reason = own(value, 'reason');
			return isOneOf(COMPUTER_CLOSE_REASONS, reason) ? { kind: 'end', reason } : null;
		}
		case 'auth': {
			const token = own(value, 'token');
			if (
				typeof token !== 'string' ||
				token.length === 0 ||
				token.length > COMPUTER_MAX_AUTH_TOKEN_LENGTH ||
				CONTROL_CHAR_PATTERN.test(token) ||
				/\s/.test(token)
			) {
				return null;
			}
			return { kind: 'auth', token };
		}
		case 'pointer': {
			const action = own(value, 'action');
			const x = own(value, 'x');
			const y = own(value, 'y');
			const button = own(value, 'button');
			if (
				!isOneOf(COMPUTER_POINTER_ACTIONS, action) ||
				!isBoundedInt(x, 0, COMPUTER_MAX_DIMENSION) ||
				!isBoundedInt(y, 0, COMPUTER_MAX_DIMENSION) ||
				!(button === null || isOneOf(COMPUTER_POINTER_BUTTONS, button))
			) {
				return null;
			}
			return { kind: 'pointer', action, x, y, button: button as ComputerPointerButton | null };
		}
		case 'key': {
			const action = own(value, 'action');
			const key = own(value, 'key');
			const code = own(value, 'code');
			const modifiers = own(value, 'modifiers');
			if (
				!isOneOf(COMPUTER_KEY_ACTIONS, action) ||
				!isKeyName(key) ||
				!isKeyName(code) ||
				!isBoundedInt(modifiers, 0, 15)
			) {
				return null;
			}
			return { kind: 'key', action, key, code, modifiers };
		}
		case 'text': {
			const text = own(value, 'text');
			if (typeof text !== 'string' || text.length === 0 || text.length > COMPUTER_MAX_TEXT_LENGTH) {
				return null;
			}
			return { kind: 'text', text };
		}
		case 'scroll': {
			const x = own(value, 'x');
			const y = own(value, 'y');
			const dx = own(value, 'dx');
			const dy = own(value, 'dy');
			if (
				!isBoundedInt(x, 0, COMPUTER_MAX_DIMENSION) ||
				!isBoundedInt(y, 0, COMPUTER_MAX_DIMENSION) ||
				!isBoundedInt(dx, -COMPUTER_MAX_SCROLL_DELTA, COMPUTER_MAX_SCROLL_DELTA) ||
				!isBoundedInt(dy, -COMPUTER_MAX_SCROLL_DELTA, COMPUTER_MAX_SCROLL_DELTA)
			) {
				return null;
			}
			return { kind: 'scroll', x, y, dx, dy };
		}
		case 'quality': {
			const quality = own(value, 'quality');
			return isOneOf(COMPUTER_QUALITIES, quality) ? { kind: 'quality', quality } : null;
		}
		case 'refresh':
			return { kind: 'refresh' };
		case 'control': {
			const action = own(value, 'action');
			return isOneOf(COMPUTER_CONTROL_ACTIONS, action) ? { kind: 'control', action } : null;
		}
		default:
			return null;
	}
}

/** A `key` / `code` name: short and free of control characters (a literal space key is allowed). */
function isKeyName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= COMPUTER_MAX_KEY_NAME_LENGTH &&
		!CONTROL_CHAR_PATTERN.test(value)
	);
}

/** Encode through the same normalizer — an invalid frame encodes to `null`. */
export function encodeComputerFrame(frame: ComputerFrame): string | null {
	const normalized = normalizeComputerFrame(frame);
	if (normalized === null) {
		return null;
	}
	const encoded = JSON.stringify(normalized);
	return isComputerFrameWithinSizeCap(encoded) ? encoded : null;
}

/** Build an `error` banner from arbitrary text, truncating rather than refusing. */
export function makeComputerErrorFrame(message: string): ComputerFrame {
	const text = typeof message === 'string' ? message : String(message);
	return {
		kind: 'error',
		message:
			text.length > COMPUTER_MAX_ERROR_MESSAGE_LENGTH
				? `${text.slice(0, COMPUTER_MAX_ERROR_MESSAGE_LENGTH - 1)}…`
				: text
	};
}

export function isComputerClientToServerFrame(frame: ComputerFrame): frame is ComputerClientToServerFrame {
	return (COMPUTER_CLIENT_TO_SERVER_KINDS as readonly string[]).includes(frame.kind);
}

export function isComputerServerToClientFrame(frame: ComputerFrame): frame is ComputerServerToClientFrame {
	return (COMPUTER_SERVER_TO_CLIENT_KINDS as readonly string[]).includes(frame.kind);
}

export function isComputerNodeToServerFrame(frame: ComputerFrame): frame is ComputerNodeToServerFrame {
	return (COMPUTER_NODE_TO_SERVER_KINDS as readonly string[]).includes(frame.kind);
}

export function isComputerInputFrame(frame: ComputerFrame): frame is ComputerInputFrame {
	return (COMPUTER_INPUT_KINDS as readonly string[]).includes(frame.kind);
}

/**
 * Batch gate for one node publish, applied to the RAW body before any frame
 * is normalized: at most {@link COMPUTER_MAX_BATCH_FRAMES} pictures and
 * {@link COMPUTER_MAX_BATCH_BYTES} of picture data. Counts only what it can
 * see cheaply (the `data` string lengths), so an over-cap batch is refused
 * without decoding a single picture. Non-picture frames ride free.
 */
export function isComputerFrameBatchWithinCaps(items: readonly unknown[]): boolean {
	let pictures = 0;
	let bytes = 0;
	for (const item of items) {
		if (!isRecord(item) || own(item, 'kind') !== 'frame') continue;
		pictures += 1;
		const data = own(item, 'data');
		if (typeof data === 'string') {
			bytes += Math.floor((data.length * 3) / 4);
		}
		if (pictures > COMPUTER_MAX_BATCH_FRAMES || bytes > COMPUTER_MAX_BATCH_BYTES) {
			return false;
		}
	}
	return true;
}

/**
 * One tier down the quality ladder (sharp → smooth → steady), or the same
 * tier at the floor. The capture side degrades with this and never skips.
 */
export function lowerComputerQuality(quality: ComputerQuality): ComputerQuality {
	const index = COMPUTER_QUALITIES.indexOf(quality);
	if (index < 0) return 'steady';
	return COMPUTER_QUALITIES[Math.min(index + 1, COMPUTER_QUALITIES.length - 1)];
}
