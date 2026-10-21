import { describe, expect, it } from 'vitest';
import {
	FLEET_TOOL_CATALOGUE,
	FLEET_TOOL_LEGACY_NAMES,
	fleetToolEntry,
	fleetToolMcpAnnotations,
	isFleetToolForbiddenPath
} from '@ever-works/contracts';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * FL-19 T-11 (spec ACC-FL19-12) — the MCP fleet surface agrees with the fleet
 * tool catalogue: every fleet entry is a catalogue tool or one of the eight
 * legacy names, carries the catalogue's annotation, and no enrolment,
 * heartbeat, lease, attach-token or credential route is ever a tool.
 */

const fleetEntries = WHITELIST.filter((entry) => entry.path.startsWith('/api/fleet'));
const shape = (path: string) => path.replace(/\{[^}]+\}/g, '{}');

/** Live catalogue rows deliberately NOT on the MCP surface, with the reason. */
const WITHHELD: Record<string, string> = {
	// Covered by the legacy entries at the same route (spec FR-3 keeps those names).
	fleet_nodes_list: 'legacy list_fleet_nodes (GET /api/fleet/nodes)',
	fleet_nodes_get: 'legacy get_fleet_node (GET /api/fleet/nodes/{id})',
	// Its answer carries a one-time address into the person's tunnel (FL-10 spec U15).
	fleet_ports_preview_open: 'one-time tunnel address',
	// A question is read off the session itself (fleet_sessions_read) until FL-05 lands.
	fleet_sessions_question: 'same route as fleet_sessions_read'
};

/** FL-19 P1 exposes reads; the acts of every family arrive in P2 (they may already exist). */
const liveReadRows = FLEET_TOOL_CATALOGUE.filter((entry) => entry.status === 'live' && entry.readOnly && entry.route);

describe('MCP whitelist ↔ fleet tool catalogue (FL-19)', () => {
	it('names every fleet entry after a catalogue tool or a legacy name', () => {
		const legacy = new Set<string>(FLEET_TOOL_LEGACY_NAMES);
		const stray = fleetEntries
			.map((entry) => entry.toolName ?? '(unnamed)')
			.filter((name) => !legacy.has(name) && !fleetToolEntry(name));
		expect(stray).toEqual([]);
	});

	it('exposes every live catalogue read with a route, unless withheld with a reason', () => {
		const exposed = new Set(fleetEntries.map((entry) => entry.toolName));
		const missing = liveReadRows
			.filter((entry) => !(entry.name in WITHHELD))
			.filter((entry) => !exposed.has(entry.name))
			.map((entry) => entry.name);
		expect(missing).toEqual([]);
	});

	it('puts each catalogue tool on its own route and method', () => {
		for (const entry of fleetEntries) {
			const row = entry.toolName ? fleetToolEntry(entry.toolName) : undefined;
			if (!row?.route) continue;
			expect(entry.method, entry.toolName).toBe(row.route.method);
			expect(shape(entry.path), entry.toolName).toBe(shape(row.route.path));
		}
	});

	it('annotates catalogue tools as the catalogue does', () => {
		for (const entry of fleetEntries) {
			const row = entry.toolName ? fleetToolEntry(entry.toolName) : undefined;
			if (!row) continue;
			const expected = fleetToolMcpAnnotations(row);
			if (expected.readOnlyHint) expect(entry.annotations?.readOnlyHint, entry.toolName).toBe(true);
			else if (entry.annotations?.destructiveHint !== undefined) {
				// An act may be stricter on MCP than in the catalogue (e.g. marked destructive), never laxer.
				if (expected.destructiveHint) expect(entry.annotations.destructiveHint, entry.toolName).toBe(true);
			}
		}
	});

	it('never exposes enrolment, heartbeat, lease, attach-token or credential routes', () => {
		expect(fleetEntries.filter((entry) => isFleetToolForbiddenPath(entry.path)).map((entry) => entry.path)).toEqual([]);
	});

	it('keeps the eight legacy fleet entries', () => {
		const names = new Set(fleetEntries.map((entry) => entry.toolName));
		for (const legacy of FLEET_TOOL_LEGACY_NAMES) expect(names.has(legacy), legacy).toBe(true);
	});
});
