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
	drain_fleet_node: 'fleet mutation',
	// Sessions on computers (FL-04 P2): a person's terminals on their machines. A run's
	// Agent works through its own `fleet_sessions_*` tools, never through a person's MCP surface.
	fleet_sessions_list: "a person's sessions on their computers",
	fleet_sessions_read: "a person's sessions on their computers (last screens)",
	fleet_sessions_start: 'starts a process on a computer',
	fleet_sessions_rename: "a person's sessions on their computers",
	fleet_sessions_end: 'destructive: stops a process on a computer',
	// Checkouts, logs, commands and ports (FL-14, FL-08, FL-12, FL-10) — the family epics added
	// these tools without a run-token grant; FL-19 names the refusal so it is a decision. A run's
	// Agent reaches its owner's computers through its own gated fleet tools, never through a
	// person's MCP surface.
	fleet_checkouts_list: "a person's checkouts on their computers",
	fleet_checkouts_get: "a person's checkouts on their computers",
	fleet_checkouts_create: 'writes on a computer',
	fleet_checkouts_sync: 'pushes and pulls on a computer',
	fleet_checkouts_archive: 'moves a checkout to the bin',
	fleet_checkouts_delete: 'destructive: deletes a checkout',
	fleet_logs_sources: "a computer's log sources",
	fleet_logs_read: "a computer's logs",
	fleet_commands_run: 'runs commands on computers',
	fleet_commands_list: "a person's commands and their output",
	fleet_commands_get: "a person's commands and their output",
	fleet_commands_cancel: 'stops a command on a computer',
	fleet_ports_list: 'what a computer listens on',
	fleet_ports_open: 'opens a page on a computer',
	fleet_ports_preview_close: "closes a person's preview tunnel",
	// Actions runners (FL-18): a runner registers a computer with a repository and then runs that
	// repository's workflows there — never a run token's to see or change.
	fleet_runners_list: "the Actions runners on a person's computers and the repositories they serve",
	fleet_runners_install: 'registers a computer as a runner for a repository',
	fleet_runners_action: 'starts or stops an Actions runner on a computer',
	fleet_runners_remove: 'destructive: removes an Actions runner',
	// FL-19 P1 — the catalogue's reads: machine state of every computer the owner has.
	fleet_status: "the owner's whole fleet at a glance",
	fleet_nodes_health: "a computer's health",
	fleet_nodes_needs_a_look: 'what needs a look on a computer',
	fleet_services_list: 'the services on a computer',
	fleet_processes_list: 'the processes on a computer',
	fleet_docker_containers_list: 'the containers on a computer',
	fleet_docker_images_list: 'the images on a computer',
	fleet_docker_compose_list: 'the Compose projects on a computer',
	fleet_operations_get: "a person's long operations",
	fleet_operations_list: "a person's long operations",
	fleet_nodes_git_identity_get: "a computer's git identity",
	fleet_tasks_handoff_options: "a person's computers, checkouts and agents for a Task",
	// FL-19 P2 — the catalogue's acts on MCP: every one changes a computer.
	fleet_services_action: 'starts and stops services on a computer',
	fleet_processes_signal: 'signals processes on a computer',
	fleet_docker_container_action: 'starts, stops and removes containers on a computer',
	fleet_docker_image_action: 'removes images on a computer',
	fleet_docker_compose_action: 'brings Compose projects up and down on a computer',
	fleet_nodes_wake: 'wakes a computer',
	fleet_nodes_git_identity_set: "writes a computer's git identity",
	fleet_operations_cancel: "stops a person's operation",
	// FL-11 / FL-16 tools that landed beside FL-19 P2 without a run-token decision.
	fleet_files_roots: "a computer's shared folders",
	fleet_files_list: "the files on a person's computer",
	fleet_files_stat: "the files on a person's computer",
	fleet_virtual_list: "a person's virtual computers",
	fleet_virtual_options: 'what a computer can host',
	fleet_virtual_create: 'creates a virtual computer',
	fleet_virtual_power: 'starts and stops a virtual computer',
	fleet_virtual_destroy: 'destructive: destroys a virtual computer',
	// FL-05 P2: typing an answer into a person's session prompt.
	fleet_sessions_answer: "answers a prompt in a person's session",
	// The 10-21 build sprint's tools that landed without a run-token decision (deny-by-omission
	// already refused them; named here so the refusal is a decision). FL-06 session actions.
	fleet_sessions_actions_list: "a person's session action ledger",
	fleet_sessions_action: "types an action prompt into a person's session",
	fleet_checkouts_changes: "the uncommitted diff of a person's checkout",
	// Inbound triggers: a trigger starts runs later (configuration a later run inherits).
	inbound_triggers_github_for_me: 'creates an inbound trigger that starts runs',
	// FL-11 P2 files: writes on a computer.
	fleet_files_copy: "writes files on a person's computer",
	fleet_files_delete: "destructive: deletes files on a person's computer",
	// FL-13 schedules: a schedule runs commands on a computer on its own clock.
	fleet_schedules_list: "a person's schedules on their computers",
	fleet_schedules_get: "a person's schedules on their computers",
	fleet_schedules_runs: "a person's schedule history and its output",
	fleet_schedules_create: 'schedules commands on a computer',
	fleet_schedules_update: 'changes what a schedule runs',
	fleet_schedules_delete: "destructive: deletes a person's schedule",
	fleet_schedules_run: 'runs a schedule now',
	fleet_schedules_pause: "changes a person's schedule",
	fleet_schedules_resume: 'resumes scheduled commands',
	// FL-17 cloud computers: spend.
	fleet_cloud_list: "a person's cloud computers",
	fleet_cloud_options: "a person's provider choices",
	fleet_cloud_usage: "a person's cloud spend",
	fleet_cloud_create: 'creates a cloud computer (spend)',
	fleet_cloud_power: 'starts and stops a cloud computer',
	fleet_cloud_destroy: 'destructive: destroys a cloud computer',
	fleet_cloud_idle_policy: 'decides when a cloud computer is powered off (spend)',
	// FL-20 usage & cost: a person's model spend across their computers.
	fleet_usage_get: "a person's model usage and cost across their computers",
	// FL-18 P2 Actions jobs: a person's CI across their repositories, and cancelling it.
	fleet_runners_jobs: "a person's queued and running CI jobs across their repositories",
	fleet_runners_cancel_run: "cancels a whole workflow run of a person's repository",
	// FL-07 desktop view & control: the `desktop` family (watching and controlling a person's
	// screen) is never reachable with a run token — not even the read of its displays.
	fleet_desktop_displays: "the displays of a person's computer (the desktop view family)",
	// App Works (B1 #2960 added these 32 MCP tools). Refused for run tokens, fail-closed: an
	// App Work run on a computer never gets the platform's MCP tools (APW-08 T47, #2961), and
	// these act on deployed Apps, their clusters, env names and upstream forks. Whether the
	// read-only half may be granted is an owner question (Q175); granting it means adding the
	// routes to FLEET_RUN_TOKEN_ROUTES, not removing entries here.
	inspect_app_source: 'App Works: reads a repository for App creation (a person starts App Works)',
	get_app_status: "App Works: a person's deployed App state",
	refresh_app_status: 'App Works: asks the cluster worker for fresh state',
	list_app_deployments: "App Works: a person's deployment history",
	request_app_logs: "App Works: reads a deployed App's logs",
	get_app_logs: "App Works: a deployed App's logs",
	get_app_target: 'App Works: the cluster an App deploys to',
	get_app_deletion_preview: 'App Works: what deleting an App removes',
	run_app_smoke: 'App Works: runs checks against a live App',
	rollback_app: 'App Works: changes what a live App runs',
	change_app_lifecycle: 'App Works: stops, starts or restarts a live App',
	list_app_builds: "App Works: a person's Builds",
	get_app_build: "App Works: a person's Build",
	cancel_app_build: 'App Works: cancels a Build',
	get_app_env: "App Works: an App's env names (values stay masked)",
	list_app_dependencies: "App Works: an App's databases and services",
	get_app_spec: "App Works: an App's spec",
	validate_app_spec: 'App Works: validates an App spec',
	apply_app_blueprint: "App Works: writes a Blueprint into an App's spec",
	upgrade_app_blueprint: 'App Works: upgrades an App to a new Blueprint version',
	dismiss_app_blueprint_upgrade: 'App Works: hides a Blueprint upgrade from the owner',
	get_app_license: "App Works: an App's licence classification",
	list_app_catalog_entries: 'App Works: the Apps catalog',
	list_app_blueprints: 'App Works: the Blueprint catalog',
	list_app_licenses: 'App Works: the licence registry',
	get_app_catalog_entry: 'App Works: an Apps catalog entry',
	get_app_provisioning: "App Works: an App's provisioning state",
	cancel_app_provisioning: 'App Works: cancels provisioning',
	list_app_changes: "App Works: an App's change requests",
	get_app_upstream: "App Works: an App's upstream fork state",
	sync_app_upstream: 'App Works: syncs an App from its upstream',
	retry_app_readiness: 'App Works: re-runs fork readiness'
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
		// Every fleet read that is not deliberately refused above (a person's sessions,
		// checkouts, logs, schedules … on their own computers are refused by name).
		const fleetReads = WHITELIST.filter(
			(entry) =>
				entry.path.startsWith('/api/fleet') &&
				entry.method.toUpperCase() === 'GET' &&
				!(entry.toolName !== undefined && entry.toolName in REFUSED_FOR_RUN_TOKENS)
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
