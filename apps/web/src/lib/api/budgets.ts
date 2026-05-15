import 'server-only';
import { serverFetch } from './server-api';

export interface PerPluginSpend {
    pluginId: string;
    capability: 'ai' | 'search' | 'screenshot' | 'extractor';
    units: number;
    costCents: number;
}

export interface GlobalBudgetSummary {
    id: string;
    monthlyCapCents: number;
    allowOverage: boolean;
    currency: string;
    percentUsed: number;
}

export interface UsageSummary {
    workId: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    currency: string;
    totalSpendCents: number;
    perPlugin: PerPluginSpend[];
    globalBudget: GlobalBudgetSummary | null;
}

export interface DailySpendBucket {
    day: string;
    costCents: number;
}

export interface UsageTrend {
    workId: string;
    periodStart: string;
    periodEnd: string;
    granularity: 'day';
    buckets: DailySpendBucket[];
}

export const budgetsAPI = {
    getSummary: async (workId: string, period?: string): Promise<UsageSummary> => {
        const query = period ? `?period=${encodeURIComponent(period)}` : '';
        return serverFetch<UsageSummary>(`/works/${workId}/usage/summary${query}`);
    },

    getTrend: async (
        workId: string,
        period?: string,
        granularity: 'day' = 'day',
    ): Promise<UsageTrend> => {
        const params = new URLSearchParams();
        if (period) params.set('period', period);
        params.set('granularity', granularity);
        return serverFetch<UsageTrend>(`/works/${workId}/usage/trend?${params.toString()}`);
    },
};
