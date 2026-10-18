import { describe, expect, it } from 'vitest';
import {
	asFleetLinkReply,
	asFleetLinkRequest,
	decodeFleetLinkAck,
	decodeFleetLinkCloseReason,
	decodeFleetLinkControl,
	decodeFleetLinkExit,
	decodeFleetLinkFrame,
	decodeFleetLinkJson,
	decodeFleetLinkResize,
	encodeFleetLinkAck,
	encodeFleetLinkCloseReason,
	encodeFleetLinkControl,
	encodeFleetLinkExit,
	encodeFleetLinkFrame,
	encodeFleetLinkJson,
	encodeFleetLinkResize,
	isFleetLinkControlMessage,
	makeFleetLinkError,
	normalizeFleetLinkError,
	peekFleetLinkFrameChannel
} from '../fleet-link.codec.js';
import {
	FLEET_LINK_FRAME_HEADER_BYTES,
	FLEET_LINK_FRAME_KINDS,
	FLEET_LINK_MAX_FRAME_BYTES,
	FLEET_LINK_MAX_HINT_LENGTH,
	FLEET_LINK_MAX_JSON_BYTES,
	type FleetLinkFrameKind
} from '../fleet-link.types.js';

const NODE = '7d1f0c2a-3b4e-4f5a-8c6d-9e0f1a2b3c4d';
const text = (value: string) => new TextEncoder().encode(value);

/** A frame with an arbitrary header, for refusals the encoder would never produce. */
function rawFrame(channel: number, kind: number, declaredLength: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(FLEET_LINK_FRAME_HEADER_BYTES + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, channel, false);
	view.setUint8(4, kind);
	view.setUint32(5, declaredLength, false);
	out.set(payload, FLEET_LINK_FRAME_HEADER_BYTES);
	return out;
}

function controlOf(value: unknown) {
	const frame = encodeFleetLinkJson(0, value);
	expect(frame).not.toBeNull();
	const decoded = decodeFleetLinkFrame(frame!);
	return decoded ? decodeFleetLinkControl(decoded.payload) : null;
}

describe('frames', () => {
	it('round-trips every kind on control and data channels', () => {
		const payload = new Uint8Array([0, 1, 2, 250, 255]);
		for (const kind of Object.values(FLEET_LINK_FRAME_KINDS) as FleetLinkFrameKind[]) {
			for (const channel of [0, 1, 63, 0xffff_ffff]) {
				const wire = encodeFleetLinkFrame(channel, kind, payload)!;
				expect(wire.byteLength).toBe(FLEET_LINK_FRAME_HEADER_BYTES + payload.byteLength);
				const frame = decodeFleetLinkFrame(wire);
				expect(frame).not.toBeNull();
				expect(frame!.channel).toBe(channel);
				expect(frame!.kind).toBe(kind);
				expect([...frame!.payload]).toEqual([...payload]);
			}
		}
	});

	it('writes the header big-endian: [channel u32][kind u8][len u32]', () => {
		const wire = encodeFleetLinkFrame(0x01020304, FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array([0xaa, 0xbb]))!;
		expect([...wire]).toEqual([1, 2, 3, 4, 1, 0, 0, 0, 2, 0xaa, 0xbb]);
	});

	it('decodes from an ArrayBuffer and from an offset view', () => {
		const wire = encodeFleetLinkFrame(7, FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0))!;
		expect(decodeFleetLinkFrame(wire.buffer.slice(0))).toMatchObject({ channel: 7, kind: 31 });
		const padded = new Uint8Array(wire.byteLength + 3);
		padded.set(wire, 3);
		expect(decodeFleetLinkFrame(padded.subarray(3))).toMatchObject({ channel: 7, kind: 31 });
	});

	it('refuses a frame over 16 MiB before parsing it (ACC-FL02-06)', () => {
		const oversized = new Uint8Array(FLEET_LINK_MAX_FRAME_BYTES + 1);
		// A perfectly well-formed header claiming the right length must not matter.
		new DataView(oversized.buffer).setUint32(0, 3, false);
		new DataView(oversized.buffer).setUint8(4, FLEET_LINK_FRAME_KINDS.DATA);
		new DataView(oversized.buffer).setUint32(5, oversized.byteLength - FLEET_LINK_FRAME_HEADER_BYTES, false);
		expect(decodeFleetLinkFrame(oversized)).toBeNull();
		// The channel it was aimed at is still readable without parsing.
		expect(peekFleetLinkFrameChannel(oversized)).toBe(3);
	});

	it('accepts a frame of exactly 16 MiB and refuses to encode one byte more', () => {
		const max = new Uint8Array(FLEET_LINK_MAX_FRAME_BYTES - FLEET_LINK_FRAME_HEADER_BYTES);
		const wire = encodeFleetLinkFrame(2, FLEET_LINK_FRAME_KINDS.DATA, max);
		expect(wire?.byteLength).toBe(FLEET_LINK_MAX_FRAME_BYTES);
		expect(decodeFleetLinkFrame(wire!)).not.toBeNull();
		expect(encodeFleetLinkFrame(2, FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array(max.byteLength + 1))).toBeNull();
	});

	it('refuses a truncated header, an unknown kind and a length that disagrees with the bytes', () => {
		expect(decodeFleetLinkFrame(new Uint8Array(8))).toBeNull();
		expect(decodeFleetLinkFrame(rawFrame(1, 99, 0, new Uint8Array(0)))).toBeNull();
		expect(decodeFleetLinkFrame(rawFrame(1, 1, 5, new Uint8Array(4)))).toBeNull();
		expect(decodeFleetLinkFrame(rawFrame(1, 1, 3, new Uint8Array(4)))).toBeNull();
		expect(peekFleetLinkFrameChannel(new Uint8Array(3))).toBeNull();
	});

	it('refuses to encode a bad channel or kind', () => {
		expect(encodeFleetLinkFrame(-1, FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array(0))).toBeNull();
		expect(encodeFleetLinkFrame(2 ** 32, FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array(0))).toBeNull();
		expect(encodeFleetLinkFrame(1.5, FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array(0))).toBeNull();
		expect(encodeFleetLinkFrame(1, 7 as FleetLinkFrameKind, new Uint8Array(0))).toBeNull();
	});

	it('never throws on 10 000 random buffers', () => {
		let seed = 0x2f6b_1c3d;
		const next = () => {
			seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
			return seed;
		};
		for (let i = 0; i < 10_000; i += 1) {
			const length = next() % 64;
			const bytes = new Uint8Array(length);
			for (let j = 0; j < length; j += 1) bytes[j] = next() & 0xff;
			// Make a share of them structurally plausible so the deeper paths run too.
			if (length >= FLEET_LINK_FRAME_HEADER_BYTES && i % 3 === 0) {
				const view = new DataView(bytes.buffer);
				view.setUint8(4, FLEET_LINK_FRAME_KINDS.JSON);
				view.setUint32(5, length - FLEET_LINK_FRAME_HEADER_BYTES, false);
			}
			expect(() => {
				const frame = decodeFleetLinkFrame(bytes);
				if (frame) {
					decodeFleetLinkControl(frame.payload);
					decodeFleetLinkJson(frame.payload);
					decodeFleetLinkResize(frame.payload);
					decodeFleetLinkExit(frame.payload);
					decodeFleetLinkAck(frame.payload);
					decodeFleetLinkCloseReason(frame.payload);
				}
				peekFleetLinkFrameChannel(bytes);
			}).not.toThrow();
		}
	});
});

describe('JSON payloads', () => {
	it('strips __proto__, constructor and prototype keys at every depth', () => {
		const decoded = decodeFleetLinkJson(
			text(
				'{"type":"session.event","__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"prototype":2,"ok":3}}'
			)
		);
		expect(decoded).toEqual({ type: 'session.event', nested: { ok: 3 } });
		expect(Object.prototype).not.toHaveProperty('polluted');
		expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
	});

	it('refuses non-objects, invalid UTF-8, empty and oversized payloads, and deep nesting', () => {
		expect(decodeFleetLinkJson(text('[1,2]'))).toBeNull();
		expect(decodeFleetLinkJson(text('42'))).toBeNull();
		expect(decodeFleetLinkJson(text('null'))).toBeNull();
		expect(decodeFleetLinkJson(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeNull();
		expect(decodeFleetLinkJson(new Uint8Array(0))).toBeNull();
		expect(decodeFleetLinkJson(text(`{"a":"${'x'.repeat(FLEET_LINK_MAX_JSON_BYTES)}"}`))).toBeNull();
		expect(decodeFleetLinkJson(text(`${'{"a":'.repeat(40)}1${'}'.repeat(40)}`))).toBeNull();
		expect(decodeFleetLinkJson(text(`${'{"a":'.repeat(20)}1${'}'.repeat(20)}`))).not.toBeNull();
	});

	it('refuses to encode an unserialisable or oversized control message', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(encodeFleetLinkJson(0, cyclic)).toBeNull();
		expect(
			encodeFleetLinkJson(0, { type: 'session.event', blob: 'x'.repeat(FLEET_LINK_MAX_JSON_BYTES) })
		).toBeNull();
		// A data channel may carry more than the control cap.
		expect(encodeFleetLinkJson(5, { blob: 'x'.repeat(FLEET_LINK_MAX_JSON_BYTES) })).not.toBeNull();
	});
});

describe('control messages', () => {
	const consents = { work: true, attend: false, manage: true, usageScan: false };

	it('rebuilds a hello field by field, dropping unknown properties and lower-casing the node id', () => {
		const hello = controlOf({
			type: 'link.hello',
			nodeId: NODE.toUpperCase(),
			linkVersion: 1,
			capabilities: ['terminal', 'managed'],
			consents: { ...consents, extra: true },
			token: 'tok',
			admin: true
		});
		expect(hello).toEqual({
			type: 'link.hello',
			nodeId: NODE,
			linkVersion: 1,
			capabilities: ['terminal', 'managed'],
			consents,
			token: 'tok'
		});
	});

	it('refuses a hello without a token, consents or a uuid node id', () => {
		const base = { type: 'link.hello', nodeId: NODE, linkVersion: 1, capabilities: [], consents, token: 'tok' };
		expect(controlOf({ ...base, token: '' })).toBeNull();
		expect(controlOf({ ...base, consents: 'all' })).toBeNull();
		expect(controlOf({ ...base, nodeId: '../etc/passwd' })).toBeNull();
		expect(controlOf({ ...base, capabilities: 'terminal' })).toBeNull();
		expect(controlOf({ ...base, resume: { linkGeneration: -1, channels: [] } })).toBeNull();
		expect(
			controlOf({ ...base, resume: { linkGeneration: 3, channels: [{ channel: 0, family: 'machine' }] } })
		).toBeNull();
		expect(
			controlOf({ ...base, resume: { linkGeneration: 3, channels: [{ channel: 2, family: 'shell' }] } })
		).toBeNull();
	});

	it('keeps a resume list and its keys', () => {
		const hello = controlOf({
			type: 'link.hello',
			nodeId: NODE,
			linkVersion: 1,
			capabilities: [],
			consents,
			token: 'tok',
			resume: { linkGeneration: 7, channels: [{ channel: 4, family: 'session', resumeKey: 'sess-01' }] }
		});
		expect(hello).toMatchObject({
			resume: { linkGeneration: 7, channels: [{ channel: 4, family: 'session', resumeKey: 'sess-01' }] }
		});
	});

	it('validates ready, ping, pause, drain and the channel lifecycle', () => {
		expect(
			controlOf({
				type: 'link.ready',
				linkGeneration: 8,
				limits: {
					maxFrameBytes: FLEET_LINK_MAX_FRAME_BYTES,
					maxChannels: 64,
					pingIntervalMs: 15000,
					silenceMs: 45000,
					inlineReplyMs: 2000
				},
				serverTime: '2026-10-18T09:41:00.000Z',
				resumed: [4],
				closed: [3]
			})
		).toMatchObject({ type: 'link.ready', linkGeneration: 8, resumed: [4], closed: [3] });
		expect(controlOf({ type: 'link.ready', linkGeneration: 0, limits: {}, serverTime: 'x' })).toBeNull();
		expect(controlOf({ type: 'link.ping', t: 5 })).toEqual({ type: 'link.ping', t: 5 });
		expect(controlOf({ type: 'link.pong', t: 'now' })).toBeNull();
		expect(controlOf({ type: 'link.pause', reason: 'kill_switch' })).toEqual({
			type: 'link.pause',
			reason: 'kill_switch'
		});
		expect(controlOf({ type: 'link.pause', reason: 'because' })).toBeNull();
		expect(controlOf({ type: 'link.drain', graceSec: 60 })).toEqual({ type: 'link.drain', graceSec: 60 });
		expect(controlOf({ type: 'link.drain', graceSec: 99_999 })).toBeNull();
		expect(controlOf({ type: 'channel.open', channel: 0, family: 'machine', requestId: 'r1' })).toBeNull();
		expect(controlOf({ type: 'channel.open', channel: 3, family: 'machine', requestId: 'r1' })).toEqual({
			type: 'channel.open',
			channel: 3,
			family: 'machine',
			params: {},
			requestId: 'r1'
		});
		expect(controlOf({ type: 'channel.ready', channel: 3, requestId: 'r1', resumeKey: 'has space' })).toBeNull();
		expect(
			controlOf({
				type: 'channel.refused',
				channel: 3,
				requestId: 'r1',
				error: { code: 'consent_missing', hint: 'start the node with --manage on build-01' }
			})
		).toMatchObject({ error: { code: 'consent_missing' } });
		expect(
			controlOf({ type: 'channel.refused', channel: 3, requestId: 'r1', error: { code: 'nope', hint: '' } })
		).toBeNull();
		// CONTRACTS §3.2's abbreviated form is read the same; it is never written.
		expect(
			controlOf({ type: 'channel.refused', channel: 3, requestId: 'r1', code: 'kill_switch', hint: 'clear it' })
		).toEqual({
			type: 'channel.refused',
			channel: 3,
			requestId: 'r1',
			error: { code: 'kill_switch', hint: 'clear it' }
		});
		expect(controlOf({ type: 'channel.refused', channel: 3, requestId: 'r1', code: 'nope' })).toBeNull();
		expect(controlOf({ type: 'channel.close', channel: 3, reason: 'resume_failed' })).toEqual({
			type: 'channel.close',
			channel: 3,
			reason: 'resume_failed'
		});
		expect(controlOf({ type: 'channel.close', channel: 3, reason: 'bored' })).toBeNull();
	});

	it('validates the operation messages', () => {
		expect(controlOf({ type: 'operation.progress', operationId: 'op-1', progress: { percent: 40 } })).toEqual({
			type: 'operation.progress',
			operationId: 'op-1',
			progress: { percent: 40 }
		});
		expect(controlOf({ type: 'operation.progress', operationId: 'op-1', progress: { percent: 140 } })).toBeNull();
		expect(controlOf({ type: 'operation.done', operationId: 'op-1', result: { ok: true } })).toEqual({
			type: 'operation.done',
			operationId: 'op-1',
			result: { ok: true }
		});
		expect(controlOf({ type: 'operation.done', operationId: 'op/../1', result: {} })).toBeNull();
		expect(controlOf({ type: 'operation.cancel', operationId: 'op-1' })).toEqual({
			type: 'operation.cancel',
			operationId: 'op-1'
		});
	});

	it('passes a family message through and tells it from a link message', () => {
		const event = controlOf({ type: 'session.event', sessionId: 's1', __proto__: { x: 1 } });
		expect(event).toEqual({ type: 'session.event', sessionId: 's1' });
		expect(isFleetLinkControlMessage(event!)).toBe(false);
		expect(isFleetLinkControlMessage(controlOf({ type: 'link.resume' })!)).toBe(true);
		// A type that is neither the link's nor family-shaped is refused.
		expect(controlOf({ type: 'DROP TABLE' })).toBeNull();
		expect(controlOf({ type: 'single' })).toBeNull();
	});

	it('encodes on channel 0', () => {
		const wire = encodeFleetLinkControl({ type: 'link.resume' })!;
		expect(decodeFleetLinkFrame(wire)).toMatchObject({ channel: 0, kind: FLEET_LINK_FRAME_KINDS.JSON });
	});
});

describe('requests, replies and errors', () => {
	it('reads a request and each reply shape', () => {
		expect(asFleetLinkRequest({ requestId: 'r1', type: 'health.now', params: { a: 1 } })).toEqual({
			requestId: 'r1',
			type: 'health.now',
			params: { a: 1 }
		});
		expect(asFleetLinkRequest({ requestId: 'r 1', type: 'health.now' })).toBeNull();
		expect(asFleetLinkRequest({ requestId: 'r1', type: 'health.now', params: [1] })).toBeNull();
		expect(asFleetLinkReply({ requestId: 'r1', result: null })).toEqual({ requestId: 'r1', result: null });
		expect(asFleetLinkReply({ requestId: 'r1', operationId: 'op-9' })).toEqual({
			requestId: 'r1',
			operationId: 'op-9'
		});
		expect(asFleetLinkReply({ requestId: 'r1', error: { code: 'busy', hint: 'Nina holds it' } })).toEqual({
			requestId: 'r1',
			error: { code: 'busy', hint: 'Nina holds it' }
		});
		expect(asFleetLinkReply({ requestId: 'r1' })).toBeNull();
		expect(asFleetLinkReply({ requestId: 'r1', error: { code: 'weird' } })).toBeNull();
	});

	it('cuts a hint to the bound and keeps plain-object details only', () => {
		const long = 'x'.repeat(FLEET_LINK_MAX_HINT_LENGTH + 50);
		expect(normalizeFleetLinkError({ code: 'invalid', hint: long, details: [1] })).toEqual({
			code: 'invalid',
			hint: 'x'.repeat(FLEET_LINK_MAX_HINT_LENGTH)
		});
		expect(makeFleetLinkError('busy', long, { holder: 'u1' }).hint).toHaveLength(FLEET_LINK_MAX_HINT_LENGTH);
	});
});

describe('small binary payloads', () => {
	it('round-trips RESIZE, EXIT, ACK and CLOSE', () => {
		expect(decodeFleetLinkResize(encodeFleetLinkResize(120, 40)!)).toEqual({ cols: 120, rows: 40 });
		expect(encodeFleetLinkResize(0, 40)).toBeNull();
		expect(decodeFleetLinkResize(new Uint8Array(3))).toBeNull();
		for (const code of [0, 1, -1, 2_147_483_647, -2_147_483_648]) {
			expect(decodeFleetLinkExit(encodeFleetLinkExit(code)!)).toBe(code);
		}
		expect(encodeFleetLinkExit(2 ** 31)).toBeNull();
		expect(decodeFleetLinkAck(encodeFleetLinkAck(65_536)!)).toBe(65_536);
		expect(decodeFleetLinkCloseReason(encodeFleetLinkCloseReason('resume_failed'))).toBe('resume_failed');
		expect(decodeFleetLinkCloseReason(text('whatever'))).toBeNull();
	});
});
