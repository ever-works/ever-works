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
    FleetJobKind,
    FleetJobStatus,
    FleetJobView,
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
     * Agent-to-node affinity (`FleetAgentAffinityController`, mounted at
     * `/api/fleet/agents/:agentId/node-affinity`).
     *
     * A separate resource rather than a field on `PATCH /api/agents/:id`
     * because the binding is scoped by the ACTIVE Organization (the
     * request's scope header) on top of the owner, while the Agent row
     * itself is owner-scoped only. The API answers `null` (not 404) for
     * an unbound Agent, and 400 when the request carries no Organization
     * scope — personal workspaces cannot pin an Agent to a node.
     */
    getAgentAffinity: async (agentId: string) => {
        const affinity = await serverFetch<FleetAgentNodeAffinityView | null | undefined>(
            `${BASE}/agents/${agentId}/node-affinity`,
        );
        // `serverFetch` collapses an empty body to `undefined`; the wire
        // answer for "unbound" is a JSON `null`. Both mean the same here.
        return affinity ?? null;
    },

    setAgentAffinity: async (agentId: string, nodeId: string) => {
        return serverMutation<FleetAgentNodeAffinityView>({
            endpoint: `${BASE}/agents/${agentId}/node-affinity`,
            data: { nodeId },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /** Idempotent — clearing an unbound Agent is a no-op on the API. */
    clearAgentAffinity: async (agentId: string) => {
        return serverMutation<void>({
            endpoint: `${BASE}/agents/${agentId}/node-affinity`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
