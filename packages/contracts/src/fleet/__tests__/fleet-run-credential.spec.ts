import { describe, expect, it } from 'vitest';
import {
	FLEET_RUN_API_KEY_KIND,
	FLEET_RUN_MCP_SERVER_NAME,
	FLEET_RUN_MCP_TOOL_FAMILIES,
	FLEET_RUN_TOKEN_ALLOWED_FLEET_READ_PREFIXES,
	FLEET_RUN_TOKEN_ALLOWED_PREFIXES,
	FLEET_RUN_TOKEN_GRACE_SEC,
	FLEET_RUN_TOKEN_PREFIX,
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
 * it walks slice G's actual `WHITELIST` and asserts every read tool is
 * admitted here, so the two lists cannot drift apart silently.
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
		['POST', '/api/tasks/abc/chat'],
		['GET', '/api/inbox'],
		['POST', '/api/inbox/abc/read'],
		['GET', '/api/me/goals'],
		['POST', '/api/me/goals/abc/evaluate-now'],
		['GET', '/api/me/missions'],
		['GET', '/api/works'],
		['PUT', '/api/works/abc'],
		['GET', '/api/agents'],
		['POST', '/api/agents/abc/run-now'],
		['GET', '/api/agent-plugins/catalog'],
		['GET', '/api/plugins'],
		['POST', '/api/deploy/works/abc'],
		['POST', '/api/extract-item-details']
	])('admits %s %s', (method, path) => {
		expect(isFleetRunTokenRouteAllowed(method, path)).toBe(true);
	});

	it('admits fleet READS', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/nodes')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/nodes/abc')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/runner-status')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/execution-preferences')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/fleet/agents/abc/node-affinity')).toBe(true);
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
	});

	it('refuses fleet MUTATIONS — a model must not drain its own machine', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/nodes/abc/drain')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/fleet/agents/abc/node-affinity')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('DELETE', '/api/fleet/agents/abc/node-affinity')).toBe(false);
		// Even a GET on drain stays refused: the deny-suffix outranks the family.
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

	it('refuses a prefix that only straddles a segment boundary', () => {
		// `/api/tasks` must not grant `/api/tasks-admin`.
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
	});

	// ── The carve-outs inside a granted family ───────────────────────────
	//
	// `/api/agents` and `/api/plugins` are granted as FAMILIES, and several
	// controllers hang off those prefixes that are not MCP tools at all.
	// The most serious is the run terminal: `POST …/terminal/attach-token`
	// mints a signed WebSocket credential and `POST …/terminal/start` opens
	// the owner's worker shell. A run token that can mint another
	// credential defeats the entire design, so the segment veto has to bite
	// even though the family prefix admits the path.
	it('refuses the run terminal — a run token must not mint another credential', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/attach-token')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/start')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/runs/r1/terminal')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/runs/r1/terminal/transcript')).toBe(false);
	});

	it('refuses connection-binding sub-resources of a granted family', () => {
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/mcp-servers')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('PUT', '/api/agents/a1/mcp-servers/c1')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/repos')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/collaborators')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/plugins/composio/connected-accounts')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/plugins/composio/connect')).toBe(false);
	});

	it('still grants the agent and plugin routes that ARE on the MCP surface', () => {
		// The veto must be surgical: carving out the terminal may not cost
		// the family the tools it exists for.
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/runs')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/agents/a1/runs/r1')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/cancel')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/plugins')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/plugins/p1/enable')).toBe(true);
	});

	it('matches a denied segment exactly, never as a substring', () => {
		// A future `/api/works/{id}/terminal-history` is a different route
		// and must stay granted; only the exact segment is vetoed.
		expect(isFleetRunTokenRouteAllowed('GET', '/api/works/w1/terminal-history')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('GET', '/api/tasks/t1/repositories')).toBe(true);
	});

	it('lowercase and mixed-case methods are normalised, not refused', () => {
		expect(isFleetRunTokenRouteAllowed('get', '/api/fleet/nodes')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('Post', '/api/tasks')).toBe(true);
		expect(isFleetRunTokenRouteAllowed('post', '/api/fleet/nodes/abc/drain')).toBe(false);
	});
});

describe('allowlist composition', () => {
	it('never lists /api/auth, /api/fleet/jobs or a bare /api/fleet family', () => {
		const all = [...FLEET_RUN_TOKEN_ALLOWED_PREFIXES, ...FLEET_RUN_TOKEN_ALLOWED_FLEET_READ_PREFIXES];
		expect(all).not.toContain('/api');
		expect(all).not.toContain('/api/auth');
		expect(all).not.toContain('/api/fleet');
		expect(all).not.toContain('/api/fleet/jobs');
		for (const prefix of all) {
			expect(prefix.startsWith('/api/')).toBe(true);
			expect(prefix.endsWith('/')).toBe(false);
		}
	});
});
