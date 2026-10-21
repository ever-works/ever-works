import { describe, expect, it } from 'vitest';
import {
	FLEET_LINK_VIEWER_CHANNEL,
	FLEET_LINK_VIEWER_CLOSE_CODES,
	FLEET_LINK_VIEWER_CONTROL_TYPES,
	FLEET_LINK_VIEWER_FRAME_KINDS,
	FLEET_LINK_VIEWER_JSON_TYPES,
	FLEET_LINK_VIEWER_MAX_BUFFER_BYTES,
	FLEET_LINK_VIEWER_MAX_PARAMS_BYTES,
	FLEET_LINK_VIEWER_ROLES,
	FLEET_LINK_VIEWER_SLOW_BUFFER_BYTES,
	FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT,
	FLEET_LINK_VIEWER_TOKEN_TTL_SEC,
	fleetLinkViewerKey,
	fleetLinkViewerMaySend,
	fleetLinkViewerPath,
	isFleetLinkViewerRole,
	isFleetLinkViewerTarget,
	parseFleetLinkViewerPath
} from '../fleet-link-viewer.types.js';
import {
	FLEET_LINK_CLOSE_CODES,
	FLEET_LINK_FAMILIES,
	FLEET_LINK_FRAME_KINDS,
	FLEET_LINK_WS_PATH
} from '../fleet-link.types.js';
import { decodeFleetLinkControl, encodeFleetLinkControl } from '../fleet-link.codec.js';

/**
 * Viewers on a node-link channel (FL-02, spec FR-32, FR-33): the path, the
 * roles, what a read-only viewer may send, and the numbers the gateway uses.
 */

describe('viewer paths', () => {
	it('builds and parses /ws/fleet/<family>/<target> for every family', () => {
		for (const family of FLEET_LINK_FAMILIES) {
			const path = fleetLinkViewerPath(family, 'abc-123');
			expect(path).toBe(`/ws/fleet/${family}/abc-123`);
			expect(parseFleetLinkViewerPath(path)).toEqual({ family, target: 'abc-123' });
		}
	});

	it('is never the link’s own path, and refuses anything else', () => {
		expect(parseFleetLinkViewerPath(FLEET_LINK_WS_PATH)).toBeNull();
		for (const bad of [
			'/ws/fleet/session',
			'/ws/fleet/session/',
			'/ws/fleet/nowhere/abc',
			'/ws/fleet/session/a/b',
			'/ws/fleet/session/../x',
			'/ws/fleet/session/has space',
			'/ws/fleet/session/' + 'x'.repeat(129),
			'/ws/terminal/abc',
			42,
			null
		]) {
			expect(parseFleetLinkViewerPath(bad)).toBeNull();
		}
		expect(fleetLinkViewerPath('session', '')).toBeNull();
		expect(fleetLinkViewerPath('nope' as never, 'x')).toBeNull();
		expect(isFleetLinkViewerTarget('7d1f0c2a-3b4e-4f5a-8c6d-9e0f1a2b3c4d')).toBe(true);
		expect(isFleetLinkViewerTarget('node:7d1f.view_2')).toBe(true);
	});

	it('binds a token to one family and one target', () => {
		expect(fleetLinkViewerKey('logs', 'n-1')).toBe('logs:n-1');
		expect(fleetLinkViewerKey('logs', 'n-1')).not.toBe(fleetLinkViewerKey('session', 'n-1'));
	});
});

describe('roles', () => {
	it('names exactly viewer and driver', () => {
		expect([...FLEET_LINK_VIEWER_ROLES]).toEqual(['viewer', 'driver']);
		expect(isFleetLinkViewerRole('viewer')).toBe(true);
		expect(isFleetLinkViewerRole('driver')).toBe(true);
		expect(isFleetLinkViewerRole('worker')).toBe(false);
		expect(isFleetLinkViewerRole('owner')).toBe(false);
	});

	it('lets a read-only viewer send only view controls and credit', () => {
		expect(Object.keys(FLEET_LINK_VIEWER_JSON_TYPES).sort()).toEqual([...FLEET_LINK_FAMILIES].sort());
		expect(fleetLinkViewerMaySend('logs', 'logs.follow')).toBe(true);
		expect(fleetLinkViewerMaySend('desktop', 'desktop.quality')).toBe(true);
		// Input, state changes and requests on another family are never a viewer's.
		expect(fleetLinkViewerMaySend('session', 'session.input')).toBe(false);
		expect(fleetLinkViewerMaySend('desktop', 'desktop.openUrl')).toBe(false);
		expect(fleetLinkViewerMaySend('files', 'files.delete')).toBe(false);
		expect(fleetLinkViewerMaySend('logs', 'desktop.quality')).toBe(false);
		expect(fleetLinkViewerMaySend('logs', 42)).toBe(false);
		expect(fleetLinkViewerMaySend('logs', 'constructor')).toBe(false);
		expect([...FLEET_LINK_VIEWER_FRAME_KINDS]).toEqual([FLEET_LINK_FRAME_KINDS.ACK]);
		for (const types of Object.values(FLEET_LINK_VIEWER_JSON_TYPES)) {
			for (const type of types) expect(type).not.toMatch(/input|delete|write|start|end|kill|signal/i);
		}
	});
});

describe('numbers', () => {
	it('fixes the token, the channel and the slow-viewer bounds', () => {
		expect(FLEET_LINK_VIEWER_TOKEN_TTL_SEC).toBe(60);
		expect(FLEET_LINK_VIEWER_TOKEN_RATE_LIMIT).toBe(30);
		expect(FLEET_LINK_VIEWER_CHANNEL).toBe(1);
		expect(FLEET_LINK_VIEWER_SLOW_BUFFER_BYTES).toBeLessThan(FLEET_LINK_VIEWER_MAX_BUFFER_BYTES);
		// A token carries its params; the signer refuses tokens over 2 KiB.
		expect(FLEET_LINK_VIEWER_MAX_PARAMS_BYTES).toBeLessThanOrEqual(1024);
	});

	it('keeps the viewer close codes distinct and shares the link’s where they mean the same', () => {
		const codes = Object.values(FLEET_LINK_VIEWER_CLOSE_CODES);
		expect(new Set(codes).size).toBe(codes.length);
		expect(FLEET_LINK_VIEWER_CLOSE_CODES.auth).toBe(FLEET_LINK_CLOSE_CODES.auth);
		expect(FLEET_LINK_VIEWER_CLOSE_CODES.disabled).toBe(FLEET_LINK_CLOSE_CODES.disabled);
		expect(FLEET_LINK_VIEWER_CLOSE_CODES.protocol).toBe(FLEET_LINK_CLOSE_CODES.protocol);
		// The viewer-only codes are not taken by the link.
		const linkCodes = new Set<number>(Object.values(FLEET_LINK_CLOSE_CODES));
		expect(linkCodes.has(FLEET_LINK_VIEWER_CLOSE_CODES.slowReader)).toBe(false);
		expect(linkCodes.has(FLEET_LINK_VIEWER_CLOSE_CODES.channelClosed)).toBe(false);
	});

	it('carries the viewer control messages on channel 0 as ordinary extension messages', () => {
		for (const type of FLEET_LINK_VIEWER_CONTROL_TYPES) {
			const frame = encodeFleetLinkControl({ type, linkGeneration: 3 } as never);
			expect(frame).not.toBeNull();
			expect(decodeFleetLinkControl(frame!.subarray(9))).toMatchObject({ type });
		}
	});
});
