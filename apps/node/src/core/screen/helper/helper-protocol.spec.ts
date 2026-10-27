import { describe, expect, it } from 'vitest';
import { encodeDesktopTiles } from '@ever-works/contracts';
import {
	HELPER_MAX_MESSAGE_BYTES,
	HELPER_MESSAGES,
	HelperMessageDecoder,
	acceptHelperTiles,
	encodeHelperJson,
	encodeHelperMessage,
	helperStartMessage,
	parseHelperError,
	parseHelperFrame,
	parseHelperHello
} from './helper-protocol';
import { fakeJpeg } from './helper-test-kit';

/** Desktop view & control (FL-07, T-11) — the node's half of the helper wire. */

describe('helper message framing', () => {
	it('re-assembles messages split across chunks', () => {
		const decoder = new HelperMessageDecoder();
		const one = encodeHelperMessage(HELPER_MESSAGES.refresh);
		const two = encodeHelperJson(HELPER_MESSAGES.hello, { protocol: 1 });
		const joined = new Uint8Array([...one, ...two]);
		expect(decoder.push(joined.subarray(0, 3))).toEqual([]);
		const messages = [...decoder.push(joined.subarray(3, 9)), ...decoder.push(joined.subarray(9))];
		expect(messages.map((message) => message.kind)).toEqual([HELPER_MESSAGES.refresh, HELPER_MESSAGES.hello]);
		expect(messages[0].payload.byteLength).toBe(0);
	});

	it('marks the stream broken on an empty or oversized message and produces nothing after it', () => {
		const decoder = new HelperMessageDecoder();
		const huge = new Uint8Array(5);
		new DataView(huge.buffer).setUint32(0, HELPER_MAX_MESSAGE_BYTES + 1);
		expect(decoder.push(huge)).toEqual([]);
		expect(decoder.broken).toContain('-byte message');
		expect(decoder.push(encodeHelperMessage(HELPER_MESSAGES.refresh))).toEqual([]);
		const empty = new HelperMessageDecoder();
		empty.push(new Uint8Array([0, 0, 0, 0]));
		expect(empty.broken).toBe('an empty message');
	});

	it('encodes start with the display only when one is named', () => {
		const settings = { width: 960, quality: 55, maxFps: 15, keyframeMs: 5000 };
		const withDisplay = helperStartMessage('DP-1', settings);
		const primary = helperStartMessage(null, settings);
		expect(withDisplay[4]).toBe(HELPER_MESSAGES.start);
		expect(JSON.parse(new TextDecoder().decode(withDisplay.subarray(5)))).toEqual({ ...settings, display: 'DP-1' });
		expect(JSON.parse(new TextDecoder().decode(primary.subarray(5)))).toEqual(settings);
	});
});

describe('helper messages', () => {
	it('reads hello with known reasons and valid displays only', () => {
		const hello = parseHelperHello(
			new TextEncoder().encode(
				JSON.stringify({
					protocol: 1,
					version: '0.1.0',
					platform: 'linux',
					reasons: ['wayland-unsupported', 'rm -rf'],
					displays: [
						{ id: 'DP-1', width: 10, height: 10, primary: true },
						{ id: '', width: 1, height: 1 }
					]
				})
			)
		);
		expect(hello).toMatchObject({
			protocol: 1,
			version: '0.1.0',
			platform: 'linux',
			reasons: ['wayland-unsupported']
		});
		expect(hello?.displays.map((display) => display.id)).toEqual(['DP-1']);
		expect(parseHelperHello(new TextEncoder().encode('not json'))).toBeNull();
	});

	it('reads a keyframe and refuses one that is not a JPEG', () => {
		const jpeg = fakeJpeg();
		const payload = new Uint8Array(4 + jpeg.byteLength);
		new DataView(payload.buffer).setUint16(0, 1280);
		new DataView(payload.buffer).setUint16(2, 800);
		payload.set(jpeg, 4);
		expect(parseHelperFrame(payload)).toMatchObject({ width: 1280, height: 800 });
		payload[4] = 0;
		expect(parseHelperFrame(payload)).toBeNull();
		expect(parseHelperFrame(new Uint8Array(3))).toBeNull();
	});

	it('forwards only valid TILES payloads', () => {
		const tiles = encodeDesktopTiles({
			width: 64,
			height: 64,
			tiles: [{ x: 0, y: 0, w: 64, h: 64, data: fakeJpeg() }]
		})!;
		expect(acceptHelperTiles(tiles)).toBe(tiles);
		expect(acceptHelperTiles(tiles.subarray(0, tiles.byteLength - 2))).toBeNull();
	});

	it('bounds an error message to one line', () => {
		const error = parseHelperError(
			new TextEncoder().encode(JSON.stringify({ code: 'capture-failed', message: `a\nb${'x'.repeat(400)}` }))
		);
		expect(error?.code).toBe('capture-failed');
		expect(error?.message).not.toContain('\n');
		expect(error?.message.length).toBeLessThanOrEqual(300);
		expect(parseHelperError(new TextEncoder().encode(JSON.stringify({ code: 'Not A Code' })))).toBeNull();
	});
});
