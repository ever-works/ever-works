import { describe, expect, it } from 'vitest';
import { FLEET_RUN_TOKEN_ROUTES, isFleetRunTokenRouteAllowed } from '@ever-works/contracts';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';
import { KB_TOOL_PROVIDERS } from '../src/tools/kb/index.js';

/**
 * Self-build slice Z (EW-796), explicit since works-security lane 3a
 * (2026-10-18) — this MCP surface vs. the fleet-run token.
 *
 * ## Why this spec exists
 *
 * The bridge has TWO lists that must agree, maintained in different
 * packages:
 *
 *   - `WHITELIST` (plus the hand-written `kb.*` tools) here — what the MCP
 *     server exposes as tools;
 *   - `FLEET_RUN_TOKEN_ROUTES` / `isFleetRunTokenRouteAllowed` in
 *     `@ever-works/contracts` — the exact method + path templates the platform
 *     API accepts an `ew_run_…` token on.
 *
 * The token list used to be nine prefix FAMILIES, which granted every
 * controller mounted under them. It is now an explicit list that grants
 * "the MCP surface minus everything a prompt-injected run could turn against
 * the owner". So every tool must land in exactly one of two buckets, and
 * this spec names both:
 *
 *   - GRANTED: the token reaches it;
 *   - REFUSED: named below with the reason, so the 401 a fleet run gets on
 *     it is a decision, not a drift. The same tools keep working for a
 *     person's MCP client (a personal key or a session JWT).
 *
 * A new tool that is in neither bucket fails here, telling its author to
 * decide.
 */

/** The `{param}` placeholders never match literally; substitute a value. */
function concretePath(template: string): string {
	return template.replace(/\{[^}]+\}/g, 'sample-id');
}

/**
 * MCP tools a fleet-run token is DELIBERATELY refused, by tool name, with the
 * reason. Keep in step with the comment on `FLEET_RUN_TOKEN_ROUTES`.
 */
const REFUSED_FOR_RUN_TOKENS: Record<string, string> = {
	// Starts autonomous work or spends (D9 applied to run tokens).
	create_work: 'creates repositories and starts generation',
	generate_items: 'AI generation (spend)',
	update_items: 'AI generation (spend)',
	generate_work_details: 'AI generation (spend)',
	regenerate_markdown: 'writes the Work repository outside the task branch',
	update_website: 'writes the Work repository outside the task branch',
	process_community_prs: 'acts on pull requests',
	extract_item_details: 'fetches a URL and spends on extraction',
	deploy_work: 'deploys',
	update_schedule: 'schedules autonomous runs',
	cancel_schedule: 'changes the owner schedule',
	run_scheduled_update: 'starts a run',
	generate_comparison: 'AI generation (spend)',
	generate_manual_comparison: 'AI generation (spend)',
	run_mission_now: 'starts a run',
	resume_mission: 'starts runs',
	refresh_ideas: 'AI research (spend)',
	build_idea: 'starts a build',
	retry_idea: 'starts a build',
	rebuild_idea: 'starts a build',
	accept_idea: 'starts a build',
	run_tasks_batch: 'starts runs',
	run_task: 'starts a run',
	run_agent_now: 'starts a run',
	resume_agent: 'releases held runs',
	activate_goal: 'starts the Goal loop',
	evaluate_goal_now: 'metered evaluation',
	// Configuration a later run inherits.
	enable_plugin: 'plugin configuration can redirect model traffic',
	disable_plugin: 'plugin configuration',
	update_plugin_settings: 'plugin settings (e.g. a base URL) can redirect model traffic',
	update_goal_limits: 'spend cap and assigned Agent',
	update_idea_preferences: "the owner's research preferences",
	create_mission: 'strategy objects are created by a person',
	update_mission: 'strategy objects are changed by a person',
	clone_mission: 'strategy objects are created by a person',
	complete_mission: 'closes a Mission',
	attach_work_to_mission: 'strategy objects are changed by a person',
	detach_work_from_mission: 'strategy objects are changed by a person',
	// Writes outside the task branch, destructive or hiding.
	submit_item: 'commits to the Work data repository outside the task branch',
	remove_item: 'commits to the Work data repository outside the task branch',
	update_item: 'commits to the Work data repository outside the task branch',
	delete_work: 'destructive',
	delete_comparison: 'destructive',
	delete_mission: 'destructive',
	dismiss_idea: 'hides an Idea from the owner',
	delete_task: 'destructive',
	discard_task_branch: 'destructive',
	reject_task: 'the fix loop replays a rejection into a new run',
	mark_inbox_item_read: 'hides a notice from the owner',
	archive_inbox_item: 'hides a notice from the owner',
	unarchive_inbox_item: 'Inbox state is the owner’s',
	delete_inbox_item: 'hides a notice from the owner',
	// Fleet mutations a run could turn against its own machine.
	set_agent_node_affinity: 'fleet mutation',
	clear_agent_node_affinity: 'fleet mutation',
	drain_fleet_node: 'fleet mutation'
};

/** The hand-written `kb.*` tools and the API routes each one calls. */
const KB_TOOL_ROUTES: Record<string, { method: string; path: string }[]> = {
	'kb.list': [{ method: 'GET', path: '/api/works/{id}/kb/documents' }],
	'kb.get': [{ method: 'GET', path: '/api/works/{id}/kb/documents/{idOrPath}' }],
	'kb.create': [{ method: 'POST', path: '/api/works/{id}/kb/documents' }],
	'kb.update': [
		{ method: 'GET', path: '/api/works/{id}/kb/documents/{idOrPath}' },
		{ method: 'PATCH', path: '/api/works/{id}/kb/documents/{docId}' }
	],
	'kb.lock': [
		{ method: 'GET', path: '/api/works/{id}/kb/documents/{idOrPath}' },
		{ method: 'POST', path: '/api/works/{id}/kb/documents/{docId}/lock' }
	]
};

const allowed = (method: string, template: string) => isFleetRunTokenRouteAllowed(method, concretePath(template));

describe('fleet-run token surface vs. the MCP whitelist', () => {
	it('puts every whitelisted tool in exactly one bucket: granted, or deliberately refused', () => {
		const undecided = WHITELIST.filter((entry) => {
			const granted = allowed(entry.method, entry.path);
			const refused = entry.toolName !== undefined && entry.toolName in REFUSED_FOR_RUN_TOKENS;
			return granted === refused;
		}).map((entry) => `${entry.method} ${entry.path} (${entry.toolName ?? 'unnamed'})`);
		expect(
			undecided,
			'each tool must be granted in FLEET_RUN_TOKEN_ROUTES or named in REFUSED_FOR_RUN_TOKENS — not both, not neither'
		).toEqual([]);
	});

	it('names no refused tool that is not on the whitelist (the refusal list cannot rot)', () => {
		const toolNames = new Set(WHITELIST.map((entry) => entry.toolName));
		const stale = Object.keys(REFUSED_FOR_RUN_TOKENS).filter((name) => !toolNames.has(name));
		expect(stale).toEqual([]);
	});

	it('grants every route the kb.* tools call', () => {
		for (const [tool, routes] of Object.entries(KB_TOOL_ROUTES)) {
			for (const route of routes) {
				expect(allowed(route.method, route.path), `${tool}: ${route.method} ${route.path}`).toBe(true);
			}
		}
	});

	it('does not register kb.unlock, and refuses its route for run tokens', () => {
		expect(KB_TOOL_PROVIDERS.map((provider) => provider.name)).not.toContain('KbUnlockTool');
		expect(KB_TOOL_PROVIDERS).toHaveLength(Object.keys(KB_TOOL_ROUTES).length);
		expect(allowed('POST', '/api/works/{id}/kb/documents/{docId}/unlock')).toBe(false);
		expect(allowed('POST', '/api/works/{id}/kb/documents/{docId}/accept')).toBe(false);
	});

	it('grants nothing that is not on the MCP surface (no dead grant)', () => {
		const surface = [
			...WHITELIST.map((entry) => ({ method: entry.method.toUpperCase(), path: entry.path })),
			...Object.values(KB_TOOL_ROUTES).flat()
		];
		const shape = (template: string) => template.replace(/\{[^}]+\}/g, '{}');
		const dead = FLEET_RUN_TOKEN_ROUTES.filter(
			(route) =>
				!surface.some((tool) => tool.method === route.method && shape(tool.path) === shape(route.pathPattern))
		).map((route) => `${route.method} ${route.pathPattern}`);
		expect(dead, 'a run-token grant with no MCP tool behind it is surface nobody reviewed').toEqual([]);
	});

	it('grants fleet READS, so a run can see the fleet it is part of', () => {
		const fleetReads = WHITELIST.filter(
			(entry) => entry.path.startsWith('/api/fleet') && entry.method.toUpperCase() === 'GET'
		);
		expect(fleetReads.length).toBeGreaterThan(0);
		for (const entry of fleetReads) {
			expect(allowed('GET', entry.path)).toBe(true);
		}
	});

	it('refuses the lease protocol, which is deliberately NOT on this surface', () => {
		const leaseRoutes = ['/api/fleet/jobs/lease', '/api/fleet/jobs/j1/complete', '/api/fleet/jobs/j1/heartbeat'];
		for (const path of leaseRoutes) {
			expect(WHITELIST.some((entry) => entry.path.startsWith('/api/fleet/jobs'))).toBe(false);
			expect(isFleetRunTokenRouteAllowed('POST', path)).toBe(false);
		}
	});

	it('refuses the credential routes themselves — a token cannot mint another', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/j1/mcp-credential')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/j1/push-credential')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/auth/api-keys')).toBe(false);
		expect(WHITELIST.some((entry) => entry.path.startsWith('/api/auth'))).toBe(false);
		expect(WHITELIST.some((entry) => entry.path.includes('/terminal'))).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/attach-token')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/start')).toBe(false);
		// Computer-use sessions mint a driver WebSocket token the same way.
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/computer/sessions/s1/attach-token')).toBe(false);
	});

	it('refuses every human-in-the-loop gate route this surface deliberately withholds', () => {
		const withheldGates = [
			{ method: 'POST', path: '/api/inbox/{id}/reply' },
			{ method: 'POST', path: '/api/tasks/{id}/escalations/{escalationId}/resolve' },
			{ method: 'POST', path: '/api/me/goals/{id}/dod/approve' },
			{ method: 'PUT', path: '/api/me/goals/{id}/dod' },
			{ method: 'PATCH', path: '/api/me/goals/{id}/dod/{criterionId}' }
		];
		for (const gate of withheldGates) {
			expect(
				WHITELIST.some((entry) => entry.method === gate.method && entry.path === gate.path),
				`${gate.method} ${gate.path} must stay off the MCP surface`
			).toBe(false);
			expect(
				allowed(gate.method, gate.path),
				`${gate.method} ${gate.path} must stay refused for run tokens`
			).toBe(false);
		}
	});

	it('refuses the Agent configuration and Work membership routes a family used to admit', () => {
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/agents/a1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/agents/a1/files/AGENTS.md')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/import')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agent-plugins')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/members')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/invitations')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/deploy/works/w1/runtime-env')).toBe(false);
	});

	it('keeps the merge, command and repository-deletion fields off the tools', () => {
		const omitted = (tool: string) => WHITELIST.find((entry) => entry.toolName === tool)?.omitArgs ?? [];
		// The allowlist (review of #2765): update_work forwards a Work's name
		// and description only, the same set the API allows machine principals.
		expect(WHITELIST.find((entry) => entry.toolName === 'update_work')?.bodyArgs).toEqual(['name', 'description']);
		expect(omitted('update_work')).toEqual([]);
		expect(omitted('create_task')).toContain('acceptanceChecks');
		expect(omitted('update_task')).toContain('acceptanceChecks');
		expect(omitted('delete_work')).toEqual(
			expect.arrayContaining([
				'delete_data_repository',
				'delete_website_repository',
				'delete_markdown_repository'
			])
		);
	});
});
