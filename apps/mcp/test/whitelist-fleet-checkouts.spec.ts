import { describe, expect, it } from 'vitest';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * Checkouts on computers (FL-14 P2, CONTRACTS §11.3) — the MCP surface uses
 * the Agent tools' names, and the node-facing credential route never becomes
 * a tool.
 */
const ENTRIES = [
	{ method: 'GET', path: '/api/fleet/checkouts', toolName: 'fleet_checkouts_list' },
	{ method: 'GET', path: '/api/fleet/checkouts/{id}', toolName: 'fleet_checkouts_get' },
	{ method: 'POST', path: '/api/fleet/checkouts', toolName: 'fleet_checkouts_create' },
	{ method: 'POST', path: '/api/fleet/checkouts/{id}/sync', toolName: 'fleet_checkouts_sync' },
	{ method: 'POST', path: '/api/fleet/checkouts/{id}/archive', toolName: 'fleet_checkouts_archive' },
	{ method: 'DELETE', path: '/api/fleet/checkouts/{id}', toolName: 'fleet_checkouts_delete' }
];

describe('WHITELIST — checkouts on computers (FL-14)', () => {
	it('exposes the six checkout routes under their CONTRACTS names', () => {
		for (const entry of ENTRIES) {
			const found = WHITELIST.find((w) => w.method === entry.method && w.path === entry.path);
			expect(found?.toolName).toBe(entry.toolName);
		}
	});

	it('marks reads read-only and delete destructive', () => {
		const byName = new Map(WHITELIST.map((w) => [w.toolName, w]));
		expect(byName.get('fleet_checkouts_list')?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get('fleet_checkouts_get')?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get('fleet_checkouts_delete')?.annotations?.destructiveHint).toBe(true);
	});

	it('never exposes the node-facing credential route', () => {
		expect(WHITELIST.some((w) => w.path.includes('/credential') && w.path.includes('checkouts'))).toBe(false);
	});
});
