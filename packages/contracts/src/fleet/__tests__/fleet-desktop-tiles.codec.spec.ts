import { describe, expect, it } from 'vitest';

import {
	FLEET_DESKTOP_TILES_HEADER_BYTES,
	FLEET_DESKTOP_TILE_HEADER_BYTES,
	decodeDesktopTiles,
	encodeDesktopTiles
} from '../fleet-desktop-tiles.codec';

/** A stand-in JPEG: SOI, a few bytes, EOI. The codec checks the SOI only. */
function jpeg(fill: number, length = 16): Uint8Array {
	const bytes = new Uint8Array(length).fill(fill);
	bytes[0] = 0xff;
	bytes[1] = 0xd8;
	bytes[length - 2] = 0xff;
	bytes[length - 1] = 0xd9;
	return bytes;
}

describe('desktop TILES codec', () => {
	it('round-trips tiles at their offsets', () => {
		const input = {
			width: 1280,
			height: 800,
			tiles: [
				{ x: 0, y: 0, w: 64, h: 64, data: jpeg(1) },
				{ x: 1216, y: 768, w: 64, h: 32, data: jpeg(2, 40) }
			]
		};
		const encoded = encodeDesktopTiles(input);
		expect(encoded).not.toBeNull();
		expect(encoded!.byteLength).toBe(
			FLEET_DESKTOP_TILES_HEADER_BYTES + 2 * FLEET_DESKTOP_TILE_HEADER_BYTES + 16 + 40
		);
		const decoded = decodeDesktopTiles(encoded!);
		expect(decoded).not.toBeNull();
		expect(decoded!.width).toBe(1280);
		expect(decoded!.height).toBe(800);
		expect(decoded!.tiles.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
			{ x: 0, y: 0, w: 64, h: 64 },
			{ x: 1216, y: 768, w: 64, h: 32 }
		]);
		expect(Array.from(decoded!.tiles[1].data)).toEqual(Array.from(jpeg(2, 40)));
	});

	it('refuses an over-cap payload before reading it', () => {
		const encoded = encodeDesktopTiles({
			width: 64,
			height: 64,
			tiles: [{ x: 0, y: 0, w: 64, h: 64, data: jpeg(3) }]
		});
		expect(decodeDesktopTiles(encoded!, encoded!.byteLength - 1)).toBeNull();
		expect(
			encodeDesktopTiles({ width: 64, height: 64, tiles: [{ x: 0, y: 0, w: 64, h: 64, data: jpeg(3, 100) }] }, 50)
		).toBeNull();
	});

	it('refuses a tile outside the picture or larger than a tile', () => {
		expect(
			encodeDesktopTiles({ width: 100, height: 100, tiles: [{ x: 64, y: 64, w: 64, h: 64, data: jpeg(1) }] })
		).toBeNull();
		expect(
			encodeDesktopTiles({ width: 256, height: 256, tiles: [{ x: 0, y: 0, w: 128, h: 64, data: jpeg(1) }] })
		).toBeNull();
		// Hand-built: a tile that runs past the right edge.
		const bytes = encodeDesktopTiles({
			width: 128,
			height: 64,
			tiles: [{ x: 64, y: 0, w: 64, h: 64, data: jpeg(1) }]
		})!;
		const forged = bytes.slice();
		new DataView(forged.buffer).setUint16(FLEET_DESKTOP_TILES_HEADER_BYTES, 65);
		expect(decodeDesktopTiles(forged)).toBeNull();
	});

	it('refuses a tile that is not a JPEG', () => {
		expect(
			encodeDesktopTiles({
				width: 64,
				height: 64,
				tiles: [{ x: 0, y: 0, w: 64, h: 64, data: new Uint8Array(16) }]
			})
		).toBeNull();
	});

	it('answers null for truncated, padded or nonsense payloads, never throws', () => {
		const encoded = encodeDesktopTiles({
			width: 64,
			height: 64,
			tiles: [{ x: 0, y: 0, w: 64, h: 64, data: jpeg(9) }]
		})!;
		expect(decodeDesktopTiles(encoded.subarray(0, encoded.byteLength - 1))).toBeNull();
		const padded = new Uint8Array(encoded.byteLength + 1);
		padded.set(encoded);
		expect(decodeDesktopTiles(padded)).toBeNull();
		expect(decodeDesktopTiles(new Uint8Array(3))).toBeNull();
		// A count the bytes cannot hold.
		const lying = encoded.slice();
		new DataView(lying.buffer).setUint16(4, 60_000);
		expect(decodeDesktopTiles(lying)).toBeNull();
		// Zero size picture.
		const zero = encoded.slice();
		new DataView(zero.buffer).setUint16(0, 0);
		expect(decodeDesktopTiles(zero)).toBeNull();
		expect(decodeDesktopTiles('nope' as unknown as Uint8Array)).toBeNull();
		for (let seed = 0; seed < 200; seed++) {
			const random = new Uint8Array(32 + (seed % 64));
			for (let i = 0; i < random.length; i++) random[i] = (seed * 31 + i * 17) & 0xff;
			expect(() => decodeDesktopTiles(random)).not.toThrow();
		}
	});

	it('refuses an empty tile list', () => {
		expect(encodeDesktopTiles({ width: 64, height: 64, tiles: [] })).toBeNull();
	});
});
