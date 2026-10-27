import {
	decodeDesktopTiles,
	FLEET_DESKTOP_MAX_DIMENSION,
	FLEET_DESKTOP_MAX_PUBLISH_BYTES,
	normalizeFleetDesktopControlReasons,
	normalizeFleetDesktopInputRefusedCode,
	normalizeFleetDesktopReasons,
	normalizeFleetDisplay,
	normalizeFleetDisplays,
	type ComputerInputFrame,
	type FleetDesktopControlReason,
	type FleetDesktopInputRefusedCode,
	type FleetDesktopReason,
	type FleetDisplayView
} from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, plan §3, CONTRACTS R-26) — the node's half of
 * the wire to the native screen helper (`apps/node/native/ever-works-screen`,
 * `src/protocol.rs`, which documents the same table).
 *
 * Over the helper's stdin / stdout — a same-user local channel, never a network
 * port — each message is `[len u32 BE][type u8][payload]`, `len` counting the
 * type byte. Control messages are JSON; a keyframe is `[w u16][h u16][JPEG]`;
 * tiles are the contracts `TILES` payload verbatim, re-checked here before they
 * are forwarded.
 *
 * Nothing in this module throws on what the helper sent: every reader answers
 * null, and the decoder reports a broken stream once so the supervisor can stop
 * the helper.
 */

export const HELPER_PROTOCOL_VERSION = 1;

export const HELPER_MESSAGES = {
	start: 0x01,
	stop: 0x02,
	setDisplay: 0x03,
	refresh: 0x04,
	quality: 0x05,
	listDisplays: 0x06,
	input: 0x10,
	releaseAll: 0x11,
	/**
	 * Owner question 14: let go of every modifier key and mouse button the OS reports held,
	 * whoever pressed them — sent to a FRESH helper after one died during control. Only releases.
	 */
	releaseHeld: 0x12,
	hello: 0x81,
	frame: 0x82,
	tiles: 0x83,
	displays: 0x84,
	error: 0x85,
	started: 0x86,
	/** P2: an input the helper did not inject (`{ outcome, code }`; injected inputs are not answered). */
	inputResult: 0x87
} as const;

export type HelperMessageKind = (typeof HELPER_MESSAGES)[keyof typeof HELPER_MESSAGES];

/** The largest message the node accepts from the helper (a publish is ≤ 512 KiB; headroom for JSON). */
export const HELPER_MAX_MESSAGE_BYTES = FLEET_DESKTOP_MAX_PUBLISH_BYTES + 64 * 1024;

/** What a stream is produced at (the quality preset's numbers). */
export interface HelperStreamSettings {
	width: number;
	quality: number;
	maxFps: number;
	keyframeMs: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** One framed message. */
export function encodeHelperMessage(kind: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
	const out = new Uint8Array(5 + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, payload.byteLength + 1);
	out[4] = kind & 0xff;
	out.set(payload, 5);
	return out;
}

/** One framed JSON message. */
export function encodeHelperJson(kind: number, value: Record<string, unknown>): Uint8Array {
	return encodeHelperMessage(kind, encoder.encode(JSON.stringify(value)));
}

/** `start` for a display (null = the primary) at these settings. */
export function helperStartMessage(display: string | null, settings: HelperStreamSettings): Uint8Array {
	const body: Record<string, unknown> = { ...settings };
	if (display) body.display = display;
	return encodeHelperJson(HELPER_MESSAGES.start, body);
}

export interface HelperMessage {
	kind: number;
	payload: Uint8Array;
}

/**
 * Re-assembles messages from the helper's stdout chunks. A length of zero or
 * over {@link HELPER_MAX_MESSAGE_BYTES} marks the stream broken: no message is
 * produced after it, and {@link HelperMessageDecoder.broken} says why.
 */
export class HelperMessageDecoder {
	private buffer = new Uint8Array(0);
	private reason: string | null = null;

	constructor(private readonly maxBytes: number = HELPER_MAX_MESSAGE_BYTES) {}

	get broken(): string | null {
		return this.reason;
	}

	push(chunk: Uint8Array): HelperMessage[] {
		if (this.reason) return [];
		const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		joined.set(this.buffer, 0);
		joined.set(chunk, this.buffer.byteLength);
		const out: HelperMessage[] = [];
		let offset = 0;
		while (joined.byteLength - offset >= 4) {
			const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0);
			if (length === 0 || length > this.maxBytes) {
				this.reason = length === 0 ? 'an empty message' : `a ${length}-byte message`;
				this.buffer = new Uint8Array(0);
				return out;
			}
			if (joined.byteLength - offset - 4 < length) break;
			const kind = joined[offset + 4];
			out.push({ kind, payload: joined.slice(offset + 5, offset + 4 + length) });
			offset += 4 + length;
		}
		this.buffer = joined.slice(offset);
		return out;
	}
}

function readJson(payload: Uint8Array): Record<string, unknown> | null {
	if (payload.byteLength === 0 || payload.byteLength > 256 * 1024) return null;
	try {
		const value: unknown = JSON.parse(decoder.decode(payload));
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The helper's `hello`. */
export interface HelperHello {
	protocol: number;
	version: string | null;
	platform: string | null;
	reasons: FleetDesktopReason[];
	displays: FleetDisplayView[];
	/** P2: what would stop input, known without opening anything (e.g. `permission-accessibility`). */
	inputReasons: FleetDesktopControlReason[];
}

export function parseHelperHello(payload: Uint8Array): HelperHello | null {
	const json = readJson(payload);
	if (!json || typeof json.protocol !== 'number' || !Number.isInteger(json.protocol)) return null;
	const version =
		typeof json.version === 'string' && /^[A-Za-z0-9.+_-]{1,32}$/.test(json.version) ? json.version : null;
	const platform = typeof json.platform === 'string' && /^[a-z0-9]{1,16}$/.test(json.platform) ? json.platform : null;
	return {
		protocol: json.protocol,
		version,
		platform,
		reasons: normalizeFleetDesktopReasons(json.reasons),
		displays: normalizeFleetDisplays(json.displays),
		// A helper that says nothing about input (one built before control) cannot inject.
		inputReasons: Array.isArray(json.inputReasons)
			? normalizeFleetDesktopControlReasons(json.inputReasons)
			: ['input-unavailable']
	};
}

/** `started`: what the stream shows. */
export interface HelperStarted {
	display: FleetDisplayView | null;
	displays: FleetDisplayView[];
	fellBack: boolean;
}

export function parseHelperStarted(payload: Uint8Array): HelperStarted | null {
	const json = readJson(payload);
	if (!json) return null;
	return {
		display: normalizeFleetDisplay(json.display),
		displays: normalizeFleetDisplays(json.displays),
		fellBack: json.fellBack === true
	};
}

/** `displays`: the list, and the display the stream fell back to when its own went away. */
export interface HelperDisplays {
	displays: FleetDisplayView[];
	fallback: FleetDisplayView | null;
}

export function parseHelperDisplays(payload: Uint8Array): HelperDisplays | null {
	const json = readJson(payload);
	if (!json) return null;
	return { displays: normalizeFleetDisplays(json.displays), fallback: normalizeFleetDisplay(json.fallback) };
}

/** `error`: a short code and a bounded, single-line message. */
export interface HelperError {
	code: string;
	message: string;
}

export function parseHelperError(payload: Uint8Array): HelperError | null {
	const json = readJson(payload);
	if (!json || typeof json.code !== 'string' || !/^[a-z][a-z-]{0,47}$/.test(json.code)) return null;
	const message =
		typeof json.message === 'string'
			? json.message
					.replace(/[\u0000-\u001f\u007f]/g, ' ')
					.trim()
					.slice(0, 300)
			: '';
	return { code: json.code, message };
}

/** A keyframe: `[width u16][height u16][JPEG]`. */
export interface HelperFrame {
	width: number;
	height: number;
	jpeg: Uint8Array;
}

export function parseHelperFrame(payload: Uint8Array): HelperFrame | null {
	if (payload.byteLength < 8 || payload.byteLength > FLEET_DESKTOP_MAX_PUBLISH_BYTES) return null;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const width = view.getUint16(0);
	const height = view.getUint16(2);
	if (width < 1 || height < 1 || width > FLEET_DESKTOP_MAX_DIMENSION || height > FLEET_DESKTOP_MAX_DIMENSION) {
		return null;
	}
	const jpeg = payload.subarray(4);
	if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
	return { width, height, jpeg };
}

/** A tiles payload, accepted only when it is a valid contracts `TILES` payload within the publish cap. */
export function acceptHelperTiles(payload: Uint8Array): Uint8Array | null {
	return decodeDesktopTiles(payload, FLEET_DESKTOP_MAX_PUBLISH_BYTES) ? payload : null;
}

// ─── Control (P2) ──────────────────────────────────────────────────────────

/** The largest `input` the node sends (a text input is capped well inside it). */
export const HELPER_INPUT_MAX_BYTES = 16 * 1024;

/** The size of the picture a controller's coordinates are in (the stream's last keyframe). */
export interface HelperPictureSize {
	width: number;
	height: number;
}

/**
 * `input` (0x10): the contracts' input frame plus the picture size the helper
 * maps pointer coordinates from (FR-38). Null when it would not fit.
 */
export function encodeHelperInput(frame: ComputerInputFrame, picture: HelperPictureSize): Uint8Array | null {
	const body: Record<string, unknown> = { ...frame, pictureWidth: picture.width, pictureHeight: picture.height };
	const bytes = encoder.encode(JSON.stringify(body));
	if (bytes.byteLength > HELPER_INPUT_MAX_BYTES) return null;
	return encodeHelperMessage(HELPER_MESSAGES.input, bytes);
}

/** `inputResult` (0x87): an input that was not injected — by code only. */
export interface HelperInputResult {
	outcome: 'blocked' | 'refused';
	code: FleetDesktopInputRefusedCode;
}

export function parseHelperInputResult(payload: Uint8Array): HelperInputResult | null {
	const json = readJson(payload);
	if (!json || (json.outcome !== 'blocked' && json.outcome !== 'refused')) return null;
	return {
		outcome: json.outcome,
		code: json.outcome === 'blocked' ? 'blocked-shortcut' : normalizeFleetDesktopInputRefusedCode(json.code)
	};
}
