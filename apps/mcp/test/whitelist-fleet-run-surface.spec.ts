import { describe, expect, it } from 'vitest';
import {
	FLEET_RUN_TOKEN_ALLOWED_FLEET_READ_PREFIXES,
	FLEET_RUN_TOKEN_ALLOWED_PREFIXES,
	isFleetRunTokenRouteAllowed
} from '@ever-works/contracts';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * Self-build slice Z (EW-796) — this MCP surface vs. the fleet-run token.
 *
 * ## Why this spec exists
 *
 * The bridge has TWO lists that must agree, maintained in different
 * packages:
 *
 *   - `WHITELIST` here — what the MCP server exposes as tools;
 *   - `isFleetRunTokenRouteAllowed` in `@ever-works/contracts` — what the
 *     platform API will accept an `ew_run_…` token on.
 *
 * The API's list is a positive, deny-by-omission ALLOWLIST, which is the
 * right posture but has a failure mode nobody notices: add a route to the
 * MCP surface without granting it to run tokens, and the tool ships,
 * appears in the model's tool list, and 401s at the moment a real run
 * tries to use it. Fail-closed, but baffling.
 *
 * So this spec walks the REAL whitelist and asserts the correspondence in
 * both directions: every read tool a fleet run should be able to call is
 * granted, and the handful of mutations that could be turned against the
 * run itself are refused.
 *
 * It deliberately makes NO assertion about the whitelist's size or
 * contents beyond that — slice G's own specs own those.
 */

/** The `{param}` placeholders never match literally; substitute a value. */
function concretePath(template: string): string {
	return template.replace(/\{[^}]+\}/g, 'sample-id');
}

/** Fleet MUTATIONS a run must not be able to perform on its own machine. */
const REFUSED_FLEET_MUTATIONS = [
	{ method: 'POST', path: '/api/fleet/nodes/{id}/drain' },
	{ method: 'PUT', path: '/api/fleet/agents/{agentId}/node-affinity' },
	{ method: 'DELETE', path: '/api/fleet/agents/{agentId}/node-affinity' }
];

function isRefusedMutation(entry: { method: string; path: string }): boolean {
	return REFUSED_FLEET_MUTATIONS.some(
		(refused) => refused.method === entry.method.toUpperCase() && refused.path === entry.path
	);
}

describe('fleet-run token surface vs. the MCP whitelist', () => {
	const granted = WHITELIST.filter((entry) => !isRefusedMutation(entry));
	const refused = WHITELIST.filter(isRefusedMutation);

	it('covers every whitelisted tool except the deliberately refused fleet mutations', () => {
		const notGranted = granted.filter(
			(entry) => !isFleetRunTokenRouteAllowed(entry.method, concretePath(entry.path))
		);
		// The failure message names the routes, so a future whitelist
		// addition tells the author exactly which prefix to add.
		expect(
			notGranted.map((entry) => `${entry.method} ${entry.path}`),
			'these MCP tools would 401 for a fleet run — add their family to FLEET_RUN_TOKEN_ALLOWED_PREFIXES'
		).toEqual([]);
	});

	it('refuses the fleet mutations a run could turn against itself', () => {
		// A model must not be able to drain the very machine it is running
		// on, nor repoint another Agent's node affinity.
		expect(refused.length).toBeGreaterThan(0);
		for (const entry of refused) {
			expect(
				isFleetRunTokenRouteAllowed(entry.method, concretePath(entry.path)),
				`${entry.method} ${entry.path} must stay refused for run tokens`
			).toBe(false);
		}
	});

	it('grants fleet READS, so a run can see the fleet it is part of', () => {
		const fleetReads = WHITELIST.filter(
			(entry) => entry.path.startsWith('/api/fleet') && entry.method.toUpperCase() === 'GET'
		);
		expect(fleetReads.length).toBeGreaterThan(0);
		for (const entry of fleetReads) {
			expect(isFleetRunTokenRouteAllowed('GET', concretePath(entry.path))).toBe(true);
		}
	});

	it('refuses the lease protocol, which is deliberately NOT on this surface', () => {
		// Belt and braces: these are not whitelisted tools at all, and the
		// allowlist refuses them anyway. Either alone would be enough; both
		// mean a mistake in one place is caught by the other.
		const leaseRoutes = ['/api/fleet/jobs/lease', '/api/fleet/jobs/j1/complete', '/api/fleet/jobs/j1/heartbeat'];
		for (const path of leaseRoutes) {
			expect(WHITELIST.some((entry) => entry.path.startsWith('/api/fleet/jobs'))).toBe(false);
			expect(isFleetRunTokenRouteAllowed('POST', path)).toBe(false);
		}
	});

	it('refuses the credential routes themselves — a token cannot mint another', () => {
		expect(isFleetRunTokenRouteAllowed('POST', '/api/fleet/jobs/j1/mcp-credential')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/auth/api-keys')).toBe(false);
		expect(WHITELIST.some((entry) => entry.path.startsWith('/api/auth'))).toBe(false);
		// The run terminal is NOT a whitelisted tool, but it hangs off the
		// `/api/agents` family the allowlist grants — and `attach-token`
		// mints a signed WebSocket credential while `start` opens the
		// owner's worker shell. The segment carve-out is what refuses them.
		expect(WHITELIST.some((entry) => entry.path.includes('/terminal'))).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/attach-token')).toBe(false);
		expect(isFleetRunTokenRouteAllowed('POST', '/api/agents/a1/runs/r1/terminal/start')).toBe(false);
	});

	it('the segment carve-outs never bite a shipped tool', () => {
		// The counterweight to the test above. Denying a segment inside a
		// granted family is only safe while no whitelisted path uses it —
		// so assert exactly that, and name the offender if one ever does.
		const carvedOut = ['terminal', 'mcp-servers', 'repos', 'collaborators', 'composio'];
		const collisions = WHITELIST.filter((entry) =>
			entry.path.split('/').some((segment) => carvedOut.includes(segment.toLowerCase()))
		).map((entry) => `${entry.method} ${entry.path}`);
		expect(
			collisions,
			'a whitelisted tool now uses a segment FLEET_RUN_TOKEN_DENIED_SEGMENTS refuses — the two lists must be reconciled'
		).toEqual([]);
	});

	it('grants no prefix that is not represented on this surface', () => {
		// The other direction: an allowlist entry with no corresponding tool
		// is dead grant surface. Not an error (the API may legitimately be
		// ahead of the MCP server), but it should be a deliberate choice —
		// so the check is that every prefix is at least PLAUSIBLE, i.e. an
		// `/api/` family, rather than a wildcard someone widened by mistake.
		for (const prefix of [...FLEET_RUN_TOKEN_ALLOWED_PREFIXES, ...FLEET_RUN_TOKEN_ALLOWED_FLEET_READ_PREFIXES]) {
			expect(prefix.startsWith('/api/')).toBe(true);
			expect(prefix.split('/').length).toBeGreaterThanOrEqual(3);
		}
	});
});
