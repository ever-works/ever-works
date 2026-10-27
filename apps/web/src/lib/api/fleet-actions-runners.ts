import 'server-only';
import type {
    FleetActionsCancelRunRequest,
    FleetActionsJobsView,
    FleetActionsRunnerScope,
    FleetActionsRunnersPermissionView,
    FleetActionsWatchedTarget,
    FleetActionsRunnerInstallRequest,
    FleetActionsRunnerInstallResponse,
    FleetActionsRunnerOperationResponse,
    FleetActionsRunnerOptionsView,
    FleetActionsRunnersListView,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Actions runners on computers (FL-18 P1) — the web client for
 * `/api/fleet/nodes/:id/runners/**` (`apps/api/src/fleet/runners/`). The
 * CONTRACTS §2.2 confirmation fields are forwarded verbatim: the API decides
 * the class and answers 409 `confirmation_required` with the summary; the
 * dialogs only echo them. Off (`FLEET_ACTIONS_RUNNERS_ENABLED` unset) every
 * route answers 404.
 */

function base(nodeId: string): string {
    return `/fleet/nodes/${encodeURIComponent(nodeId)}/runners`;
}

/** The acts `POST …/runners/:runnerId/:action` takes from the web in P1 (remove has its own route). */
export type FleetActionsRunnerWebControl = 'start' | 'stop' | 'restart';

export const fleetActionsRunnersAPI = {
    list: async (nodeId: string) => serverFetch<FleetActionsRunnersListView>(base(nodeId)),

    options: async (nodeId: string) =>
        serverFetch<FleetActionsRunnerOptionsView>(`${base(nodeId)}/options`),

    install: async (nodeId: string, body: FleetActionsRunnerInstallRequest) =>
        serverMutation<FleetActionsRunnerInstallResponse>({
            endpoint: base(nodeId),
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    control: async (
        nodeId: string,
        runnerId: string,
        action: FleetActionsRunnerWebControl,
        confirm: boolean,
    ) =>
        serverMutation<FleetActionsRunnerOperationResponse>({
            endpoint: `${base(nodeId)}/${encodeURIComponent(runnerId)}/${action}`,
            data: confirm ? { confirm: true } : {},
            method: 'POST',
            wrapInData: false,
        }),

    remove: async (nodeId: string, runnerId: string, confirmName: string | undefined) =>
        serverMutation<FleetActionsRunnerOperationResponse>({
            endpoint: `${base(nodeId)}/${encodeURIComponent(runnerId)}/remove`,
            data: confirmName !== undefined ? { confirmName } : {},
            method: 'POST',
            wrapInData: false,
        }),
};

/** What `PUT /api/fleet/runners/jobs/watched` answers: the list the panel watches now (the default after `[]`). */
export interface FleetActionsWatchedTargetsResponse {
    watched: FleetActionsWatchedTarget[];
}

/**
 * Actions jobs (FL-18 P2, FR-20 – FR-26) — the web client for
 * `/api/fleet/runners/jobs/**`: the hub panel's read, the watched list, the
 * workflow-run cancel (CONTRACTS §2.2 `confirm`, forwarded verbatim) and the
 * organisation permission check behind **Grant access**. Off, every route
 * answers 404.
 */
export const fleetActionsJobsAPI = {
    jobs: async () => serverFetch<FleetActionsJobsView>('/fleet/runners/jobs'),

    setWatched: async (targets: FleetActionsWatchedTarget[]) =>
        serverMutation<FleetActionsWatchedTargetsResponse>({
            endpoint: '/fleet/runners/jobs/watched',
            data: { targets },
            method: 'PUT',
            wrapInData: false,
        }),

    cancelRun: async (body: FleetActionsCancelRunRequest) =>
        serverMutation<Record<string, unknown>>({
            endpoint: '/fleet/runners/jobs/cancel',
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    permission: async (scope: FleetActionsRunnerScope, target: string) =>
        serverFetch<FleetActionsRunnersPermissionView>(
            `/fleet/runners/jobs/permission?scope=${encodeURIComponent(scope)}&target=${encodeURIComponent(target)}`,
        ),
};
