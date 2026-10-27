import 'server-only';
import type {
    FleetUsagePeriodDays,
    FleetUsagePricesView,
    FleetUsageRescanResult,
    FleetUsageTaskCostsView,
    FleetUsageView,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Usage & cost on the fleet (FL-20) — the web client for `/api/fleet/usage`
 * (`apps/api/src/fleet/usage/`). Every route 404s unless
 * `FLEET_USAGE_SCAN_ENABLED`; refusals carry the CONTRACTS §8 envelope.
 */
export interface FleetUsageQuery {
    days?: FleetUsagePeriodDays;
    node?: string | null;
    model?: string | null;
    /** P2 — one Agent's work only (the Agent page's Budgets tab). */
    agent?: string | null;
}

function query(input: FleetUsageQuery): string {
    const params = new URLSearchParams();
    if (input.days) params.set('days', String(input.days));
    if (input.node) params.set('node', input.node);
    if (input.model) params.set('model', input.model);
    if (input.agent) params.set('agent', input.agent);
    const text = params.toString();
    return text ? `?${text}` : '';
}

export const fleetUsageAPI = {
    view: async (input: FleetUsageQuery = {}) =>
        serverFetch<FleetUsageView>(`/fleet/usage${query(input)}`),

    prices: async () => serverFetch<FleetUsagePricesView>('/fleet/usage/prices'),

    /** P2 — recurring Tasks' last-run and 30-day cost (the schedule rows). */
    taskCosts: async (taskIds: readonly string[]) =>
        serverFetch<FleetUsageTaskCostsView>(
            `/fleet/usage/tasks?ids=${encodeURIComponent(taskIds.join(','))}`,
        ),

    rescan: async (nodeId: string) =>
        serverMutation<FleetUsageRescanResult>({
            endpoint: '/fleet/usage/rescan',
            data: { nodeId },
            method: 'POST',
            wrapInData: false,
        }),
};
