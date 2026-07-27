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
export type {
    FleetNodeKind,
    FleetNodeStatus,
    FleetNodeView,
    FleetNodeLoadView,
    FleetEnrollableNodeKind,
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
};
