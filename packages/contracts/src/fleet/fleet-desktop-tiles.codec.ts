/**
 * Fleet — the `TILES` (23) payload of a desktop channel (FL-07, CONTRACTS
 * §3.2, plan §3): the changed 64 × 64 regions of the picture since the last
 * publish, each JPEG-encoded on its own.
 *
 *     [width u16][height u16][count u16]
 *     count × { [x u16][y u16][w u16][h u16][len u32][len bytes of JPEG] }
 *
 * Big-endian. `width × height` is the size of the picture the tiles belong to
 * (the last keyframe's); a viewer whose canvas has another size ignores them
 * and asks for a refresh. Hand-rolled (this package is zero-dependency) and,
 * like the link codec, it never throws on malformed input: every decoder
 * answers `null`, and the size cap is checked on the raw length BEFORE a byte
 * of payload is read.
 */

import { FLEET_DESKTOP_MAX_DIMENSION, FLEET_DESKTOP_TILE_SIZE } from './fleet-desktop.types.js';
import { FLEET_LINK_MAX_PAYLOAD_BYTES } from './fleet-link.types.js';

/** One changed region; `data` is a whole JPEG (SOI … EOI). */
export interface FleetDesktopTile {
	x: number;
	y: number;
	w: number;
	h: number;
	data: Uint8Array;
}

/** One decoded `TILES` payload. Each tile's `data` is a view into the received bytes. */
export interface FleetDesktopTiles {
	width: number;
	height: number;
	tiles: FleetDesktopTile[];
}

/** Bytes before the first tile. */
export const FLEET_DESKTOP_TILES_HEADER_BYTES = 6;
/** Bytes before each tile's JPEG. */
export const FLEET_DESKTOP_TILE_HEADER_BYTES = 12;
/** Most tiles one payload may name (a whole 8192 × 8192 picture in 64-pixel tiles is 16 384). */
export const FLEET_DESKTOP_MAX_TILES = 16_384;

function validPicture(width: number, height: number): boolean {
	return (
		Number.isInteger(width) &&
		Number.isInteger(height) &&
		width >= 1 &&
		height >= 1 &&
		width <= FLEET_DESKTOP_MAX_DIMENSION &&
		height <= FLEET_DESKTOP_MAX_DIMENSION
	);
}

function validTile(tile: { x: number; y: number; w: number; h: number }, width: number, height: number): boolean {
	return (
		Number.isInteger(tile.x) &&
		Number.isInteger(tile.y) &&
		Number.isInteger(tile.w) &&
		Number.isInteger(tile.h) &&
		tile.x >= 0 &&
		tile.y >= 0 &&
		tile.w >= 1 &&
		tile.h >= 1 &&
		tile.w <= FLEET_DESKTOP_TILE_SIZE &&
		tile.h <= FLEET_DESKTOP_TILE_SIZE &&
		tile.x + tile.w <= width &&
		tile.y + tile.h <= height
	);
}

/** A JPEG starts with SOI (`FF D8`). Anything else is not a tile. */
function looksLikeJpeg(bytes: Uint8Array, offset: number, length: number): boolean {
	return length >= 4 && bytes[offset] === 0xff && bytes[offset + 1] === 0xd8;
}

/**
 * Encode tiles for a `TILES` frame; null when a tile lies outside the picture,
 * is not a JPEG, or the whole would pass `maxBytes`.
 */
export function encodeDesktopTiles(
	input: FleetDesktopTiles,
	maxBytes: number = FLEET_LINK_MAX_PAYLOAD_BYTES
): Uint8Array | null {
	if (!input || !validPicture(input.width, input.height) || !Array.isArray(input.tiles)) return null;
	if (input.tiles.length === 0 || input.tiles.length > FLEET_DESKTOP_MAX_TILES) return null;
	let total = FLEET_DESKTOP_TILES_HEADER_BYTES;
	for (const tile of input.tiles) {
		if (!tile || !(tile.data instanceof Uint8Array) || !validTile(tile, input.width, input.height)) return null;
		if (!looksLikeJpeg(tile.data, 0, tile.data.byteLength)) return null;
		total += FLEET_DESKTOP_TILE_HEADER_BYTES + tile.data.byteLength;
		if (total > maxBytes) return null;
	}
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, input.width);
	view.setUint16(2, input.height);
	view.setUint16(4, input.tiles.length);
	let offset = FLEET_DESKTOP_TILES_HEADER_BYTES;
	for (const tile of input.tiles) {
		view.setUint16(offset, tile.x);
		view.setUint16(offset + 2, tile.y);
		view.setUint16(offset + 4, tile.w);
		view.setUint16(offset + 6, tile.h);
		view.setUint32(offset + 8, tile.data.byteLength);
		out.set(tile.data, offset + FLEET_DESKTOP_TILE_HEADER_BYTES);
		offset += FLEET_DESKTOP_TILE_HEADER_BYTES + tile.data.byteLength;
	}
	return out;
}

/**
 * Decode a `TILES` payload, or null: over the cap (checked first), a header
 * that does not add up, a tile outside the picture or larger than a tile, a
 * tile that is not a JPEG, a truncated tile, or bytes left over at the end.
 */
export function decodeDesktopTiles(
	payload: Uint8Array,
	maxBytes: number = FLEET_LINK_MAX_PAYLOAD_BYTES
): FleetDesktopTiles | null {
	if (!(payload instanceof Uint8Array)) return null;
	if (payload.byteLength > maxBytes) return null;
	if (payload.byteLength < FLEET_DESKTOP_TILES_HEADER_BYTES) return null;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const width = view.getUint16(0);
	const height = view.getUint16(2);
	const count = view.getUint16(4);
	if (!validPicture(width, height) || count === 0 || count > FLEET_DESKTOP_MAX_TILES) return null;
	// Every tile needs at least its header: a count the length cannot hold is refused before the loop.
	if (FLEET_DESKTOP_TILES_HEADER_BYTES + count * FLEET_DESKTOP_TILE_HEADER_BYTES > payload.byteLength) return null;
	const tiles: FleetDesktopTile[] = [];
	let offset = FLEET_DESKTOP_TILES_HEADER_BYTES;
	for (let index = 0; index < count; index++) {
		if (offset + FLEET_DESKTOP_TILE_HEADER_BYTES > payload.byteLength) return null;
		const tile = {
			x: view.getUint16(offset),
			y: view.getUint16(offset + 2),
			w: view.getUint16(offset + 4),
			h: view.getUint16(offset + 6)
		};
		const length = view.getUint32(offset + 8);
		const start = offset + FLEET_DESKTOP_TILE_HEADER_BYTES;
		if (!validTile(tile, width, height)) return null;
		if (length === 0 || start + length > payload.byteLength) return null;
		if (!looksLikeJpeg(payload, start, length)) return null;
		tiles.push({ ...tile, data: payload.subarray(start, start + length) });
		offset = start + length;
	}
	if (offset !== payload.byteLength) return null;
	return { width, height, tiles };
}
