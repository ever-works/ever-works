import { describe, expect, it } from 'vitest';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * Phase 9 PR Z2 — pins the MCP whitelist surface for Missions /
 * Ideas / account-wide usage so we don't accidentally drop or
 * mis-route an entry. The tool name + (method, path) tuple is
 * what external MCP clients bind to; a typo at this layer is
 * silently breaking — better to catch it in CI.
 *
 * Spec-references:
 *   - Missions endpoints from `apps/api/src/missions/missions.controller.ts`
 *     (PR H + PR HH).
 *   - Idea endpoints from `apps/api/src/work-proposals/work-proposals.controller.ts`
 *     (PR A/B + PR FF + PR U).
 *   - Account-wide usage from `apps/api/src/budgets/account-usage.controller.ts`
 *     (PR II).
 */

const MISSION_ENTRIES: Array<{ method: string; path: string; toolName: string }> = [
	{ method: 'GET', path: '/api/me/missions', toolName: 'list_missions' },
	{ method: 'POST', path: '/api/me/missions', toolName: 'create_mission' },
	{ method: 'GET', path: '/api/me/missions/{id}', toolName: 'get_mission' },
	{ method: 'GET', path: '/api/me/missions/{id}/budget', toolName: 'get_mission_budget' },
	{ method: 'PATCH', path: '/api/me/missions/{id}', toolName: 'update_mission' },
	{ method: 'DELETE', path: '/api/me/missions/{id}', toolName: 'delete_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/pause', toolName: 'pause_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/resume', toolName: 'resume_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/complete', toolName: 'complete_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/clone', toolName: 'clone_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/run-now', toolName: 'run_mission_now' }
];

const IDEA_ENTRIES: Array<{ method: string; path: string; toolName: string }> = [
	{ method: 'POST', path: '/api/me/work-proposals', toolName: 'create_idea' },
	{ method: 'GET', path: '/api/me/work-proposals', toolName: 'list_ideas' },
	{
		method: 'GET',
		path: '/api/me/work-proposals/status',
		toolName: 'get_ideas_refresh_status'
	},
	{ method: 'POST', path: '/api/me/work-proposals/refresh', toolName: 'refresh_ideas' },
	{
		method: 'GET',
		path: '/api/me/work-proposals/preferences',
		toolName: 'get_idea_preferences'
	},
	{
		method: 'PUT',
		path: '/api/me/work-proposals/preferences',
		toolName: 'update_idea_preferences'
	},
	{ method: 'GET', path: '/api/me/work-proposals/{id}', toolName: 'get_idea' },
	{ method: 'GET', path: '/api/me/work-proposals/{id}/budget', toolName: 'get_idea_budget' },
	{
		method: 'PATCH',
		path: '/api/me/work-proposals/{id}/dismiss',
		toolName: 'dismiss_idea'
	},
	{ method: 'POST', path: '/api/me/work-proposals/{id}/build', toolName: 'build_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/retry', toolName: 'retry_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/rebuild', toolName: 'rebuild_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/accept', toolName: 'accept_idea' }
];

const USAGE_ENTRIES: Array<{ method: string; path: string; toolName: string }> = [
	{ method: 'GET', path: '/api/me/usage/account-wide', toolName: 'get_account_usage' }
];

describe('WHITELIST — Phase 9 PR Z2 (Missions / Ideas / usage)', () => {
	it.each(MISSION_ENTRIES)('exposes $method $path as $toolName', ({ method, path, toolName }) => {
		const entry = WHITELIST.find((e) => e.method === method && e.path === path);
		expect(entry, `${method} ${path} missing from WHITELIST`).toBeDefined();
		expect(entry?.toolName).toBe(toolName);
	});

	it.each(IDEA_ENTRIES)('exposes $method $path as $toolName', ({ method, path, toolName }) => {
		const entry = WHITELIST.find((e) => e.method === method && e.path === path);
		expect(entry, `${method} ${path} missing from WHITELIST`).toBeDefined();
		expect(entry?.toolName).toBe(toolName);
	});

	it.each(USAGE_ENTRIES)('exposes $method $path as $toolName', ({ method, path, toolName }) => {
		const entry = WHITELIST.find((e) => e.method === method && e.path === path);
		expect(entry, `${method} ${path} missing from WHITELIST`).toBeDefined();
		expect(entry?.toolName).toBe(toolName);
	});

	it('annotates read endpoints with readOnlyHint', () => {
		const reads = [
			'list_missions',
			'get_mission',
			'get_mission_budget',
			'list_ideas',
			'get_ideas_refresh_status',
			'get_idea_preferences',
			'get_idea',
			'get_idea_budget',
			'get_account_usage'
		];
		for (const name of reads) {
			const entry = WHITELIST.find((e) => e.toolName === name);
			expect(entry?.annotations?.readOnlyHint, `${name} not flagged readOnly`).toBe(true);
		}
	});

	it('annotates destructive endpoints with destructiveHint', () => {
		const destructive = ['delete_mission', 'dismiss_idea'];
		for (const name of destructive) {
			const entry = WHITELIST.find((e) => e.toolName === name);
			expect(entry?.annotations?.destructiveHint, `${name} not flagged destructive`).toBe(true);
		}
	});

	it('does NOT flag lifecycle mutations as destructive (they are reversible / soft)', () => {
		// pause/resume/complete/build/retry/rebuild/accept all mutate but
		// none of them delete or drop data. Keep destructiveHint off so
		// MCP clients don't surface scary confirmation prompts.
		const softMutations = [
			'pause_mission',
			'resume_mission',
			'complete_mission',
			'clone_mission',
			'run_mission_now',
			'create_mission',
			'update_mission',
			'create_idea',
			'refresh_ideas',
			'build_idea',
			'retry_idea',
			'rebuild_idea',
			'accept_idea',
			'update_idea_preferences'
		];
		for (const name of softMutations) {
			const entry = WHITELIST.find((e) => e.toolName === name);
			expect(entry?.annotations?.destructiveHint ?? false, `${name} incorrectly flagged destructive`).toBe(false);
		}
	});

	it('all tool names are unique across the entire whitelist (no shadowing)', () => {
		const names = WHITELIST.map((e) => e.toolName).filter((n): n is string => Boolean(n));
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const n of names) {
			if (seen.has(n)) dupes.push(n);
			seen.add(n);
		}
		expect(dupes).toEqual([]);
	});
});
