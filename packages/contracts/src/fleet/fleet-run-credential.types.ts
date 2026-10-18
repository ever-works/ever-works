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

/**
 * `api_keys.kind` vocabulary. `'integration'` (EW-P1-2) is the `ew_int_`
 * integration key — see `integrations/integration-keys.types.ts`.
 */
export type ApiKeyKind = typeof PERSONAL_API_KEY_KIND | typeof FLEET_RUN_API_KEY_KIND | 'integration';

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
 * Every route a fleet-run token may reach, as EXACT method + path templates
 * (works-security lane 3a, 2026-10-18). It used to be nine whole PREFIX
 * families (`/api/agents`, `/api/tasks`, `/api/works`, …) for any method,
 * minus a few carved-out segments, and a family grants everything mounted
 * under it — the computer-use driver token, Agent file and instruction
 * writes, the run steer/resume routes, KB accept, deploy runtime env, the
 * DoD replace/tick routes and every other controller that merely shares a
 * prefix with the MCP surface. An explicit list grants exactly what is
 * written here and nothing that is added later.
 *
 * Read this as: "the MCP whitelist, minus everything that could be turned
 * against the owner by a prompt-injected run". Concretely NOT granted:
 *
 *   - anything that STARTS autonomous work or spends: running a Task, a
 *     batch, an Agent or a Mission; resuming an Agent or a Mission;
 *     activating or evaluating a Goal; generation, comparison, schedule,
 *     deploy and Idea build routes (the integrations rule, plan decision D9,
 *     applied to run tokens: a machine principal never starts a run);
 *   - configuration that changes what later runs do: plugin enable / disable
 *     / settings (a plugin's base URL can redirect model traffic), Agent
 *     updates (instructions, permissions, files, skills), Goal limits;
 *   - writes outside the task branch: the Work item routes commit straight
 *     to the Work's data repository, so they are a merge-gate bypass;
 *   - destructive or hiding writes: deleting a Work, a Task, a comparison,
 *     a Mission; discarding a branch; archiving, deleting or marking read an
 *     Inbox item (it would hide a notice from the owner);
 *   - recording a reviewer rejection (it is replayed into the next run as
 *     instructions and the fix loop starts that run);
 *   - every human-in-the-loop gate (inbox reply, escalation resolve, DoD
 *     approve) and every credential route (`/api/auth`, `/api/fleet/jobs`).
 *
 * Several granted routes still carry BODY fields a run token may not set —
 * a Work's merge policy and check commands, a Task's acceptance checks,
 * `scheduledAt`, `force`, an agent assignee wider than the run's own Agent,
 * a Goal's `outcome` / `constraints`. A path list cannot see a body, so
 * those refusals live in the controllers (see `machine-principal.ts` in
 * `apps/api`).
 *
 * Deny-by-omission: a new route, or a new MCP tool, is refused for run
 * tokens until it is written here. `apps/mcp/test/whitelist-fleet-run-surface.spec.ts`
 * walks the real MCP whitelist (and the hand-written `kb.*` tools) and
 * requires every tool to be either granted here or named as deliberately
 * refused, so the two lists cannot drift apart silently.
 */
export const FLEET_RUN_TOKEN_ROUTES: readonly FleetRunTokenRoute[] = Object.freeze([
	// Works — reads, plus the settings update (its merge / check / command
	// fields are refused for run tokens by the Works controller).
	{ method: 'GET', pathPattern: '/api/works' },
	{ method: 'GET', pathPattern: '/api/works/{id}' },
	{ method: 'PUT', pathPattern: '/api/works/{id}' },
	{ method: 'GET', pathPattern: '/api/works/{id}/config' },
	{ method: 'GET', pathPattern: '/api/works/{id}/items' },
	{ method: 'GET', pathPattern: '/api/works/{id}/categories-tags' },
	{ method: 'GET', pathPattern: '/api/works/{id}/history' },
	{ method: 'GET', pathPattern: '/api/works/{id}/generator-form' },
	{ method: 'GET', pathPattern: '/api/works/{id}/schedule' },
	{ method: 'GET', pathPattern: '/api/works/{id}/comparisons' },
	{ method: 'GET', pathPattern: '/api/works/{id}/comparisons/{slug}' },

	// Knowledge Base (`apps/mcp/src/tools/kb`). A document a run token writes
	// lands `proposed` (review-gated), see the KB controller. No unlock.
	{ method: 'GET', pathPattern: '/api/works/{id}/kb/documents' },
	{ method: 'POST', pathPattern: '/api/works/{id}/kb/documents' },
	{ method: 'GET', pathPattern: '/api/works/{id}/kb/documents/{docIdOrPath}' },
	{ method: 'PATCH', pathPattern: '/api/works/{id}/kb/documents/{docId}' },
	{ method: 'POST', pathPattern: '/api/works/{id}/kb/documents/{docId}/lock' },

	// Deploy — reads and the capability check only.
	{ method: 'GET', pathPattern: '/api/deploy/works/{id}/domains' },
	{ method: 'GET', pathPattern: '/api/deploy/providers' },
	{ method: 'POST', pathPattern: '/api/deploy/works/{id}/check' },

	// Plugins — read only.
	{ method: 'GET', pathPattern: '/api/plugins' },
	{ method: 'GET', pathPattern: '/api/plugins/{pluginId}' },

	// Missions — reads, plus pause (the safe direction).
	{ method: 'GET', pathPattern: '/api/me/missions' },
	{ method: 'GET', pathPattern: '/api/me/missions/{id}' },
	{ method: 'GET', pathPattern: '/api/me/missions/{id}/budget' },
	{ method: 'GET', pathPattern: '/api/me/missions/{id}/works' },
	{ method: 'POST', pathPattern: '/api/me/missions/{id}/pause' },

	// Ideas — reads, plus filing a new Idea (a proposal a person builds).
	{ method: 'POST', pathPattern: '/api/me/work-proposals' },
	{ method: 'GET', pathPattern: '/api/me/work-proposals' },
	{ method: 'GET', pathPattern: '/api/me/work-proposals/status' },
	{ method: 'GET', pathPattern: '/api/me/work-proposals/preferences' },
	{ method: 'GET', pathPattern: '/api/me/work-proposals/{id}' },
	{ method: 'GET', pathPattern: '/api/me/work-proposals/{id}/budget' },

	// Account-wide usage.
	{ method: 'GET', pathPattern: '/api/me/usage/account-wide' },

	// Tasks — reads and collaboration writes. Create / update / transition /
	// assign / chat carry body refusals for run tokens in the Tasks
	// controller (no checks, no schedule, no force, no dispatch, no @agent).
	{ method: 'GET', pathPattern: '/api/tasks' },
	{ method: 'POST', pathPattern: '/api/tasks' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}' },
	{ method: 'PATCH', pathPattern: '/api/tasks/{id}' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/subtasks' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/activity' },
	{ method: 'POST', pathPattern: '/api/tasks/{id}/transition' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/run-candidates' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/pr-status' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/diff' },
	{ method: 'POST', pathPattern: '/api/tasks/{id}/assignees' },
	{ method: 'POST', pathPattern: '/api/tasks/{id}/reviewers' },
	{ method: 'POST', pathPattern: '/api/tasks/{id}/approvers' },
	{ method: 'POST', pathPattern: '/api/tasks/{id}/relations' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/escalations' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/chat' },
	{ method: 'POST', pathPattern: '/api/tasks/{id}/chat' },
	{ method: 'GET', pathPattern: '/api/tasks/{id}/spend' },

	// Inbox — read only (no reply, no archive / delete / mark-read).
	{ method: 'GET', pathPattern: '/api/inbox' },
	{ method: 'GET', pathPattern: '/api/inbox/unread-count' },
	{ method: 'GET', pathPattern: '/api/inbox/{id}' },

	// Goals — reads, a draft create, field-limited update, pause, and the
	// ASKING side of the definition of done (propose, never approve).
	{ method: 'GET', pathPattern: '/api/me/goals' },
	{ method: 'POST', pathPattern: '/api/me/goals' },
	{ method: 'GET', pathPattern: '/api/me/goals/{id}' },
	{ method: 'PATCH', pathPattern: '/api/me/goals/{id}' },
	{ method: 'GET', pathPattern: '/api/me/goals/{id}/samples' },
	{ method: 'POST', pathPattern: '/api/me/goals/{id}/pause' },
	{ method: 'POST', pathPattern: '/api/me/goals/{id}/dod/propose' },

	// Fleet — reads only.
	{ method: 'GET', pathPattern: '/api/fleet/nodes' },
	{ method: 'GET', pathPattern: '/api/fleet/nodes/{id}' },
	{ method: 'GET', pathPattern: '/api/fleet/runner-status' },
	{ method: 'GET', pathPattern: '/api/fleet/execution-preferences' },
	{ method: 'GET', pathPattern: '/api/fleet/agents/{agentId}/node-affinity' },

	// Agents — reads, plus cancel and pause (the safe direction).
	{ method: 'GET', pathPattern: '/api/agents' },
	{ method: 'GET', pathPattern: '/api/agents/{id}' },
	{ method: 'GET', pathPattern: '/api/agents/{id}/runs' },
	{ method: 'GET', pathPattern: '/api/agents/{id}/runs/{runId}' },
	{ method: 'POST', pathPattern: '/api/agents/{id}/runs/{runId}/cancel' },
	{ method: 'POST', pathPattern: '/api/agents/{id}/pause' },
	{ method: 'GET', pathPattern: '/api/agents/{id}/budget' },

	// Agent Plugins — read only (installing a package installs instructions).
	{ method: 'GET', pathPattern: '/api/agent-plugins' },
	{ method: 'GET', pathPattern: '/api/agent-plugins/findings' },
	{ method: 'GET', pathPattern: '/api/agent-plugins/catalog' },
	{ method: 'GET', pathPattern: '/api/agent-plugins/updates' }
] as FleetRunTokenRoute[]) as readonly FleetRunTokenRoute[];

/**
 * The ONLY Work settings a machine principal — a fleet-run token or an
 * integration key — may set through `PUT` / `PATCH /api/works/:id`
 * (works-security lane 3a, 2026-10-18): descriptive text. Everything else on
 * that route decides what the platform later does without a person — the
 * merge gate, the commands a node runs, where task branches come from and
 * land, community-PR processing, who owns the Work, its template, deploy
 * target, committer identity, external references — and is refused for them.
 * The MCP `update_work` tool exposes exactly these body arguments.
 */
export const MACHINE_PRINCIPAL_WORK_WRITABLE_FIELDS: readonly string[] = Object.freeze(['name', 'description']);

/**
 * Path SEGMENTS that veto a request whatever the list above says.
 *
 * Kept from the prefix era as a second, independent layer: no granted
 * template contains any of these, so with the explicit list they refuse
 * nothing extra today — but a future edit that adds a route under one of
 * these sub-resources is still refused until this list is reconciled too.
 *
 *   - `terminal`      the run terminal (`attach-token` mints a WebSocket
 *     credential, `start` opens the owner's worker shell);
 *   - `computer`      computer-use sessions (`attach-token` mints a driver
 *     WebSocket credential);
 *   - `mcp-servers`   the owner's third-party MCP connection bindings;
 *   - `repos`         repository connection bindings;
 *   - `collaborators` the agent roster;
 *   - `composio`      the owner's connected accounts and OAuth initiation;
 *   - `members` / `invitations` who may act on a Work.
 *
 * Segment-wise rather than suffix-wise because every one of them sits in
 * the MIDDLE of a path with an id after it.
 */
const FLEET_RUN_TOKEN_DENIED_SEGMENTS: ReadonlySet<string> = new Set([
	'terminal',
	'computer',
	'mcp-servers',
	'repos',
	'collaborators',
	'composio',
	'members',
	'invitations'
]);

/**
 * Human-in-the-loop GATE routes, refused for a run token whatever the list
 * says. Matched by exact shape, one `*` per id segment.
 *
 * None of them is in {@link FLEET_RUN_TOKEN_ROUTES}; they are pinned here as
 * well so the intent survives a future edit of the list. The API cannot tell
 * a caller holding the owner's credential from the owner, so any verb that
 * ANSWERS a gate would let the agent answer its own:
 *
 *   - `…/inbox/{id}/reply` — decides a `merge_pull_request` proposal as the
 *     owner (`decidedVia: 'user'`), which the merge verifier accepts;
 *   - `…/tasks/{id}/escalations/{escalationId}/resolve`, `…/escalations/{id}/resolve`;
 *   - `…/me/goals/{id}/dod/approve` (the DoD replace / tick routes,
 *     `PUT …/dod` and `PATCH …/dod/{criterionId}`, mark criteria met without
 *     it; they are refused by omission from the list, and the shape
 *     `…/dod/*` cannot be pinned here without also catching `…/dod/propose`);
 *   - `…/agent-approvals/{id}/approve|reject`, `…/agent-approvals/approve-all`.
 *
 * (`force` on a transition and `requireAllApprovers` on a Task are BODY
 * fields this path check cannot see; the Tasks controller refuses both.)
 */
const FLEET_RUN_TOKEN_DENIED_GATE_ROUTES: readonly (readonly string[])[] = [
	['api', 'inbox', '*', 'reply'],
	['api', 'tasks', '*', 'escalations', '*', 'resolve'],
	['api', 'escalations', '*', 'resolve'],
	['api', 'me', 'goals', '*', 'dod', 'approve'],
	['api', 'agent-approvals', '*', 'approve'],
	['api', 'agent-approvals', '*', 'reject'],
	['api', 'agent-approvals', 'approve-all']
];

/** Paths refused outright, even for a safe method. */
const FLEET_RUN_TOKEN_DENIED_PREFIXES: readonly string[] = ['/api/auth', '/api/fleet/jobs'];

function splitSegments(normalizedPath: string): string[] {
	return normalizedPath.split('/').filter((segment) => segment.length > 0);
}

function matchesShape(shape: readonly string[], segments: readonly string[]): boolean {
	return (
		shape.length === segments.length &&
		shape.every((part, index) => part === '*' || part === segments[index]?.toLowerCase())
	);
}

function isDeniedGateRoute(segments: readonly string[]): boolean {
	return FLEET_RUN_TOKEN_DENIED_GATE_ROUTES.some((shape) => matchesShape(shape, segments));
}

/** `/api/tasks/{id}` → `['api', 'tasks', '*']`, computed once. */
const FLEET_RUN_TOKEN_ROUTE_SHAPES: readonly { method: string; shape: readonly string[] }[] =
	FLEET_RUN_TOKEN_ROUTES.map((route) => ({
		method: route.method.toUpperCase(),
		shape: splitSegments(route.pathPattern).map((part) => (/^\{[^}]+\}$/.test(part) ? '*' : part.toLowerCase()))
	}));

/**
 * Whether a fleet-run token may be used on this request.
 *
 * Fail-closed on every axis: a malformed method or path is refused, and a
 * request is admitted only when its method AND every path segment match one
 * {@link FLEET_RUN_TOKEN_ROUTES} entry (`{param}` matches exactly one
 * non-empty segment; literal segments compare case-insensitively, like the
 * router). `HEAD` is judged as `GET`. Query strings and a trailing slash are
 * normalised away before matching, so `/api/tasks/x?y=1` and `/api/tasks/x/`
 * are judged as `/api/tasks/x`.
 *
 * A `..` (or `.`) SEGMENT is refused outright rather than resolved: a path
 * that needs resolving to be judged is a path the caller should not be
 * sending, and resolving it here would be a second, subtly different
 * normaliser sitting in front of the router's own. Dots inside a segment
 * (a KB path such as `notes..md`) are ordinary characters.
 */
export function isFleetRunTokenRouteAllowed(method: unknown, path: unknown): boolean {
	if (typeof method !== 'string' || typeof path !== 'string') return false;
	let verb = method.trim().toUpperCase();
	if (!verb) return false;
	if (verb === 'HEAD') verb = 'GET';

	const normalized = normalizeRoutePath(path);
	if (normalized === null) return false;

	for (const prefix of FLEET_RUN_TOKEN_DENIED_PREFIXES) {
		if (underPrefix(normalized.toLowerCase(), prefix)) return false;
	}
	const segments = splitSegments(normalized);
	// The segment veto and the gate routes run BEFORE the list can admit the
	// path, so a list entry can never reach a sub-resource carved out here.
	// Splitting on `/` means the match is exact per segment: a route named
	// `/api/works/{id}/terminal-history` is not caught by a substring test.
	for (const segment of segments) {
		if (FLEET_RUN_TOKEN_DENIED_SEGMENTS.has(segment.toLowerCase())) return false;
	}
	if (isDeniedGateRoute(segments)) return false;

	return FLEET_RUN_TOKEN_ROUTE_SHAPES.some((route) => route.method === verb && matchesShape(route.shape, segments));
}

/**
 * `/api/auth` matches `/api/auth` and `/api/auth/…` but NOT
 * `/api/authors`: a prefix that could straddle a path segment boundary
 * would refuse (or, worse, admit) a neighbouring route nobody reviewed.
 */
function underPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** `.` / `..`, literal or percent-encoded (`%2e`), as one whole path segment. */
function isDotSegment(segment: string): boolean {
	const decoded = segment.replace(/%2e/gi, '.');
	return decoded === '.' || decoded === '..';
}

/** Strip query/hash, collapse a trailing slash; `null` when unusable. */
function normalizeRoutePath(path: string): string | null {
	const trimmed = path.trim();
	if (!trimmed.startsWith('/')) return null;
	const withoutQuery = trimmed.split('?')[0]?.split('#')[0] ?? '';
	if (!withoutQuery.startsWith('/')) return null;
	if (withoutQuery.includes('//')) return null;
	// A dot SEGMENT (`..` or `.`, also percent-encoded) is refused outright;
	// dots inside a segment (`notes..md`, `v1.2`) are ordinary characters.
	if (withoutQuery.split('/').some(isDotSegment)) return null;
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
