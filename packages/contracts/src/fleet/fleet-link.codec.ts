/**
 * Fleet node link — frame codec and control-message guards (FL-02,
 * CONTRACTS §3.2).
 *
 * Hand-rolled (this package is zero-dependency) and hardened for a wire
 * that carries terminal bytes and desktop pictures:
 *
 *  - nothing here ever THROWS on malformed input — every decoder answers
 *    `null`;
 *  - the size cap is checked on the raw length BEFORE a byte of payload is
 *    looked at, and a frame whose declared length disagrees with what
 *    arrived is refused;
 *  - JSON is decoded as strict UTF-8, parsed with `__proto__`,
 *    `constructor` and `prototype` keys dropped at every depth, bounded in
 *    size and nesting, and the link's own control messages are rebuilt
 *    field by field so an unknown property never survives validation.
 *
 * See `fleet-link.types.ts` for the protocol.
 */

import {
	FLEET_LINK_CONTROL_TYPES,
	FLEET_LINK_FRAME_HEADER_BYTES,
	FLEET_LINK_MAX_CHANNEL_NUMBER,
	FLEET_LINK_MAX_CHANNELS,
	FLEET_LINK_MAX_FRAME_BYTES,
	FLEET_LINK_MAX_HINT_LENGTH,
	FLEET_LINK_MAX_JSON_BYTES,
	FLEET_LINK_FRAME_KINDS,
	isFleetLinkErrorCode,
	isFleetLinkFamily,
	isFleetLinkFrameKind,
	isFleetLinkId,
	normalizeFleetConsents,
	type FleetLinkChannelClose,
	type FleetLinkChannelReady,
	type FleetLinkCloseReason,
	type FleetLinkControlMessage,
	type FleetLinkError,
	type FleetLinkExtensionMessage,
	type FleetLinkFrameKind,
	type FleetLinkHello,
	type FleetLinkLimits,
	type FleetLinkOperationDone,
	type FleetLinkReply,
	type FleetLinkRequest,
	type FleetLinkResumeChannel
} from './fleet-link.types.js';

/** One decoded frame. `payload` is a view into the received bytes, not a copy. */
export interface FleetLinkFrame {
	channel: number;
	kind: FleetLinkFrameKind;
	payload: Uint8Array;
}

/** Deepest nesting a JSON message may have. */
export const FLEET_LINK_MAX_JSON_DEPTH = 32;

/** Bounds on the strings and lists inside the link's own control messages. */
const MAX_TOKEN_LENGTH = 4096;
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 128;
const MAX_VERSION_LENGTH = 64;
const MAX_RESUME_KEY_LENGTH = 128;
const MAX_SERVER_TIME_LENGTH = 64;
const MAX_PROGRESS_MESSAGE_LENGTH = 500;
const MAX_DRAIN_GRACE_SEC = 3600;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `session.event`, `logs.line` — a family's own channel-0 `type`. */
const EXTENSION_TYPE_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}(?:\.[a-z][a-zA-Z0-9-]{0,31}){1,3}$/;
/** Printable ASCII, no spaces — resume keys are opaque ids. */
const RESUME_KEY_PATTERN = /^[\x21-\x7e]+$/;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_TYPES: ReadonlySet<string> = new Set(FLEET_LINK_CONTROL_TYPES);
const KIND_JSON = FLEET_LINK_FRAME_KINDS.JSON;

const utf8Encoder = new TextEncoder();

function utf8Decode(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChannelNumber(value: unknown, allowControl = false): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= (allowControl ? 0 : 1) &&
		value <= FLEET_LINK_MAX_CHANNEL_NUMBER
	);
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function boundedString(value: unknown, max: number): string | null {
	return typeof value === 'string' && value.length <= max ? value : null;
}

function toBytes(raw: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array | null {
	if (raw instanceof Uint8Array) return raw;
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	return null;
}

// ─── Frames ─────────────────────────────────────────────────────────────────

/**
 * Encode one frame. `null` for anything the protocol does not allow: a
 * channel number outside `u32`, an unknown kind, or a frame larger than
 * {@link FLEET_LINK_MAX_FRAME_BYTES}.
 */
export function encodeFleetLinkFrame(
	channel: number,
	kind: FleetLinkFrameKind,
	payload: Uint8Array
): Uint8Array | null {
	if (!isChannelNumber(channel, true) || !isFleetLinkFrameKind(kind) || !(payload instanceof Uint8Array)) {
		return null;
	}
	const total = FLEET_LINK_FRAME_HEADER_BYTES + payload.byteLength;
	if (total > FLEET_LINK_MAX_FRAME_BYTES) return null;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, channel, false);
	view.setUint8(4, kind);
	view.setUint32(5, payload.byteLength, false);
	out.set(payload, FLEET_LINK_FRAME_HEADER_BYTES);
	return out;
}

/**
 * Decode one frame, or `null`. The total size is checked FIRST — a frame
 * over the cap is refused without reading its header — then the header's
 * length must match the bytes that actually arrived, exactly.
 */
export function decodeFleetLinkFrame(raw: Uint8Array | ArrayBuffer | ArrayBufferView): FleetLinkFrame | null {
	const bytes = toBytes(raw);
	if (!bytes) return null;
	if (bytes.byteLength > FLEET_LINK_MAX_FRAME_BYTES) return null;
	if (bytes.byteLength < FLEET_LINK_FRAME_HEADER_BYTES) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const channel = view.getUint32(0, false);
	const kind = view.getUint8(4);
	const length = view.getUint32(5, false);
	if (!isFleetLinkFrameKind(kind)) return null;
	if (length !== bytes.byteLength - FLEET_LINK_FRAME_HEADER_BYTES) return null;
	return {
		channel,
		kind,
		payload: bytes.subarray(FLEET_LINK_FRAME_HEADER_BYTES)
	};
}

/**
 * The channel a frame claims, read from its first four bytes and nothing
 * else — for closing the one channel an oversized or malformed frame was
 * aimed at without parsing it. `null` when fewer than four bytes arrived.
 */
export function peekFleetLinkFrameChannel(raw: Uint8Array | ArrayBuffer | ArrayBufferView): number | null {
	const bytes = toBytes(raw);
	if (!bytes || bytes.byteLength < 4) return null;
	return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

// ─── JSON payloads ──────────────────────────────────────────────────────────

function depthWithin(value: unknown, maxDepth: number): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (next.depth > maxDepth) return false;
		if (typeof next.value === 'object' && next.value !== null) {
			for (const child of Object.values(next.value as Record<string, unknown>)) {
				if (typeof child === 'object' && child !== null) stack.push({ value: child, depth: next.depth + 1 });
			}
		}
	}
	return true;
}

/**
 * Parse a JSON payload into a plain object, or `null`. Strict UTF-8,
 * bounded in bytes and nesting; `__proto__`, `constructor` and `prototype`
 * keys are dropped at every depth. Anything other than an object at the
 * top (an array, a number, `null`) is refused.
 */
export function decodeFleetLinkJson(
	payload: Uint8Array,
	maxBytes: number = FLEET_LINK_MAX_JSON_BYTES
): Record<string, unknown> | null {
	if (!(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > maxBytes) return null;
	const text = utf8Decode(payload);
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text, (key, value) => (FORBIDDEN_KEYS.has(key) ? undefined : value));
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !depthWithin(parsed, FLEET_LINK_MAX_JSON_DEPTH)) return null;
	return parsed;
}

/** Serialise `value` as a JSON frame on `channel`, or `null` (unserialisable, too large, bad channel). */
export function encodeFleetLinkJson(
	channel: number,
	value: unknown,
	maxBytes: number = channel === 0
		? FLEET_LINK_MAX_JSON_BYTES
		: FLEET_LINK_MAX_FRAME_BYTES - FLEET_LINK_FRAME_HEADER_BYTES
): Uint8Array | null {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		return null;
	}
	if (typeof text !== 'string') return null;
	const payload = utf8Encoder.encode(text);
	if (payload.byteLength > maxBytes) return null;
	return encodeFleetLinkFrame(channel, KIND_JSON, payload);
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Read an error envelope's `error` off the wire: a known code, a hint (cut
 * to {@link FLEET_LINK_MAX_HINT_LENGTH}), and plain-object details. `null`
 * for anything without a known code.
 */
export function normalizeFleetLinkError(value: unknown): FleetLinkError | null {
	if (!isRecord(value) || !isFleetLinkErrorCode(value.code)) return null;
	const hint = typeof value.hint === 'string' ? value.hint.slice(0, FLEET_LINK_MAX_HINT_LENGTH) : '';
	const error: FleetLinkError = { code: value.code, hint };
	if (isRecord(value.details)) error.details = value.details;
	return error;
}

/** Build an error, its hint cut to the bound. */
export function makeFleetLinkError(
	code: FleetLinkError['code'],
	hint: string,
	details?: Record<string, unknown>
): FleetLinkError {
	const error: FleetLinkError = { code, hint: hint.slice(0, FLEET_LINK_MAX_HINT_LENGTH) };
	if (details) error.details = details;
	return error;
}

function closeReason(value: unknown): FleetLinkCloseReason | null {
	if (value === 'normal') return 'normal';
	return isFleetLinkErrorCode(value) ? value : null;
}

// ─── Control messages ───────────────────────────────────────────────────────

function decodeCapabilities(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_TAGS) return null;
	const out: string[] = [];
	for (const tag of value) {
		if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LENGTH) return null;
		out.push(tag);
	}
	return out;
}

function decodeResumeChannels(value: unknown): FleetLinkResumeChannel[] | null {
	if (!Array.isArray(value) || value.length > FLEET_LINK_MAX_CHANNELS) return null;
	const out: FleetLinkResumeChannel[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isChannelNumber(entry.channel) || !isFleetLinkFamily(entry.family)) return null;
		const channel: FleetLinkResumeChannel = { channel: entry.channel, family: entry.family };
		if (entry.resumeKey !== undefined) {
			const key = boundedString(entry.resumeKey, MAX_RESUME_KEY_LENGTH);
			if (key === null || !RESUME_KEY_PATTERN.test(key)) return null;
			channel.resumeKey = key;
		}
		out.push(channel);
	}
	return out;
}

function decodeChannelList(value: unknown): number[] | null {
	if (!Array.isArray(value) || value.length > FLEET_LINK_MAX_CHANNELS) return null;
	return value.every((entry) => isChannelNumber(entry)) ? [...(value as number[])] : null;
}

function decodeLimits(value: unknown): FleetLinkLimits | null {
	if (!isRecord(value)) return null;
	const { maxFrameBytes, maxChannels, pingIntervalMs, silenceMs, inlineReplyMs } = value;
	if (
		!isBoundedInt(maxFrameBytes, FLEET_LINK_FRAME_HEADER_BYTES, FLEET_LINK_MAX_FRAME_BYTES) ||
		!isBoundedInt(maxChannels, 1, FLEET_LINK_MAX_CHANNELS) ||
		!isBoundedInt(pingIntervalMs, 1, 3_600_000) ||
		!isBoundedInt(silenceMs, 1, 3_600_000) ||
		!isBoundedInt(inlineReplyMs, 1, 3_600_000)
	) {
		return null;
	}
	return { maxFrameBytes, maxChannels, pingIntervalMs, silenceMs, inlineReplyMs };
}

function decodeHello(record: Record<string, unknown>): FleetLinkHello | null {
	const nodeId = boundedString(record.nodeId, 36);
	const token = boundedString(record.token, MAX_TOKEN_LENGTH);
	const capabilities = decodeCapabilities(record.capabilities);
	const consents = normalizeFleetConsents(record.consents);
	if (
		nodeId === null ||
		!UUID_PATTERN.test(nodeId) ||
		!isBoundedInt(record.linkVersion, 1, 1_000) ||
		capabilities === null ||
		consents === null ||
		token === null ||
		token.length === 0
	) {
		return null;
	}
	const hello: FleetLinkHello = {
		type: 'link.hello',
		nodeId: nodeId.toLowerCase(),
		linkVersion: record.linkVersion,
		capabilities,
		consents,
		token
	};
	if (record.nodeVersion !== undefined) {
		const version = boundedString(record.nodeVersion, MAX_VERSION_LENGTH);
		if (version === null) return null;
		hello.nodeVersion = version;
	}
	if (record.resume !== undefined) {
		if (!isRecord(record.resume) || !isBoundedInt(record.resume.linkGeneration, 0, Number.MAX_SAFE_INTEGER)) {
			return null;
		}
		const channels = decodeResumeChannels(record.resume.channels ?? []);
		if (channels === null) return null;
		hello.resume = { linkGeneration: record.resume.linkGeneration, channels };
	}
	return hello;
}

function decodeKnownControl(record: Record<string, unknown>): FleetLinkControlMessage | null {
	switch (record.type) {
		case 'link.hello':
			return decodeHello(record);
		case 'link.ready': {
			const limits = decodeLimits(record.limits);
			const serverTime = boundedString(record.serverTime, MAX_SERVER_TIME_LENGTH);
			const resumed = decodeChannelList(record.resumed ?? []);
			const closed = decodeChannelList(record.closed ?? []);
			if (
				!isBoundedInt(record.linkGeneration, 1, Number.MAX_SAFE_INTEGER) ||
				limits === null ||
				serverTime === null ||
				resumed === null ||
				closed === null
			) {
				return null;
			}
			return { type: 'link.ready', linkGeneration: record.linkGeneration, limits, serverTime, resumed, closed };
		}
		case 'link.ping':
		case 'link.pong':
			return typeof record.t === 'number' && Number.isFinite(record.t)
				? { type: record.type === 'link.ping' ? 'link.ping' : 'link.pong', t: record.t }
				: null;
		case 'link.pause':
			return record.reason === 'kill_switch' ? { type: 'link.pause', reason: 'kill_switch' } : null;
		case 'link.resume':
			return { type: 'link.resume' };
		case 'link.drain':
			return isBoundedInt(record.graceSec, 0, MAX_DRAIN_GRACE_SEC)
				? { type: 'link.drain', graceSec: record.graceSec }
				: null;
		case 'channel.open': {
			if (
				!isChannelNumber(record.channel) ||
				!isFleetLinkFamily(record.family) ||
				!isFleetLinkId(record.requestId) ||
				(record.params !== undefined && !isRecord(record.params))
			) {
				return null;
			}
			return {
				type: 'channel.open',
				channel: record.channel,
				family: record.family,
				params: (record.params as Record<string, unknown> | undefined) ?? {},
				requestId: record.requestId
			};
		}
		case 'channel.ready': {
			if (!isChannelNumber(record.channel) || !isFleetLinkId(record.requestId)) return null;
			const ready: FleetLinkChannelReady = {
				type: 'channel.ready',
				channel: record.channel,
				requestId: record.requestId
			};
			if (record.resumeKey !== undefined) {
				const key = boundedString(record.resumeKey, MAX_RESUME_KEY_LENGTH);
				if (key === null || !RESUME_KEY_PATTERN.test(key)) return null;
				ready.resumeKey = key;
			}
			return ready;
		}
		case 'channel.refused': {
			// The wire carries `error: { code, hint }` (the FL-02 plan, like every reply's
			// error); CONTRACTS §3.2 abbreviates it `{ code, hint }` — read either, write the first.
			const error = normalizeFleetLinkError(
				record.error !== undefined
					? record.error
					: { code: record.code, hint: record.hint, details: record.details }
			);
			if (!isChannelNumber(record.channel) || !isFleetLinkId(record.requestId) || error === null) return null;
			return { type: 'channel.refused', channel: record.channel, requestId: record.requestId, error };
		}
		case 'channel.close': {
			const reason = closeReason(record.reason);
			if (!isChannelNumber(record.channel) || reason === null) return null;
			const close: FleetLinkChannelClose = { type: 'channel.close', channel: record.channel, reason };
			if (typeof record.hint === 'string') close.hint = record.hint.slice(0, FLEET_LINK_MAX_HINT_LENGTH);
			return close;
		}
		case 'operation.progress': {
			if (!isFleetLinkId(record.operationId) || !isRecord(record.progress)) return null;
			const progress: { percent?: number; message?: string } = {};
			if (record.progress.percent !== undefined) {
				const percent = record.progress.percent;
				if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)
					return null;
				progress.percent = percent;
			}
			if (record.progress.message !== undefined) {
				if (typeof record.progress.message !== 'string') return null;
				progress.message = record.progress.message.slice(0, MAX_PROGRESS_MESSAGE_LENGTH);
			}
			return { type: 'operation.progress', operationId: record.operationId, progress };
		}
		case 'operation.done': {
			if (!isFleetLinkId(record.operationId)) return null;
			const done: FleetLinkOperationDone = { type: 'operation.done', operationId: record.operationId };
			if (record.error !== undefined) {
				const error = normalizeFleetLinkError(record.error);
				if (error === null) return null;
				done.error = error;
			} else if (record.result !== undefined) {
				done.result = record.result;
			}
			return done;
		}
		case 'operation.cancel':
			return isFleetLinkId(record.operationId)
				? { type: 'operation.cancel', operationId: record.operationId }
				: null;
		default:
			return null;
	}
}

/**
 * Decode a channel-0 payload. The link's own `type`s are validated and
 * rebuilt field by field; a family's own `type` (`session.event`, …) is
 * passed through as a {@link FleetLinkExtensionMessage}, already stripped
 * of prototype keys and bounded like every JSON payload. `null` for
 * anything else — including a malformed message that claims one of the
 * link's own types.
 */
export function decodeFleetLinkControl(
	payload: Uint8Array
): FleetLinkControlMessage | FleetLinkExtensionMessage | null {
	const record = decodeFleetLinkJson(payload);
	if (!record || typeof record.type !== 'string') return null;
	if (CONTROL_TYPES.has(record.type)) return decodeKnownControl(record);
	if (!EXTENSION_TYPE_PATTERN.test(record.type)) return null;
	return record as FleetLinkExtensionMessage;
}

/** True when a decoded channel-0 message is one of the link's own control messages. */
export function isFleetLinkControlMessage(
	message: FleetLinkControlMessage | FleetLinkExtensionMessage
): message is FleetLinkControlMessage {
	return CONTROL_TYPES.has(message.type);
}

/** Encode a channel-0 message as a frame, or `null` (too large, unserialisable). */
export function encodeFleetLinkControl(
	message: FleetLinkControlMessage | FleetLinkExtensionMessage
): Uint8Array | null {
	return encodeFleetLinkJson(0, message, FLEET_LINK_MAX_JSON_BYTES);
}

// ─── Requests and replies on a channel ──────────────────────────────────────

/** Read a request (`{ requestId, type, params? }`) off a decoded channel message, or `null`. */
export function asFleetLinkRequest(record: Record<string, unknown>): FleetLinkRequest | null {
	if (!isFleetLinkId(record.requestId) || typeof record.type !== 'string' || record.type.length > 128) return null;
	if (record.params !== undefined && !isRecord(record.params)) return null;
	const request: FleetLinkRequest = { requestId: record.requestId, type: record.type };
	if (record.params !== undefined) request.params = record.params as Record<string, unknown>;
	return request;
}

/**
 * Read a reply off a decoded channel message, or `null`. Exactly one of
 * `error`, `operationId`, `result` is taken, in that order of precedence.
 */
export function asFleetLinkReply(record: Record<string, unknown>): FleetLinkReply | null {
	if (!isFleetLinkId(record.requestId)) return null;
	if (record.error !== undefined) {
		const error = normalizeFleetLinkError(record.error);
		return error ? { requestId: record.requestId, error } : null;
	}
	if (record.operationId !== undefined) {
		return isFleetLinkId(record.operationId)
			? { requestId: record.requestId, operationId: record.operationId }
			: null;
	}
	if (!('result' in record)) return null;
	return { requestId: record.requestId, result: record.result };
}

// ─── Small binary payloads ──────────────────────────────────────────────────

/** `RESIZE` payload: `[cols u16][rows u16]`. */
export function encodeFleetLinkResize(cols: number, rows: number): Uint8Array | null {
	if (!isBoundedInt(cols, 1, 0xffff) || !isBoundedInt(rows, 1, 0xffff)) return null;
	const out = new Uint8Array(4);
	const view = new DataView(out.buffer);
	view.setUint16(0, cols, false);
	view.setUint16(2, rows, false);
	return out;
}

export function decodeFleetLinkResize(payload: Uint8Array): { cols: number; rows: number } | null {
	if (!(payload instanceof Uint8Array) || payload.byteLength !== 4) return null;
	const view = new DataView(payload.buffer, payload.byteOffset, 4);
	const cols = view.getUint16(0, false);
	const rows = view.getUint16(2, false);
	return cols > 0 && rows > 0 ? { cols, rows } : null;
}

/** `EXIT` payload: `[code i32]`. */
export function encodeFleetLinkExit(code: number): Uint8Array | null {
	if (!isBoundedInt(code, -0x8000_0000, 0x7fff_ffff)) return null;
	const out = new Uint8Array(4);
	new DataView(out.buffer).setInt32(0, code, false);
	return out;
}

export function decodeFleetLinkExit(payload: Uint8Array): number | null {
	if (!(payload instanceof Uint8Array) || payload.byteLength !== 4) return null;
	return new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, false);
}

/** `ACK` payload: `[bytes u32]` of credit. */
export function encodeFleetLinkAck(bytes: number): Uint8Array | null {
	if (!isBoundedInt(bytes, 0, 0xffff_ffff)) return null;
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, bytes, false);
	return out;
}

export function decodeFleetLinkAck(payload: Uint8Array): number | null {
	if (!(payload instanceof Uint8Array) || payload.byteLength !== 4) return null;
	return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
}

/** `CLOSE` payload: a UTF-8 reason code. */
export function encodeFleetLinkCloseReason(reason: FleetLinkCloseReason): Uint8Array {
	return utf8Encoder.encode(reason);
}

export function decodeFleetLinkCloseReason(payload: Uint8Array): FleetLinkCloseReason | null {
	if (!(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > 64) return null;
	const text = utf8Decode(payload);
	return text === null ? null : closeReason(text);
}
