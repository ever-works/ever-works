import { describe, expect, it } from 'vitest';

import {
	decodeComputerFrame,
	decodedComputerBase64Bytes,
	encodeComputerFrame,
	isComputerClientToServerFrame,
	isComputerFrameBatchWithinCaps,
	isComputerFrameWithinSizeCap,
	isComputerInputFrame,
	isComputerNodeToServerFrame,
	isComputerServerToClientFrame,
	makeComputerErrorFrame,
	normalizeComputerFrame
} from '../computer-frame.codec.js';
import {
	COMPUTER_CLIENT_TO_SERVER_KINDS,
	COMPUTER_MAX_BATCH_FRAMES,
	COMPUTER_MAX_ERROR_MESSAGE_LENGTH,
	COMPUTER_MAX_FRAME_BYTES,
	COMPUTER_MAX_WIRE_FRAME_BYTES,
	COMPUTER_NODE_TO_SERVER_KINDS,
	COMPUTER_SERVER_TO_CLIENT_KINDS,
	type ComputerFrame
} from '../computer-frame.types.js';

const PICTURE = { kind: 'frame', seq: 3, keyframe: true, width: 1280, height: 720, mime: 'image/jpeg', data: 'aGk=' };

/** One valid instance of every kind, so the matrix below cannot skip one. */
const VALID: Record<ComputerFrame['kind'], ComputerFrame> = {
	frame: PICTURE as ComputerFrame,
	terminal: { kind: 'terminal', frame: { kind: 'stdout', seq: 0, data: 'aGk=' } },
	stats: {
		kind: 'stats',
		nodeLocalTime: '2026-09-13T09:41:07.120+02:00',
		quality: 'sharp',
		effectiveQuality: 'steady',
		fps: 8,
		backlog: 0,
		bytesOut: 1024
	},
	mode: { kind: 'mode', mode: 'watching' },
	error: { kind: 'error', message: 'starting…' },
	end: { kind: 'end', reason: 'closed-by-user' },
	auth: { kind: 'auth', token: 'abc.def' },
	pointer: { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' },
	key: { kind: 'key', action: 'down', key: 'Enter', code: 'Enter', modifiers: 2 },
	text: { kind: 'text', text: 'hello' },
	scroll: { kind: 'scroll', x: 1, y: 1, dx: 0, dy: -120 },
	quality: { kind: 'quality', quality: 'smooth' },
	refresh: { kind: 'refresh' },
	control: { kind: 'control', action: 'request' }
};

describe('computer frame codec — round trip', () => {
	it.each(Object.entries(VALID))('round-trips %s', (_kind, frame) => {
		const wire = encodeComputerFrame(frame);
		expect(wire).not.toBeNull();
		expect(decodeComputerFrame(wire as string)).toEqual(frame);
		expect(decodeComputerFrame(new TextEncoder().encode(wire as string))).toEqual(frame);
	});
});

describe('computer frame codec — pointer pressed buttons', () => {
	it('carries the pressed-buttons bitmask of a drag, and 0 after the release', () => {
		const drag = { kind: 'pointer', action: 'move', x: 40, y: 50, button: null, buttons: 1 } as const;
		const release = { kind: 'pointer', action: 'up', x: 41, y: 50, button: 'left', buttons: 0 } as const;
		for (const frame of [drag, release]) {
			expect(decodeComputerFrame(encodeComputerFrame(frame) as string)).toEqual(frame);
		}
	});

	it('leaves a pointer without pressed buttons exactly as it was', () => {
		const decoded = decodeComputerFrame(JSON.stringify(VALID.pointer));
		expect(decoded).toEqual(VALID.pointer);
		expect(decoded && Object.prototype.hasOwnProperty.call(decoded, 'buttons')).toBe(false);
	});
});

describe('computer frame codec — refusals (null, never throw)', () => {
	it.each([
		['invalid JSON', '{not json'],
		['an array', '[]'],
		['an unknown kind', JSON.stringify({ kind: 'mouse' })],
		['a negative seq', JSON.stringify({ ...PICTURE, seq: -1 })],
		['a zero width', JSON.stringify({ ...PICTURE, width: 0 })],
		['an unsupported mime', JSON.stringify({ ...PICTURE, mime: 'image/gif' })],
		['non-canonical base64', JSON.stringify({ ...PICTURE, data: 'aGk' })],
		['empty picture data', JSON.stringify({ ...PICTURE, data: '' })],
		['a string keyframe', JSON.stringify({ ...PICTURE, keyframe: 'yes' })],
		['a node clock without an offset', JSON.stringify({ ...VALID.stats, nodeLocalTime: '2026-09-13T09:41:07' })],
		['an unknown close reason', JSON.stringify({ kind: 'end', reason: 'bored' })],
		['a token with whitespace', JSON.stringify({ kind: 'auth', token: 'a b' })],
		['a pointer off the picture', JSON.stringify({ ...VALID.pointer, x: 99_999 })],
		['pressed buttons outside the bitmask', JSON.stringify({ ...VALID.pointer, buttons: 32 })],
		['negative pressed buttons', JSON.stringify({ ...VALID.pointer, buttons: -1 })],
		['fractional pressed buttons', JSON.stringify({ ...VALID.pointer, buttons: 1.5 })],
		['pressed buttons as a string', JSON.stringify({ ...VALID.pointer, buttons: '1' })],
		['modifiers outside the bitmask', JSON.stringify({ ...VALID.key, modifiers: 16 })],
		['a control character in a key name', JSON.stringify({ ...VALID.key, key: String.fromCharCode(97, 0) })],
		['empty text', JSON.stringify({ kind: 'text', text: '' })],
		[
			'a wrapped terminal frame that is itself invalid',
			JSON.stringify({ kind: 'terminal', frame: { kind: 'stdout' } })
		]
	])('refuses %s', (_label, raw) => {
		expect(decodeComputerFrame(raw)).toBeNull();
	});

	it('refuses an oversize wire frame BEFORE parsing it', () => {
		const huge = 'x'.repeat(COMPUTER_MAX_WIRE_FRAME_BYTES + 1);
		expect(isComputerFrameWithinSizeCap(huge)).toBe(false);
		expect(decodeComputerFrame(huge)).toBeNull();
	});

	it('refuses a picture whose DECODED size is over the per-frame cap', () => {
		const bytes = COMPUTER_MAX_FRAME_BYTES + 1; // a multiple of 3, so no padding
		const data = 'A'.repeat((bytes / 3) * 4);
		expect(decodedComputerBase64Bytes(data)).toBe(bytes);
		expect(normalizeComputerFrame({ ...PICTURE, data })).toBeNull();
	});

	it('drops unknown keys, including __proto__, when it rebuilds a frame', () => {
		const decoded = decodeComputerFrame('{"kind":"refresh","__proto__":{"polluted":true},"extra":1}');
		expect(decoded).toEqual({ kind: 'refresh' });
		expect(Object.keys(decoded as object)).toEqual(['kind']);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('never throws on a hostile object graph', () => {
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error('boom');
				},
				has() {
					throw new Error('boom');
				}
			}
		);
		expect(normalizeComputerFrame(hostile)).toBeNull();
		expect(normalizeComputerFrame(null)).toBeNull();
	});
});

describe('direction maps', () => {
	it('never lets a picture travel inbound from a browser', () => {
		expect(isComputerClientToServerFrame(VALID.frame)).toBe(false);
		expect(isComputerClientToServerFrame(VALID.end)).toBe(false);
	});

	it('never fans a pointer (or any input) out to viewers', () => {
		expect(isComputerServerToClientFrame(VALID.pointer)).toBe(false);
		expect(isComputerServerToClientFrame(VALID.auth)).toBe(false);
		expect(isComputerNodeToServerFrame(VALID.pointer)).toBe(false);
	});

	it('keeps every kind in at least one direction, and input only inbound', () => {
		for (const kind of Object.keys(VALID)) {
			const inSome =
				(COMPUTER_CLIENT_TO_SERVER_KINDS as readonly string[]).includes(kind) ||
				(COMPUTER_SERVER_TO_CLIENT_KINDS as readonly string[]).includes(kind);
			expect(inSome).toBe(true);
		}
		for (const kind of COMPUTER_NODE_TO_SERVER_KINDS) {
			expect((COMPUTER_SERVER_TO_CLIENT_KINDS as readonly string[]).includes(kind)).toBe(true);
		}
		expect(isComputerInputFrame(VALID.text)).toBe(true);
		expect(isComputerInputFrame(VALID.refresh)).toBe(false);
	});
});

describe('publish batch caps', () => {
	it('accepts up to the picture cap and refuses one more', () => {
		const pictures = Array.from({ length: COMPUTER_MAX_BATCH_FRAMES }, (_, i) => ({ ...PICTURE, seq: i }));
		expect(isComputerFrameBatchWithinCaps(pictures)).toBe(true);
		expect(isComputerFrameBatchWithinCaps([...pictures, { ...PICTURE, seq: 99 }])).toBe(false);
	});

	it('refuses a batch whose pictures add up past the byte cap', () => {
		const half = 'A'.repeat(((COMPUTER_MAX_FRAME_BYTES / 2 + 2) / 3) * 4);
		expect(
			isComputerFrameBatchWithinCaps([
				{ ...PICTURE, data: half },
				{ ...PICTURE, data: half }
			])
		).toBe(false);
	});

	it('does not count stats or banners against the picture cap', () => {
		const chatter = Array.from({ length: 20 }, () => VALID.stats);
		expect(isComputerFrameBatchWithinCaps(chatter)).toBe(true);
	});
});

describe('makeComputerErrorFrame', () => {
	it('truncates instead of refusing', () => {
		const frame = makeComputerErrorFrame('x'.repeat(COMPUTER_MAX_ERROR_MESSAGE_LENGTH + 50));
		expect(frame.kind).toBe('error');
		expect((frame as { message: string }).message.length).toBe(COMPUTER_MAX_ERROR_MESSAGE_LENGTH);
		expect(encodeComputerFrame(frame)).not.toBeNull();
	});
});
