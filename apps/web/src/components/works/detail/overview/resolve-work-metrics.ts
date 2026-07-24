import type { WorkMetricId, WorkMetricValue } from '@ever-works/contracts';

/**
 * The counts the Work detail page already has in hand.
 *
 * These ride on the Work payload as denormalized columns refreshed by
 * `DataGeneratorService.refreshDataCache`, so resolving them costs nothing —
 * no extra request, no loading state.
 */
export interface WorkMetricInputs {
    readonly itemsCount: number;
    readonly categoriesCount: number;
    readonly tagsCount: number;
    readonly comparisonsCount: number;
    readonly createdAt: string;
    readonly hasDeployment: boolean;
    readonly generationStatusLabel: string;
    readonly deployStatusLabel: string;
}

/**
 * Metrics that need a connected metrics-provider plugin (analytics).
 *
 * Reporting these as `0` would be a lie that reads as a broken product —
 * "0 page views" and "we have no idea how many page views" are very
 * different statements. They resolve to `not_configured` so the tile can
 * offer a "connect analytics" affordance instead of a fake number.
 */
const PROVIDER_BACKED: ReadonlySet<WorkMetricId> = new Set<WorkMetricId>([
    'page-views',
    'sessions',
    'conversions',
]);

/**
 * Metrics that are a cheap `COUNT(*)` server-side but are not carried on the
 * Work payload. Until `GET /works/:id/metrics` lands they resolve to
 * `not_configured` rather than rendering a wrong number.
 */
const SERVER_RESOLVED: ReadonlySet<WorkMetricId> = new Set<WorkMetricId>([
    'registered-users',
    'team-members',
    'agents',
    'open-tasks',
    'works-owned',
]);

function daysSince(iso: string): number {
    const created = new Date(iso).getTime();
    if (!Number.isFinite(created)) {
        return 0;
    }
    return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
}

/**
 * Resolve one metric from data already on the page.
 *
 * Never throws: a Work detail page must render even when a single tile
 * cannot be computed.
 */
export function resolveWorkMetric(id: WorkMetricId, inputs: WorkMetricInputs): WorkMetricValue {
    // Both groups report `not_configured` today, for different reasons:
    // provider-backed metrics need an analytics plugin connected to the
    // Work, server-resolved metrics need `GET /works/:id/metrics` (not yet
    // shipped). The distinction is kept as two sets rather than collapsed
    // into one, because only the provider group will keep this state once
    // the endpoint lands — the server-resolved group becomes `ok`.
    if (PROVIDER_BACKED.has(id) || SERVER_RESOLVED.has(id)) {
        return { id, state: 'not_configured' };
    }

    switch (id) {
        case 'total-items':
        case 'posts':
            return { id, state: 'ok', value: inputs.itemsCount };
        case 'categories':
            return { id, state: 'ok', value: inputs.categoriesCount };
        case 'tags':
            return { id, state: 'ok', value: inputs.tagsCount };
        case 'comparisons':
            return { id, state: 'ok', value: inputs.comparisonsCount };
        case 'generation-status':
            return { id, state: 'ok', value: inputs.generationStatusLabel };
        case 'deploy-status':
            return inputs.hasDeployment
                ? { id, state: 'ok', value: inputs.deployStatusLabel }
                : { id, state: 'not_deployed' };
        case 'days-active':
            return { id, state: 'ok', value: daysSince(inputs.createdAt) };
        default:
            return { id, state: 'error' };
    }
}

export function resolveWorkMetrics(
    ids: readonly WorkMetricId[],
    inputs: WorkMetricInputs,
): WorkMetricValue[] {
    return ids.map((id) => resolveWorkMetric(id, inputs));
}
