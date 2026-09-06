/**
 * Self-build slice Z (EW-796) — the run-scoped credential that lets the
 * model on a fleet node reach the platform's own MCP tools.
 *
 * ## The problem this shape exists to solve
 *
 * A fleet run executes on the OWNER'S machine, under a model CLI the
 * node spawns. Slice G shipped an MCP server in front of the platform
 * API, but a node holds exactly one credential — its node secret — and
 * that secret authorises the LEASE PROTOCOL and nothing else. It is not
 * a user identity, it cannot read a Task, and handing it to a model
 * would hand the model the machine's own enrolment.
 *
 * So the node asks the platform, per job, for a SEPARATE credential:
 *
 *   1. the node proves it holds the lease on job X (its node secret),
 *   2. the platform mints a token bound to {job, run, owner, Organization}
 *      that expires no later than the lease it was minted under,
 *   3. the node keeps that token IN MEMORY and injects it into the
 *      loopback proxy's upstream request — never into the model's env,
 *      never into a file, never into a log or a job result,
 *   4. the platform revokes it the moment the job reaches a verdict.
 *
 * The token therefore has a strictly smaller blast radius than the
 * owner's own `ew_live_` key: a shorter life, one job, one Organization,
 * and only the routes the MCP server actually needs.
 *
 * ## Why the route allowlist lives HERE and not in the API
 *
 * It is the fail-closed half of the design and both sides of the wire
 * have to agree on it: the API enforces it, and `apps/mcp` pins its own
 * whitelist against it so a route added to the MCP surface without being
 * granted here shows up as a failing spec rather than as a tool that
 * mysteriously 401s in production. Deny-by-omission is deliberate — a
 * new route is refused for run tokens until someone says otherwise.
 */

/**
 * Prefix that marks a raw token as a fleet-run credential.
 *
 * The API's `AuthSessionGuard` discriminates purely on prefix (see
 * `ew_live_`), so a run token needs its own so that it can be routed to
 * the run-credential validator instead of the personal-key one — and so
 * that a leaked token is instantly identifiable in an incident.
 *
 * Same 12-character `prefix` fingerprint budget as `ew_live_`:
 * `'ew_run_'` (7) + 4 hex characters = 11, which fits the `varchar(12)`
 * column with room to spare.
 */
export const FLEET_RUN_TOKEN_PREFIX = 'ew_run_';

/**
 * Seconds of slack added to the lease deadline when the token's expiry
 * is computed.
 *
 * Why any at all: the node renews its lease on a timer and re-mints the
 * token on a timer, and the two are not in lockstep. Without a grace, a
 * tool call issued microseconds before the deadline could be refused by
 * clock skew alone. 60 s is small enough that a token outliving a
 * reclaimed job is still refused (the validator ALSO re-checks that the
 * bound job is active and still held by the bound node), and large
 * enough to absorb ordinary skew between the API and the node.
 */
export const FLEET_RUN_TOKEN_GRACE_SEC = 60;

/** The `kind` discriminator stored on an `api_keys` row minted for a run. */
export const FLEET_RUN_API_KEY_KIND = 'fleet-run';

/** The `kind` every personal `ew_live_` key carries (and the column default). */
export const PERSONAL_API_KEY_KIND = 'personal';

/** `api_keys.kind` vocabulary. */
export type ApiKeyKind = typeof PERSONAL_API_KEY_KIND | typeof FLEET_RUN_API_KEY_KIND;

/**
 * What the node gets back from `POST /api/fleet/jobs/:id/mcp-credential`.
 *
 * `token` is the ONLY place the raw credential ever exists outside the
 * node's process memory, and it exists there for exactly the length of
 * one HTTPS response. It is not echoed by any later read, and there is
 * no endpoint that can recover it — a node that loses it re-mints.
 */
export interface FleetJobMcpCredentialResponse {
	/** Raw bearer token, `ew_run_…`. Never logged, never written to disk. */
	token: string;
	/** ISO expiry — the lease deadline plus {@link FLEET_RUN_TOKEN_GRACE_SEC}. */
	expiresAt: string;
	/** Absolute URL of the platform MCP endpoint the node proxies to. */
	serverUrl: string;
}

/** Acknowledgement of an explicit early revoke by the node. */
export interface FleetJobMcpCredentialRevokeResponse {
	ok: true;
	/** How many active tokens were deactivated (0 when there were none). */
	revoked: number;
}

/**
 * The MCP bridge block the planner stamps on an `agent-task` payload.
 *
 * Absent (or `enabled: false`) is the DEFAULT and means the run is
 * byte-for-byte what it has always been: no credential is minted, no
 * proxy is started, no `--mcp-config` reaches the CLI. Three independent
 * switches must ALL be on before this appears — the operator's
 * `FLEET_NODE_MCP_BRIDGE_ENABLED`, a configured server URL, and the
 * Agent's own `canCallExternalTools` permission.
 */
export interface FleetAgentTaskMcpBridge {
	/** Whether the node should mint a credential and start the bridge. */
	enabled: boolean;
	/** Platform MCP endpoint the node's loopback proxy forwards to. */
	serverUrl: string;
	/** MCP server name written into the CLI's config (tool prefix). */
	serverName: string;
	/**
	 * Tool families the model is told about in the instructions. Naming
	 * them is not a grant — the API's allowlist is the grant — it is so
	 * the model knows the tools exist instead of discovering them.
	 */
	toolFamilies?: string[];
}

/** MCP server name the bridge registers under, and the tool-name prefix. */
export const FLEET_RUN_MCP_SERVER_NAME = 'ever-works';

/** The tool families named in the planner's prompt when the bridge is on. */
export const FLEET_RUN_MCP_TOOL_FAMILIES: readonly string[] = [
	'Tasks',
	'Inbox',
	'Goals',
	'Missions',
	'Works',
	'Agents',
	'Plugins',
	'Fleet (read-only)'
];

/** What the node reports about the bridge on the job result. Never the token. */
export interface FleetAgentTaskMcpResult {
	/** Whether the bridge was actually running for the model step. */
	enabled: boolean;
	/** MCP `tools/call` requests the proxy forwarded, when observable. */
	toolCalls?: number | null;
	/**
	 * Why the bridge did NOT run although the payload asked for it (mint
	 * refused, listener failed). The run itself is unaffected — it degrades
	 * to today's tool-free session — but an operator needs to see it.
	 */
	unavailableReason?: string | null;
}

/** One allowlisted route: an HTTP method and a path template. */
export interface FleetRunTokenRoute {
	method: string;
	/** Path template with `{param}` placeholders, e.g. `/api/tasks/{id}`. */
	pathPattern: string;
}

/**
 * Every route a fleet-run token may reach, expressed as PREFIX families.
 *
 * Read this as: "the MCP whitelist, minus anything that could be turned
 * against the run itself". Concretely excluded, permanently:
 *
 *   - `/api/auth/**` — a run token must never mint another credential,
 *     list the owner's `ew_live_` keys, or touch a session.
 *   - `/api/fleet/jobs/**` — the lease protocol. A model that could
 *     complete its own job could report a verdict it did not earn.
 *   - fleet MUTATIONS (`PUT`/`DELETE` node-affinity, `POST …/drain`) —
 *     the model would be able to drain the very machine it runs on, or
 *     repoint another Agent's scheduling. Reads are granted; writes are
 *     not.
 *   - node enrolment / rotation / pause / unenroll, tool grants,
 *     platform-admin routes, organizations, billing — none of them are
 *     on the MCP surface, and omission is what refuses them.
 *
 * The check is prefix-based on purpose: `{id}` placeholders never match
 * literally, and enumerating 128 concrete templates would be one edit
 * away from a hole. A family grants the family — MINUS the sub-resources
 * carved back out by {@link FLEET_RUN_TOKEN_DENIED_SEGMENTS}, which is
 * where the routes that merely share a prefix with the MCP surface
 * (the run terminal, connection bindings, Composio OAuth) are refused.
 */
export const FLEET_RUN_TOKEN_ALLOWED_PREFIXES: readonly string[] = [
	'/api/agent-plugins',
	'/api/agents',
	'/api/deploy',
	'/api/extract-item-details',
	'/api/inbox',
	'/api/me',
	'/api/plugins',
	'/api/tasks',
	'/api/works'
];

/**
 * Fleet routes a run token may READ, matched exactly by prefix but only
 * for safe methods. Kept apart from the list above because `/api/fleet`
 * as a family would include the lease protocol and the drain mutation.
 */
export const FLEET_RUN_TOKEN_ALLOWED_FLEET_READ_PREFIXES: readonly string[] = [
	'/api/fleet/nodes',
	'/api/fleet/runner-status',
	'/api/fleet/execution-preferences',
	'/api/fleet/agents'
];

/** Methods that never mutate — the only ones the fleet READ family admits. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Paths that are refused even though a prefix above would admit them.
 *
 * Only one entry today: `POST /api/fleet/nodes/{id}/drain` sits under the
 * `/api/fleet/nodes` read family. It is already refused by the method
 * check, and it is named here as well so the intent survives a future
 * edit that widens the methods.
 */
const FLEET_RUN_TOKEN_DENIED_SUFFIXES: readonly string[] = ['/drain'];

/**
 * Path SEGMENTS that veto a request no matter which prefix admitted it.
 *
 * The prefix families above are deliberately coarse — `/api/agents`
 * grants the agent family — and that coarseness is what makes them
 * survive a new tool being whitelisted. But a family is only safe while
 * every route mounted under it belongs on the MCP surface, and several
 * do not: they are separate controllers that merely happen to hang off
 * the same first two segments, and none of them is a whitelisted tool.
 *
 *   - `terminal`      `/api/agents/{id}/runs/{runId}/terminal/**` —
 *     `POST …/attach-token` MINTS a signed WebSocket credential and
 *     `POST …/start` opens the owner's worker shell. A run token that
 *     could mint another credential breaks the one invariant this whole
 *     design rests on, and a model that could open a shell would not
 *     need the tools at all.
 *   - `mcp-servers`   `/api/agents/{id}/mcp-servers/**` — the owner's
 *     third-party MCP connection bindings. Reading and re-binding other
 *     people's integrations is not a fleet run's business.
 *   - `repos`         `/api/agents/{id}/repos/**` — repository
 *     connection bindings; the run already has the checkout it needs.
 *   - `collaborators` `/api/agents/{id}/collaborators/**` — the agent
 *     roster, i.e. who else may drive this Agent.
 *   - `composio`      `/api/plugins/composio/**` — lists the owner's
 *     connected accounts and initiates OAuth connections.
 *
 * Segment-wise rather than suffix-wise because every one of them sits in
 * the MIDDLE of a path with an id after it, and a suffix rule would miss
 * `…/terminal/attach-token` while catching only `…/terminal`.
 *
 * Cross-checked against the real MCP whitelist by
 * `apps/mcp/test/whitelist-fleet-run-surface.spec.ts`: no whitelisted
 * tool path contains any of these segments, so nothing a fleet run is
 * meant to call is caught by this list.
 */
const FLEET_RUN_TOKEN_DENIED_SEGMENTS: ReadonlySet<string> = new Set([
	'terminal',
	'mcp-servers',
	'repos',
	'collaborators',
	'composio'
]);

/**
 * Whether a fleet-run token may be used on this request.
 *
 * Fail-closed on every axis: a malformed method or path is refused, a
 * path that is not under an allowed prefix is refused, and the fleet
 * family additionally refuses every non-safe method. Query strings and
 * trailing slashes are normalised away before matching so
 * `/api/tasks/x?y=1` and `/api/tasks/x/` are judged as `/api/tasks/x`.
 *
 * `..` is refused outright rather than resolved: a path that needs
 * resolving to be judged is a path the caller should not be sending, and
 * resolving it here would be a second, subtly different normaliser
 * sitting in front of the router's own.
 */
export function isFleetRunTokenRouteAllowed(method: unknown, path: unknown): boolean {
	if (typeof method !== 'string' || typeof path !== 'string') return false;
	const verb = method.trim().toUpperCase();
	if (!verb) return false;

	const normalized = normalizeRoutePath(path);
	if (normalized === null) return false;

	for (const suffix of FLEET_RUN_TOKEN_DENIED_SUFFIXES) {
		if (normalized.endsWith(suffix)) return false;
	}
	// The segment veto runs BEFORE any prefix can admit the path, so a
	// family grant can never reach a sub-resource that was carved out of
	// it. Splitting on `/` means the match is exact per segment: a route
	// named `/api/works/{id}/terminal-history` would not be caught by a
	// substring test, and must not be.
	for (const segment of normalized.split('/')) {
		if (segment && FLEET_RUN_TOKEN_DENIED_SEGMENTS.has(segment.toLowerCase())) return false;
	}

	if (FLEET_RUN_TOKEN_ALLOWED_PREFIXES.some((prefix) => underPrefix(normalized, prefix))) {
		return true;
	}
	if (
		SAFE_METHODS.has(verb) &&
		FLEET_RUN_TOKEN_ALLOWED_FLEET_READ_PREFIXES.some((prefix) => underPrefix(normalized, prefix))
	) {
		return true;
	}
	return false;
}

/**
 * `/api/tasks` matches `/api/tasks` and `/api/tasks/…` but NOT
 * `/api/tasks-admin`: a prefix that could straddle a path segment
 * boundary would grant a neighbouring route nobody reviewed.
 */
function underPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** Strip query/hash, collapse a trailing slash; `null` when unusable. */
function normalizeRoutePath(path: string): string | null {
	const trimmed = path.trim();
	if (!trimmed.startsWith('/')) return null;
	const withoutQuery = trimmed.split('?')[0]?.split('#')[0] ?? '';
	if (!withoutQuery.startsWith('/')) return null;
	if (withoutQuery.includes('..')) return null;
	if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
		return withoutQuery.slice(0, -1);
	}
	return withoutQuery;
}

/**
 * Compute a run token's expiry from the lease it is minted under.
 *
 * The invariant the specs pin: the token can never outlive the lease by
 * more than {@link FLEET_RUN_TOKEN_GRACE_SEC}. Everything else about its
 * life (revocation at finalize, the bound job still being held) is
 * checked at validation time, not encoded here.
 */
export function fleetRunTokenExpiryFromLease(leaseExpiresAt: Date): Date {
	return new Date(leaseExpiresAt.getTime() + FLEET_RUN_TOKEN_GRACE_SEC * 1000);
}
