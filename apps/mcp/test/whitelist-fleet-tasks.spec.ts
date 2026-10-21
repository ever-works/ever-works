import { describe, expect, it } from 'vitest';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * Tasks on computers (FL-15, CONTRACTS §11.3) — the MCP surface uses the
 * Agent tools' names; the hand-off has no start route of its own (the start
 * is `fleet_sessions_start` with `taskId`).
 */
const ENTRIES = [
	{ method: 'GET', path: '/api/fleet/tasks/{taskId}/handoff-options', toolName: 'fleet_tasks_handoff_options' },
	{ method: 'GET', path: '/api/fleet/nodes/{id}/git/identity', toolName: 'fleet_nodes_git_identity_get' },
	{ method: 'POST', path: '/api/fleet/nodes/{id}/git/identity', toolName: 'fleet_nodes_git_identity_set' },
	{ method: 'POST', path: '/api/inbound-triggers/presets/github-for-me', toolName: 'inbound_triggers_github_for_me' }
];

describe('WHITELIST — tasks on computers (FL-15)', () => {
	it('exposes the hand-off options and the git identity under their CONTRACTS names', () => {
		for (const entry of ENTRIES) {
			const found = WHITELIST.find((w) => w.method === entry.method && w.path === entry.path);
			expect(found?.toolName).toBe(entry.toolName);
		}
	});

	it('marks the reads read-only', () => {
		const byName = new Map(WHITELIST.map((w) => [w.toolName, w]));
		expect(byName.get('fleet_tasks_handoff_options')?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get('fleet_nodes_git_identity_get')?.annotations?.readOnlyHint).toBe(true);
	});

	it('adds no second session-start tool (spec FR-21)', () => {
		expect(WHITELIST.some((w) => w.path.includes('/handoff') && w.method === 'POST')).toBe(false);
		expect(WHITELIST.filter((w) => w.toolName === 'fleet_sessions_start')).toHaveLength(1);
	});
});
