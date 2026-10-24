import { describe, expect, it } from 'vitest';

import { ACTION_CATEGORIES } from '../../safety/action-category.types.js';
import { FLEET_ACTION_FAMILIES } from '../fleet-access.types.js';
import { FLEET_CONFIRMATION_CLASSES } from '../fleet-machine-actions.types.js';
import {
	FLEET_CLI_EXIT,
	FLEET_TOOL_CATALOGUE,
	FLEET_TOOL_FAMILIES,
	FLEET_TOOL_FLAGS,
	FLEET_TOOL_GATE_ORDER,
	FLEET_TOOL_LEGACY_NAMES,
	FLEET_TOOL_NAME_PATTERN,
	FLEET_TOOL_NO_CREDITS_SENTENCE,
	fleetCliExitFor,
	fleetToolAnnotation,
	fleetToolEntry,
	fleetToolEntryPointCategories,
	fleetToolMcpAnnotations,
	fleetToolsForFamily,
	isFleetHeldActionStale,
	isFleetToolError,
	isFleetToolForbiddenPath,
	withFleetToolNoCreditsSentence
} from '../fleet-tools.types.js';

/**
 * FL-19 T-01 — the catalogue is the one table three surfaces are built from,
 * so its shape is pinned here (spec ACC-FL19-01, ACC-FL19-16).
 */
describe('FLEET_TOOL_CATALOGUE', () => {
	it('names every tool fleet_<family>_<verb> with a known family', () => {
		for (const entry of FLEET_TOOL_CATALOGUE) {
			expect(entry.name, entry.name).toMatch(FLEET_TOOL_NAME_PATTERN);
			expect(FLEET_TOOL_FAMILIES).toContain(entry.family);
			expect(entry.name.startsWith(`fleet_${entry.family}`), entry.name).toBe(true);
			const expected = entry.verb ? `fleet_${entry.family}_${entry.verb}` : `fleet_${entry.family}`;
			expect(entry.name).toBe(expected);
		}
	});

	it('has unique names and never reuses a legacy name', () => {
		const names = FLEET_TOOL_CATALOGUE.map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		for (const legacy of FLEET_TOOL_LEGACY_NAMES) expect(names).not.toContain(legacy);
	});

	it('marks every read read-only with the read.internal category', () => {
		for (const entry of FLEET_TOOL_CATALOGUE.filter((row) => row.readOnly)) {
			expect(entry.category, entry.name).toBe('read.internal');
			expect(entry.destructive, entry.name).toBeUndefined();
			expect(entry.confirmationClass, entry.name).toBeUndefined();
		}
	});

	it('gives every non-read row destructive, a confirmation class and an AW-24 category', () => {
		for (const entry of FLEET_TOOL_CATALOGUE.filter((row) => !row.readOnly)) {
			expect(typeof entry.destructive, entry.name).toBe('boolean');
			expect(FLEET_CONFIRMATION_CLASSES, entry.name).toContain(entry.confirmationClass);
			expect(ACTION_CATEGORIES, entry.name).toContain(entry.category);
			expect(entry.category, entry.name).not.toBe('read.internal');
		}
	});

	it('names a CONTRACTS §2.1 permission family and a CONTRACTS §9 flag on every row', () => {
		for (const entry of FLEET_TOOL_CATALOGUE) {
			expect(FLEET_ACTION_FAMILIES, entry.name).toContain(entry.permissionFamily);
			expect(FLEET_TOOL_FLAGS, entry.name).toContain(entry.flag);
		}
	});

	it('puts a live route only under /api and never on a forbidden path', () => {
		for (const entry of FLEET_TOOL_CATALOGUE) {
			if (!entry.route) continue;
			expect(entry.route.path.startsWith('/api/fleet/'), entry.name).toBe(true);
			expect(isFleetToolForbiddenPath(entry.route.path), entry.name).toBe(false);
		}
	});

	it('maps the CONTRACTS §2.1 exceptions: port list → view, wake → machines, log reads → logs', () => {
		expect(fleetToolEntry('fleet_ports_list')?.permissionFamily).toBe('view');
		expect(fleetToolEntry('fleet_ports_open')?.permissionFamily).toBe('ports');
		expect(fleetToolEntry('fleet_nodes_wake')?.permissionFamily).toBe('machines');
		expect(fleetToolEntry('fleet_nodes_health')?.permissionFamily).toBe('view');
		expect(fleetToolEntry('fleet_logs_read')?.permissionFamily).toBe('logs');
		expect(fleetToolEntry('fleet_nodes_git_identity_set')?.permissionFamily).toBe('commands');
	});

	it('ships fleet_status, fleet_operations_get and fleet_usage_get (FR-4, FR-14, FR-25)', () => {
		expect(fleetToolEntry('fleet_status')?.status).toBe('live');
		expect(fleetToolEntry('fleet_operations_get')?.status).toBe('live');
		expect(fleetToolEntry('fleet_usage_get')).toBeDefined();
	});

	it('keeps sessions answering to questions only (R-32) and file delete always held (R-33)', () => {
		expect(fleetToolEntry('fleet_sessions_answer')?.confirmationNote).toMatch(/questions only/);
		expect(fleetToolEntry('fleet_files_delete')?.alwaysHeld).toBe(true);
		expect(fleetToolEntry('fleet_commands_run')?.alwaysHeld).toBe(true);
	});

	it('lists every tool family at least once', () => {
		for (const family of FLEET_TOOL_FAMILIES) {
			expect(fleetToolsForFamily(family).length, family).toBeGreaterThan(0);
		}
	});
});

describe('annotations and helpers', () => {
	it('answers an annotation without the bookkeeping', () => {
		expect(fleetToolAnnotation('fleet_services_list')).toEqual({
			readOnly: true,
			category: 'read.internal',
			permissionFamily: 'services'
		});
		expect(fleetToolAnnotation('fleet_services_action')).toEqual({
			destructive: true,
			confirmationClass: 'confirm',
			category: 'machine.admin',
			permissionFamily: 'services'
		});
		expect(fleetToolAnnotation('nope')).toBeUndefined();
	});

	it('classifies every row for the safety gate', () => {
		const categories = fleetToolEntryPointCategories();
		for (const entry of FLEET_TOOL_CATALOGUE) expect(categories[entry.name]).toBe(entry.category);
	});

	it('maps MCP hints from the annotation', () => {
		expect(fleetToolMcpAnnotations({ readOnly: true })).toEqual({ readOnlyHint: true });
		expect(fleetToolMcpAnnotations({ destructive: true })).toEqual({ destructiveHint: true });
		expect(fleetToolMcpAnnotations({ destructive: false })).toEqual({ destructiveHint: false });
	});

	it('appends the no-credits sentence once', () => {
		const once = withFleetToolNoCreditsSentence('List things.');
		expect(once).toBe(`List things. ${FLEET_TOOL_NO_CREDITS_SENTENCE}`);
		expect(withFleetToolNoCreditsSentence(once)).toBe(once);
	});

	it('recognises the typed refusal envelope', () => {
		expect(isFleetToolError({ error: { code: 'not_found', hint: '' } })).toBe(true);
		expect(isFleetToolError({ error: 'boom' })).toBe(false);
		expect(isFleetToolError(null)).toBe(false);
	});

	it('refuses enrolment, lease, credential and attach-token paths', () => {
		expect(isFleetToolForbiddenPath('/api/fleet/enroll')).toBe(true);
		expect(isFleetToolForbiddenPath('/api/fleet/jobs/lease')).toBe(true);
		expect(isFleetToolForbiddenPath('/api/fleet/link-token')).toBe(true);
		expect(isFleetToolForbiddenPath('/api/fleet/sessions/{id}/attach-token')).toBe(true);
		expect(isFleetToolForbiddenPath('/api/fleet/checkouts/{id}/credential')).toBe(true);
		expect(isFleetToolForbiddenPath('/api/internal/fleet/x')).toBe(true);
		expect(isFleetToolForbiddenPath('/api/fleet/nodes/{id}/services')).toBe(false);
	});

	it('publishes the gate order of AW-24 FR-19', () => {
		expect(FLEET_TOOL_GATE_ORDER).toEqual([
			'kill_switch',
			'workspace_pause',
			'agent_pause',
			'grants',
			'ladder',
			'caps',
			'audience',
			'consent'
		]);
	});

	it('maps CLI exits 0 / 1 / 2 / 124', () => {
		expect(FLEET_CLI_EXIT).toEqual({ ok: 0, failed: 1, usage: 2, timeout: 124 });
		expect(fleetCliExitFor('confirmation_required')).toBe(2);
		expect(fleetCliExitFor('invalid')).toBe(2);
		expect(fleetCliExitFor('timeout')).toBe(124);
		expect(fleetCliExitFor('permission_denied')).toBe(1);
		expect(fleetCliExitFor(undefined)).toBe(1);
	});

	it('treats a held action older than 24 h as stale (spec U12)', () => {
		const now = new Date('2026-10-21T12:00:00Z');
		expect(isFleetHeldActionStale('2026-10-21T00:00:00Z', now)).toBe(false);
		expect(isFleetHeldActionStale('2026-10-20T11:59:00Z', now)).toBe(true);
		expect(isFleetHeldActionStale('not a date', now)).toBe(true);
	});
});
