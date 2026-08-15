import 'server-only';
import { serverFetch } from './server-api';
import {
    buildCostsQuery,
    type CostsByAgent,
    type CostsByModel,
    type CostsDaily,
    type CostsSummary,
    type CostsTopRuns,
    type CostsWindowDays,
} from './costs.shared';

export type { CostsByAgent, CostsByModel, CostsDaily, CostsSummary, CostsTopRuns, CostsWindowDays };

/**
 * Costs dashboard — server-side wrappers over `GET /api/usage/costs/*`.
 *
 * Endpoints deliberately do NOT start with `/api`: serverFetch prepends
 * `API_URL`, which is normalized to end in `/api` (see the
 * double-prefix regression specs beside the other lib/api wrappers).
 */
export const costsAPI = {
    /** Headline total + run count + average cost per run. */
    async summary(params: { windowDays?: CostsWindowDays } = {}): Promise<CostsSummary> {
        return serverFetch<CostsSummary>(`/usage/costs/summary${buildCostsQuery(params)}`, {
            method: 'GET',
        });
    },

    /** Daily spend for the window, stacked by Agent. */
    async daily(params: { windowDays?: CostsWindowDays } = {}): Promise<CostsDaily> {
        return serverFetch<CostsDaily>(`/usage/costs/daily${buildCostsQuery(params)}`, {
            method: 'GET',
        });
    },

    /** Per-Agent spend, run count and average cost per run. */
    async byAgent(params: { windowDays?: CostsWindowDays } = {}): Promise<CostsByAgent> {
        return serverFetch<CostsByAgent>(`/usage/costs/by-agent${buildCostsQuery(params)}`, {
            method: 'GET',
        });
    },

    /** Per-model spend with each model's share of the window total. */
    async byModel(params: { windowDays?: CostsWindowDays } = {}): Promise<CostsByModel> {
        return serverFetch<CostsByModel>(`/usage/costs/by-model${buildCostsQuery(params)}`, {
            method: 'GET',
        });
    },

    /** The window's most expensive runs. */
    async topRuns(
        params: { windowDays?: CostsWindowDays; limit?: number } = {},
    ): Promise<CostsTopRuns> {
        return serverFetch<CostsTopRuns>(`/usage/costs/top-runs${buildCostsQuery(params)}`, {
            method: 'GET',
        });
    },
};
