import 'server-only';
import type {
    FleetUsagePeriodDays,
    FleetUsagePricesView,
    FleetUsageRescanResult,
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
}

function query(input: FleetUsageQuery): string {
    const params = new URLSearchParams();
    if (input.days) params.set('days', String(input.days));
    if (input.node) params.set('node', input.node);
    if (input.model) params.set('model', input.model);
    const text = params.toString();
    return text ? `?${text}` : '';
}

export const fleetUsageAPI = {
    view: async (input: FleetUsageQuery = {}) => serverFetch<FleetUsageView>(`/fleet/usage${query(input)}`),

    prices: async () => serverFetch<FleetUsagePricesView>('/fleet/usage/prices'),

    rescan: async (nodeId: string) =>
        serverMutation<FleetUsageRescanResult>({
            endpoint: '/fleet/usage/rescan',
            data: { nodeId },
            method: 'POST',
            wrapInData: false,
        }),
};
