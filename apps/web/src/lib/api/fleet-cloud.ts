import 'server-only';
import type {
    FleetCloudCreateRequest,
    FleetCloudCreateResponse,
    FleetCloudIdlePolicy,
    FleetCloudListView,
    FleetCloudOperationResponse,
    FleetCloudOptionsView,
    FleetCloudPowerAction,
    FleetCloudProvidersView,
    FleetCloudUsageView,
    FleetNodeView,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Cloud computers (FL-17) — the web client for `/api/fleet/providers` and
 * `/api/fleet/cloud` (`apps/api/src/fleet/cloud/`). The CONTRACTS §2.2
 * confirmation fields are forwarded verbatim: the API decides the class and
 * verifies the acknowledged price; the dialog only echoes them.
 */
export const fleetCloudAPI = {
    providers: async () => serverFetch<FleetCloudProvidersView>('/fleet/providers'),

    options: async (pluginId: string) =>
        serverFetch<FleetCloudOptionsView>(
            `/fleet/providers/${encodeURIComponent(pluginId)}/options`,
        ),

    list: async () => serverFetch<FleetCloudListView & FleetCloudProvidersView>('/fleet/cloud'),

    usage: async () => serverFetch<FleetCloudUsageView>('/fleet/cloud/usage'),

    create: async (body: FleetCloudCreateRequest) =>
        serverMutation<FleetCloudCreateResponse>({
            endpoint: '/fleet/cloud',
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    power: async (nodeId: string, action: FleetCloudPowerAction, confirm: boolean) =>
        serverMutation<FleetCloudOperationResponse>({
            endpoint: `/fleet/cloud/${encodeURIComponent(nodeId)}/power`,
            data: { action, ...(confirm ? { confirm: true } : {}) },
            method: 'POST',
            wrapInData: false,
        }),

    /** P2 (spec FR-25) — nothing · tell me after N h · power off after N h; N 1–72. */
    setIdlePolicy: async (nodeId: string, policy: FleetCloudIdlePolicy) =>
        serverMutation<FleetNodeView>({
            endpoint: `/fleet/cloud/${encodeURIComponent(nodeId)}/idle-policy`,
            data: { mode: policy.mode, afterHours: policy.afterHours },
            method: 'PUT',
            wrapInData: false,
        }),

    /** P2 (spec S6) — the idle window starts again now. */
    keepRunning: async (nodeId: string) =>
        serverMutation<FleetNodeView>({
            endpoint: `/fleet/cloud/${encodeURIComponent(nodeId)}/keep-running`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),

    destroy: async (nodeId: string, confirmName: string | undefined) =>
        serverMutation<FleetCloudOperationResponse>({
            endpoint: `/fleet/cloud/${encodeURIComponent(nodeId)}/destroy`,
            data: confirmName !== undefined ? { confirmName } : {},
            method: 'POST',
            wrapInData: false,
        }),
};
