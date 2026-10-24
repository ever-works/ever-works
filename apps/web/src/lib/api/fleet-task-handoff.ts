import 'server-only';
import type {
    FleetGitIdentity,
    FleetGitIdentitySetResult,
    FleetSessionListResponse,
    FleetTaskHandoffOptions,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

// NOTE: no leading `/api` here — `serverFetch` prepends `API_URL`, which
// already ends in `/api` (see `lib/api/fleet.ts`).
const BASE = '/fleet';

/**
 * Tasks on computers (FL-15, CONTRACTS §11.2) — the server-side reads of the
 * hand-off: the dialog's options and the Task's latest session on a
 * computer (the Task page's Computer block). The start is FL-04's session
 * BFF route with `taskId` (one start path).
 */
export const fleetTaskHandoffAPI = {
    /** `GET /api/fleet/tasks/:taskId/handoff-options[?agentId=]`. */
    options: async (taskId: string, agentId?: string | null): Promise<FleetTaskHandoffOptions> =>
        serverFetch<FleetTaskHandoffOptions>(
            `${BASE}/tasks/${encodeURIComponent(taskId)}/handoff-options${
                agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
            }`,
            { method: 'GET' },
        ),

    /** FL-15 P2: a computer's global git identity (`?fresh=1` reads the machine again). */
    gitIdentity: async (nodeId: string, fresh = false): Promise<FleetGitIdentity> =>
        serverFetch<FleetGitIdentity>(
            `${BASE}/nodes/${encodeURIComponent(nodeId)}/git/identity${fresh ? '?fresh=1' : ''}`,
            { method: 'GET' },
        ),

    /** FL-15 P2: **Use my Ever Works identity** — `confirmation_required` until `confirm` is true. */
    setGitIdentity: async (nodeId: string, confirm: boolean): Promise<FleetGitIdentitySetResult> =>
        serverMutation<FleetGitIdentitySetResult>({
            endpoint: `${BASE}/nodes/${encodeURIComponent(nodeId)}/git/identity`,
            data: confirm ? { confirm: true } : {},
            method: 'POST',
            wrapInData: false,
        }),

    /** The Task's sessions on computers, latest first (`GET /api/fleet/sessions?taskId=&limit=`). */
    sessionsForTask: async (taskId: string, limit = 1): Promise<FleetSessionListResponse> =>
        serverFetch<FleetSessionListResponse>(
            `${BASE}/sessions?taskId=${encodeURIComponent(taskId)}&limit=${limit}`,
            { method: 'GET' },
        ),
};
