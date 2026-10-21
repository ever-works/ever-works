import { describe, expect, it } from 'vitest';
import {
	FLEET_RUN_API_KEY_KIND,
	FLEET_RUN_MCP_SERVER_NAME,
	FLEET_RUN_MCP_TOOL_FAMILIES,
	FLEET_RUN_TOKEN_GRACE_SEC,
	FLEET_RUN_TOKEN_PREFIX,
	FLEET_RUN_TOKEN_ROUTES,
	PERSONAL_API_KEY_KIND,
	fleetRunTokenExpiryFromLease,
	isFleetRunTokenRouteAllowed
} from '../fleet-run-credential.types.js';

/**
 * Self-build slice Z (EW-796) — the run-token route allowlist.
 *
 * This is the fail-closed half of the MCP bridge: a token minted for one
 * fleet run must reach the MCP tool surface and NOTHING else. The specs
 * below pin both directions — what is granted (so the bridge is not
 * useless) and, more importantly, what is refused (so a model that gets
 * hold of its own run token cannot mint a second credential, settle its
 * own job, or drain the machine it is running on).
 *
 * `apps/mcp/test/whitelist-fleet-run-surface.spec.ts` is the companion:
 * it walks slice G's actual `WHITELIST` (and the `kb.*` tools) and asserts
 * every tool is either granted here or deliberately refused, so the two
 * lists cannot drift apart silently.
 *
 * Works-security lane 3a (2026-10-18) replaced the prefix families with an
 * EXPLICIT method + path-template list: a family granted every controller
 * mounted under it, including the routes the families were never meant for.
 */
describe('fleet run credential — token shape', () => {
	it('uses a prefix that fits the api_keys.prefix fingerprint column', () => {
		expect(FLEET_RUN_TOKEN_PREFIX).toBe('ew_run_');
		// `prefix` is varchar(12) and the service stores prefix + 4 hex chars.
		expect(FLEET_RUN_TOKEN_PREFIX.length + 4).toBeLessThanOrEqual(12);
	});

	it('does not collide with the personal ew_live_ prefix', () => {
		expect(FLEET_RUN_TOKEN_PREFIX.startsWith('ew_live_')).toBe(false);
		expect('ew_live_abc'.startsWith(FLEET_RUN_TOKEN_PREFIX)).toBe(false);
	});

	it('names the two api-key kinds distinctly', () => {
		expect(PERSONAL_API_KEY_KIND).toBe('personal');
		expect(FLEET_RUN_API_KEY_KIND).toBe('fleet-run');
		expect(PERSONAL_API_KEY_KIND).not.toBe(FLEET_RUN_API_KEY_KIND);
	});

	it('binds the expiry to the lease deadline plus the grace, and nothing more', () => {
		const lease = new Date('2026-09-05T10:00:00.000Z');
		const expiry = fleetRunTokenExpiryFromLease(lease);
		expect(expiry.getTime() - lease.getTime()).toBe(FLEET_RUN_TOKEN_GRACE_SEC * 1000);
		expect(expiry.getTime()).toBeGreaterThan(lease.getTime());
	});

	it('keeps the grace small enough to be slack, not a second lifetime', () => {
		expect(FLEET_RUN_TOKEN_GRACE_SEC).toBeGreaterThan(0);
		expect(FLEET_RUN_TOKEN_GRACE_SEC).toBeLessThanOrEqual(120);
	});

	it('names the MCP server and the tool families the prompt advertises', () => {
		expect(FLEET_RUN_MCP_SERVER_NAME).toBe('ever-works');
		expect(FLEET_RUN_MCP_TOOL_FAMILIES).toContain('Tasks');
		expect(FLEET_RUN_MCP_TOOL_FAMILIES).toContain('Inbox');
		expect(FLEET_RUN_MCP_TOOL_FAMILIES).toContain('Goals');
	});
});

describe('isFleetRunTokenRouteAllowed — granted surface', () => {
	it.each([
		['GET', '/api/tasks'],
		['POST', '/api/tasks'],
		['GET', '/api/tasks/2b0f0e6c-0000-4000-8000-000000000000'],
		['PATCH', '/api/tasks/abc'],
		['POST', '/api/tasks/abc/chat'],
		['POST', '/api/tasks/abc/transition'],
		['POST', '/api/tasks/abc/assignees'],
		['GET', '/api/inbox'],
		['GET', '/api/inbox/abc'],
		['GET', '/api/me/goals'],
		['POST', '/api/me/goals'],
		['PATCH', '/api/me/goals/abc'],
		['POST', '/api/me/goals/abc/dod/propose'],
		['GET', '/api/me/missions'],
		['POST', '/api/me/missions/abc/pause'],
		['GET', '/api/works'],
		['PUT', '/api/works/abc'],
		['GET', '/api/works/abc/kb/documents'],
		['POST', '/api/works/abc/kb/documents'],
		['PATCH', '/api/works/abc/kb/documents/d1'],
		['POST', '/api/works/abc/kb/documents/d1/lock'],
		['GET', '/api/agents'],
		['POST', '/api/agents/abc/pause'],
		['GET', '/api/agent-plugins/catalog'],
		['GET', '/api/plugins'],
		['GET', '/api/deploy/providers'],
		['POST', '/api/deploy/works/abc/check']
	])('admits %s %s', (method, path) => {
		expect(isFleetRunTokenRouteAllowed(method, path)).toBe(true);
	});

	it('admits fleet READS', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/nodes')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/nodes/abc')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/runner-status')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/execution-preferences')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/agents/abc/node-affinity')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('HEAD', '/api/fleet/nodes')).toBe(true);
	});

	it('ignores query strings and a trailing slash', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks?status=open')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks/')).toBe(true);
	});
});

describe('isFleetRunTokenRouteAllowed — refused surface', () => {
	it('refuses every auth route, so a run token can never mint another credential', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/auth/api-keys')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/auth/api-keys')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/auth/sign-in')).toBe(false);
	});

	it('refuses the lease protocol, so a run cannot settle its own job', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/lease')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/abc/complete')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/abc/heartbeat')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/abc/mcp-credential')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/jobs')).toBe(false);
	});

	it('refuses fleet MUTATIONS — a model must not drain its own machine', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/nodes/abc/drain')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/fleet/agents/abc/node-affinity')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('DELETE', '/api/fleet/agents/abc/node-affinity')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/nodes/abc/drain')).toBe(false);
	});

	it('refuses node enrolment and every other fleet write surface', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/enroll')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/heartbeat')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/enrollment-token')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/kill-switch')).toBe(false);
	});

	it('refuses admin, organizations and billing surfaces by omission', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/admin/users')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/organizations')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/subscriptions/checkout')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/users')).toBe(false);
	});

	it('refuses a neighbouring route that only shares a prefix', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks-admin')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/meta')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/worksheets')).toBe(false);
	});

	it('refuses malformed input rather than guessing', () => {
		expect(isFleetRunTokenRouteAllowed('GET', 'api/tasks')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('', '/api/tasks')).toBe(false);
		expect(isFleetRunTokenRouteAllowed(undefined, '/api/tasks')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', null)).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/jobs/../tasks')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api//tasks')).toBe(false);
	});

	it('refuses a dot SEGMENT (literal or encoded) but not dots inside a segment', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks/..')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks/%2e%2E')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks/./t1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/works/w1/kb/documents/notes..md')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/works/w1/kb/documents/brand%2Fv1.2')).toBe(true);
	});

	it('matches the METHOD, not just the path', () => {
		// A granted path is not a granted family: DELETE on a Task, POST on a
		// read route and PATCH on a PUT route are different routes.
		expect(isFleetRunTokenRouteAllowed('DELETE', '/api/tasks/t1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/inbox')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/tasks/t1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/works/w1')).toBe(false);
	});

	// ── The run terminal and other carve-outs ─────────────────────────────
	it('refuses the run terminal — a run token must not mint another credential', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/attach-token')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/start')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/runs/r1/terminal')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/runs/r1/terminal/transcript')).toBe(false);
	});

	it('refuses the computer-use driver token (it mints a WebSocket credential)', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/computer/sessions/s1/attach-token')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/computer/sessions')).toBe(false);
	});

	it('refuses connection-binding sub-resources', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/mcp-servers')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/agents/a1/mcp-servers/c1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/repos')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/collaborators')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/plugins/composio/connected-accounts')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/plugins/composio/connect')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/plugins/composio')).toBe(false);
	});

	it('refuses Agent configuration writes — instructions, permissions, files, skills, import', () => {
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/agents/a1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/agents/a1/files/AGENTS.md')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/import')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/agents/a1/guardrails')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agent-plugins')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/steer')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/resume')).toBe(false);
	});

	it('refuses everything that starts autonomous work or spends', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/run')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/run-batch')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/schedule')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/recurring')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/recurring/run-now')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/run-now')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/resume')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/assign-task')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/missions/m1/run-now')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/missions/m1/resume')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/goals/g1/activate')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/goals/g1/evaluate-now')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/goals/g1/loop/start')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/generate')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/deploy/works/w1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/work-proposals/i1/build')).toBe(false);
	});

	it('refuses configuration a later run would inherit', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/plugins/p1/enable')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/plugins/p1/disable')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/plugins/p1/settings')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/me/goals/g1/limits')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/deploy/works/w1/runtime-env')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/works/w1/schedule')).toBe(false);
	});

	it('refuses Work membership and personal-account writes', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/members')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/works/w1/members')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/invitations')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/me')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/me/work-proposals/preferences')).toBe(false);
	});

	it('refuses destructive, hiding and repository-writing tools', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/delete')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('DELETE', '/api/tasks/t1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/discard-branch')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/reject')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/inbox/i1/archive')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/inbox/i1/read')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('DELETE', '/api/inbox/i1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/submit-item')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/remove-item')).toBe(false);
	});

	it('refuses the KB review and unlock routes (a run must not accept its own document)', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/kb/documents/d1/unlock')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/kb/documents/d1/accept')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/works/w1/kb/documents/d1/decision-status')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('DELETE', '/api/works/w1/kb/documents/d1')).toBe(false);
	});

	// ── Human-in-the-loop gate routes ─────────────────────────────────────
	//
	// A run token acts AS THE OWNER. The inbox reply reaches
	// `AgentApprovalsService.decide`, which stamps `decidedVia: 'user'` + the
	// owner as decider — exactly what the merge approval verifier accepts as a
	// HUMAN approval.
	it('refuses the inbox reply — the route that decides a merge approval as the owner', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/inbox/i1/reply')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/inbox/i1/reply/')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/inbox/i1/Reply?x=1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/inbox/i1/reply')).toBe(false);
	});

	it('refuses every gate answer: escalations, DoD, agent approvals', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/tasks/t1/escalations/e1/resolve')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/escalations/e1/resolve')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/goals/g1/dod/approve')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/me/goals/g1/dod')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PATCH', '/api/me/goals/g1/dod/c1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agent-approvals/p1/approve')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agent-approvals/p1/reject')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agent-approvals/approve-all')).toBe(false);
	});

	it('keeps the ASKING side — reading and proposing stay granted', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/inbox')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/inbox/i1')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks/t1/escalations')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/me/goals/g1/dod/propose')).toBe(true);
	});

	it('lowercase and mixed-case methods are normalised, not refused', () => {
		expect(isFleetRunTokenRouteAllowed('get', '/api/fleet/nodes')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('Post', '/api/tasks')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('post', '/api/fleet/nodes/abc/drain')).toBe(false);
	});
});

describe('route list composition', () => {
	it('every entry is an exact /api/ template with a known method', () => {
		expect(FLEET_RUN_TOKEN_ROUTES.length).toBeGreaterThan(0);
		for (const route of FLEET_RUN_TOKEN_ROUTES) {
			expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(route.method);
			expect(route.pathPattern.startsWith('/api/')).toBe(true);
			expect(route.pathPattern.endsWith('/')).toBe(false);
			expect(route.pathPattern.includes('*')).toBe(false);
		}
	});

	it('never lists /api/auth or /api/fleet/jobs, and lists no fleet write', () => {
		for (const route of FLEET_RUN_TOKEN_ROUTES) {
			expect(route.pathPattern.startsWith('/api/auth')).toBe(false);
			expect(route.pathPattern.startsWith('/api/fleet/jobs')).toBe(false);
			if (route.pathPattern.startsWith('/api/fleet')) expect(route.method).toBe('GET');
		}
	});

	it('lists no route twice', () => {
		const keys = FLEET_RUN_TOKEN_ROUTES.map((route) => `${route.method} ${route.pathPattern}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('every listed route is actually admitted by the matcher', () => {
		for (const route of FLEET_RUN_TOKEN_ROUTES) {
			const concrete = route.pathPattern.replace(/\{[^}]+\}/g, 'sample-id');
			expect(isFleetRunTokenRouteAllowed(route.method, concrete), `${route.method} ${route.pathPattern}`).toBe(
				true
			);
		}
	});
});
