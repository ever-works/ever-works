import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type { AppProvisioningState } from '@/lib/works/app-provisioning.shared';

/**
 * APW-04 T25 (client half) — server-only client for the provisioning routes
 * (`apps/api/src/works/work-evolve.controller.ts`):
 *
 *   - `GET  /api/works/:id/provisioning`      → {@link AppProvisioningState} (view)
 *   - `POST /api/works/:id/provision`         → `202` start / re-provision (edit)
 *   - `POST /api/works/:id/provision/cancel`  → `202` {@link AppProvisioningCancelAnswer} (edit)
 *
 * A refusal arrives as a thrown `ApiResponseError` with its `statusCode` and `code`
 * intact; the server actions pass them to the card, which owns the copy.
 *
 * NO leading `/api` in the paths: `serverFetch` / `serverMutation` prepend `API_URL`,
 * which already ends in `/api`.
 */

/** What `POST provision` answers (the service's result, plus the route's two fields). */
export interface AppProvisioningStartAnswer {
    status: 'started' | 'refused';
    deduplicated: boolean;
    started: boolean;
    reason: string | null;
    taskId?: string | null;
    taskSlug?: string | null;
    awaitingOwner?: boolean;
}

/** What `POST provision/cancel` answers. */
export interface AppProvisioningCancelAnswer {
    status: 'cancelled' | 'refused';
    code?: string;
    taskId: string | null;
    alreadyCancelled: boolean;
    cancelledRunIds: string[];
}

/** The body of `POST provision` the card sends. */
export interface AppProvisioningStartBody {
    /** File a new Task even while one is open (the running-provisioning variant of the dialog). */
    restart?: boolean;
    note?: string;
}

const base = (workId: string) => `/works/${encodeURIComponent(workId)}`;

export const appProvisioningAPI = {
    get: async (workId: string): Promise<AppProvisioningState> =>
        serverFetch<AppProvisioningState>(`${base(workId)}/provisioning`),

    start: async (
        workId: string,
        body: AppProvisioningStartBody = {},
    ): Promise<AppProvisioningStartAnswer> =>
        serverMutation<AppProvisioningStartAnswer>({
            endpoint: `${base(workId)}/provision`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    cancel: async (workId: string): Promise<AppProvisioningCancelAnswer> =>
        serverMutation<AppProvisioningCancelAnswer>({
            endpoint: `${base(workId)}/provision/cancel`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
};
