import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
	encodeFleetLinkControl,
	encodeFleetLinkFrame,
	encodeFleetLinkJson
} from '../fleet-link.codec.js';
import {
	FLEET_LINK_BACKOFF_BASE_MS,
	FLEET_LINK_BACKOFF_MAX_MS,
	FLEET_LINK_CLOSE_CODES,
	FLEET_LINK_DEFAULT_LIMITS,
	FLEET_LINK_TOKEN_TTL_SEC,
	FLEET_LINK_VERSION,
	FLEET_LINK_WS_PATH,
	type FleetLinkFrameKind
} from '../fleet-link.types.js';

/**
 * The wire fixture is the link's truth (spec ACC-FL02-03): it was produced
 * by an encoder written independently of this codec, so a codec change that
 * moves a byte fails here before it reaches a machine nobody is watching.
 */
interface FixtureFrame {
	name: string;
	channel: number;
	kind: number;
	hex: string;
	payloadHex?: string;
	resize?: { cols: number; rows: number };
	exitCode?: number;
	ack?: number;
	closeReason?: string;
}

interface Fixture {
	linkVersion: number;
	limits: Record<string, number>;
	linkToken: { response: { wsPath: string; expiresInSec: number } };
	closeCodes: Record<string, number>;
	control: Record<string, Record<string, unknown>>;
	request: Record<string, unknown>;
	replies: Record<string, Record<string, unknown>>;
	frames: FixtureFrame[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
	readFileSync(resolve(here, '../../../fixtures/fleet-link-contract.v1.json'), 'utf8')
) as Fixture;

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('fleet-link-contract.v1.json', () => {
	it('agrees with the constants', () => {
		expect(fixture.linkVersion).toBe(FLEET_LINK_VERSION);
		expect(fixture.limits).toMatchObject({ ...FLEET_LINK_DEFAULT_LIMITS });
		expect(fixture.limits.backoffBaseMs).toBe(FLEET_LINK_BACKOFF_BASE_MS);
		expect(fixture.limits.backoffMaxMs).toBe(FLEET_LINK_BACKOFF_MAX_MS);
		expect(fixture.limits.tokenTtlSec).toBe(FLEET_LINK_TOKEN_TTL_SEC);
		expect(fixture.linkToken.response.wsPath).toBe(FLEET_LINK_WS_PATH);
		expect(fixture.linkToken.response.expiresInSec).toBe(FLEET_LINK_TOKEN_TTL_SEC);
		expect(fixture.closeCodes).toEqual({ ...FLEET_LINK_CLOSE_CODES });
	});

	it('decodes every control message to exactly the typed shape and re-encodes it byte for byte', () => {
		for (const [name, message] of Object.entries(fixture.control)) {
			const entry = fixture.frames.find((frame) => frame.name === `control.${name}`);
			expect(entry, name).toBeDefined();
			const frame = decodeFleetLinkFrame(fromHex(entry!.hex));
			expect(frame, name).toMatchObject({ channel: 0, kind: 10 });
			expect(decodeFleetLinkControl(frame!.payload), name).toEqual(message);
			expect(toHex(encodeFleetLinkControl(message as never)!), name).toBe(entry!.hex);
		}
	});

	it('decodes the request and every reply shape', () => {
		const request = fixture.frames.find((frame) => frame.name === 'request.health-now')!;
		const decodedRequest = decodeFleetLinkJson(decodeFleetLinkFrame(fromHex(request.hex))!.payload)!;
		expect(asFleetLinkRequest(decodedRequest)).toEqual(fixture.request);
		expect(toHex(encodeFleetLinkJson(request.channel, fixture.request)!)).toBe(request.hex);
		for (const [name, reply] of Object.entries(fixture.replies)) {
			const entry = fixture.frames.find((frame) => frame.name === `reply.${name}`)!;
			const decoded = decodeFleetLinkJson(decodeFleetLinkFrame(fromHex(entry.hex))!.payload)!;
			expect(asFleetLinkReply(decoded), name).toEqual(reply);
		}
	});

	it('carries one frame per kind and the codec reproduces each', () => {
		const kinds = new Set<number>();
		for (const entry of fixture.frames.filter((frame) => frame.name.startsWith('kind.'))) {
			const frame = decodeFleetLinkFrame(fromHex(entry.hex));
			expect(frame, entry.name).toMatchObject({ channel: entry.channel, kind: entry.kind });
			kinds.add(entry.kind);
			if (entry.payloadHex !== undefined) expect(toHex(frame!.payload), entry.name).toBe(entry.payloadHex);
			if (entry.resize) expect(decodeFleetLinkResize(frame!.payload)).toEqual(entry.resize);
			if (entry.exitCode !== undefined) expect(decodeFleetLinkExit(frame!.payload)).toBe(entry.exitCode);
			if (entry.ack !== undefined) expect(decodeFleetLinkAck(frame!.payload)).toBe(entry.ack);
			if (entry.closeReason !== undefined)
				expect(decodeFleetLinkCloseReason(frame!.payload)).toBe(entry.closeReason);
			expect(toHex(encodeFleetLinkFrame(entry.channel, entry.kind as FleetLinkFrameKind, frame!.payload)!)).toBe(
				entry.hex
			);
		}
		expect([...kinds].sort((a, b) => a - b)).toEqual([1, 2, 3, 11, 20, 21, 23, 30, 31, 40]);
	});
});
