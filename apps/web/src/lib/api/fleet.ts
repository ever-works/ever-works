import 'server-only';
import type { FleetEnrollableNodeKind, FleetNodeView } from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Fleet (Wave 12, slice 1) — web client for the fleet node registry
 * (mounted at `/api/fleet` on the platform API — see
 * `apps/api/src/fleet/fleet.controller.ts`).
 *
 * Only the owner-scoped surface is wrapped here; the public
 * enroll/heartbeat endpoints are called by the node apps themselves,
 * never by this web tier. Credential material is asymmetric by design:
 * the enrollment token appears exactly once in the create response and
 * is never readable again.
 */

/**
 * Node kind/status and the node view are the SHARED contract
 * (`@ever-works/contracts`), re-exported here so this tier, the API and
 * the node apps compile against ONE declaration. This file used to
 * hand-copy them, which is exactly how the three copies drifted.
 */
import type {
    FleetAgentNodeAffinityView,
    FleetCostCeilingView,
    FleetAuditView,
    FleetCancelInFlightResult,
    FleetDrainAllResult,
    FleetKillSwitchChangeResult,
    FleetKillSwitchState,
    FleetNodeDetailView,
    FleetNodeDrainResult,
    FleetEnrollmentTokenView,
    FleetExecutionMode,
    FleetExecutionPreferenceView,
    FleetExecutionScopeType,
    FleetRunnerStatusView,
} from '@ever-works/contracts';

export type {
    FleetAgentNodeAffinityView,
    FleetCostCeilingView,
    FleetAuditView,
    FleetCancelInFlightResult,
    FleetDrainAllResult,
    FleetJobKind,
    FleetJobStatus,
    FleetJobView,
    FleetKillSwitchChangeResult,
    FleetKillSwitchState,
    FleetNodeKind,
    FleetNodeStatus,
    FleetNodeView,
    FleetNodeLoadView,
    FleetEnrollableNodeKind,
    FleetNodeDetailView,
    FleetNodeDrainResult,
    FleetEnrollmentTokenView,
    FleetExecutionMode,
    FleetExecutionPreferenceView,
    FleetExecutionScopeType,
    FleetRunnerNodeView,
    FleetRunnerStatusView,
} from '@ever-works/contracts';

/** Body of `POST /api/fleet/cancel-in-flight`. */
export interface CancelFleetInFlightPayload {
    /** Also fail queued jobs nothing has started. Default false. */
    includeQueued?: boolean;
}

export interface CreateFleetEnrollmentTokenPayload {
    name: string;
    kind: FleetEnrollableNodeKind;
}

export interface CreateFleetEnrollmentTokenResponse {
    node: FleetNodeView;
    /** Returned exactly once — the API stores only its hash. */
    token: string;
    expiresInSec: number;
}

export interface UpdateFleetNodePayload {
    name?: string;
    disabled?: boolean;
    /**
     * Soft drain: no new work is leased onto the node, but its in-flight
     * claims keep reporting and it keeps heartbeating so it stays
     * observable.
     *
     * `UpdateFleetNodeDto` and `FleetService.setPausedForUser` have
     * accepted this since pause shipped; this payload type simply never
     * declared it, so the web tier could not send it — a control that
     * existed end-to-end on the server and was unreachable from the UI.
     */
    paused?: boolean;
    /** Admin-edited tags. Writing them pins the set by default. */
    capabilities?: string[];
    /** `false` hands tag ownership back to the node's heartbeats. */
    capabilitiesPinned?: boolean;
    /**
     * Fleet cost accounting (EW-777) — this node's daily (UTC) model-spend
     * ceiling in cents; `null` clears it back to the deployment default.
     * Crossing it drains the node until it is re-enabled.
     */
    dailyCostCeilingCents?: number | null;
}

export interface SetFleetExecutionPreferencePayload {
    scopeType: FleetExecutionScopeType;
    /** Required for 'work'/'goal'; omitted for the account-wide row. */
    scopeId?: string;
    mode: FleetExecutionMode;
}

// NOTE: no leading `/api` here — `serverFetch`/`serverMutation` prepend
// `API_URL`, which `lib/constants.ts` normalises to already end in
// `/api`. Matches every other helper in this folder.
const BASE = '/fleet';

export const fleetAPI = {
    listNodes: async () => {
        return serverFetch<FleetNodeView[]>(`${BASE}/nodes`);
    },

    createEnrollmentToken: async (payload: CreateFleetEnrollmentTokenPayload) => {
        return serverMutation<CreateFleetEnrollmentTokenResponse>({
            endpoint: `${BASE}/nodes/enrollment-token`,
            data: payload,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateNode: async (nodeId: string, payload: UpdateFleetNodePayload) => {
        return serverMutation<FleetNodeView>({
            endpoint: `${BASE}/nodes/${nodeId}`,
            data: payload,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    deleteNode: async (nodeId: string) => {
        return serverMutation<void>({
            endpoint: `${BASE}/nodes/${nodeId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    nodeDetail: async (nodeId: string) => {
        return serverFetch<FleetNodeDetailView>(`${BASE}/nodes/${nodeId}`);
    },

    listOutstandingTokens: async () => {
        return serverFetch<FleetEnrollmentTokenView[]>(`${BASE}/enrollment-tokens`);
    },

    revokeEnrollmentToken: async (nodeId: string) => {
        return serverMutation<void>({
            endpoint: `${BASE}/enrollment-tokens/${nodeId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /** Re-key a node. The replacement token is returned exactly once. */
    rotateNodeCredential: async (nodeId: string) => {
        return serverMutation<CreateFleetEnrollmentTokenResponse>({
            endpoint: `${BASE}/nodes/${nodeId}/rotate`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Compact runner status behind the always-visible sidebar pill.
     *
     * A narrower read than `listNodes` on purpose: it is polled every 30s
     * from every dashboard page, and it excludes cluster-sourced nodes,
     * which are not runners the platform can lease work onto.
     */
    runnerStatus: async () => {
        return serverFetch<FleetRunnerStatusView>(`${BASE}/runner-status`);
    },

    listExecutionPreferences: async () => {
        return serverFetch<FleetExecutionPreferenceView[]>(`${BASE}/execution-preferences`);
    },

    setExecutionPreference: async (payload: SetFleetExecutionPreferencePayload) => {
        return serverMutation<FleetExecutionPreferenceView>({
            endpoint: `${BASE}/execution-preference`,
            data: payload,
            method: 'PUT',
            wrapInData: false,
        });
    },

    clearExecutionPreference: async (
        scopeType: FleetExecutionScopeType,
        scopeId?: string | null,
    ) => {
        const query = new URLSearchParams({ scopeType });
        if (scopeId) query.set('scopeId', scopeId);
        return serverMutation<void>({
            endpoint: `${BASE}/execution-preference?${query.toString()}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    drainNode: async (nodeId: string, drain: boolean) => {
        return serverMutation<FleetNodeDrainResult>({
            endpoint: `${BASE}/nodes/${nodeId}/drain`,
            data: { drain },
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Fleet cost accounting (EW-777) — the account's fleet-wide daily
     * model-spend ceiling, with the deployment default it falls back to
     * and today's spend across every node.
     */
    getCostCeiling: async () => {
        return serverFetch<FleetCostCeilingView>(`${BASE}/cost-ceiling`);
    },

    /** `null` clears the owner's ceiling back to the deployment default. */
    setCostCeiling: async (dailyCeilingCents: number | null) => {
        return serverMutation<FleetCostCeilingView>({
            endpoint: `${BASE}/cost-ceiling`,
            data: { dailyCeilingCents },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /**
     * Panic controls (EW-778). Draining and cancelling are two routes on
     * purpose — stopping new work is not killing running work — and the
     * stop flag is READ here by any session while SET/CLEAR are platform-
     * admin routes (the API answers 403 for everyone else).
     */
    drainAll: async () => {
        return serverMutation<FleetDrainAllResult>({
            endpoint: `${BASE}/drain-all`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    cancelInFlight: async (payload: CancelFleetInFlightPayload = {}) => {
        return serverMutation<FleetCancelInFlightResult>({
            endpoint: `${BASE}/cancel-in-flight`,
            data: { includeQueued: payload.includeQueued === true },
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Polled by the fleet page banner; a read, so no cache invalidation. */
    killSwitchState: async () => {
        return serverFetch<FleetKillSwitchState>(`${BASE}/kill-switch`);
    },

    stopKillSwitch: async (reason?: string | null) => {
        return serverMutation<FleetKillSwitchChangeResult>({
            endpoint: `${BASE}/kill-switch/stop`,
            data: reason ? { reason } : {},
            method: 'POST',
            wrapInData: false,
        });
    },

    clearKillSwitch: async () => {
        return serverMutation<FleetKillSwitchChangeResult>({
            endpoint: `${BASE}/kill-switch/clear`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    killSwitchAudit: async (limit?: number) => {
        const query = typeof limit === 'number' && limit > 0 ? `?limit=${Math.trunc(limit)}` : '';
        return serverFetch<FleetAuditView[]>(`${BASE}/kill-switch/audit${query}`);
    },

    /**
     * Agent-to-node affinity (`FleetAgentAffinityController`, mounted at
     * `/api/fleet/agents/:agentId/node-affinity`).
     *
     * A separate resource rather than a field on `PATCH /api/agents/:id`
     * because the binding is scoped by the ACTIVE Organization (the
     * request's scope header) on top of the owner, while the Agent row
     * itself is owner-scoped only. The API answers `null` (not 404) for
     * an unbound Agent, and 400 when the request carries no Organization
     * scope — personal workspaces cannot pin an Agent to a node.
     *
     * The agent id reaches these helpers from a Server Action argument,
     * i.e. from the browser. It is encoded as ONE path segment (as
     * `agents.ts` does for slugs) so a crafted value carrying `/` or `..`
     * cannot be dot-segment-normalised by `fetch` onto a different
     * `/api/*` route under the caller's own bearer. The API's
     * `ParseUUIDPipe` rejects it anyway; this keeps the request from
     * leaving for the wrong route in the first place.
     */
    getAgentAffinity: async (agentId: string) => {
        const affinity = await serverFetch<FleetAgentNodeAffinityView | null | undefined>(
            `${BASE}/agents/${encodeURIComponent(agentId)}/node-affinity`,
        );
        // `serverFetch` collapses an empty body to `undefined`; the wire
        // answer for "unbound" is a JSON `null`. Both mean the same here.
        return affinity ?? null;
    },

    setAgentAffinity: async (agentId: string, nodeId: string) => {
        return serverMutation<FleetAgentNodeAffinityView>({
            endpoint: `${BASE}/agents/${encodeURIComponent(agentId)}/node-affinity`,
            data: { nodeId },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /** Idempotent — clearing an unbound Agent is a no-op on the API. */
    clearAgentAffinity: async (agentId: string) => {
        return serverMutation<void>({
            endpoint: `${BASE}/agents/${encodeURIComponent(agentId)}/node-affinity`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
