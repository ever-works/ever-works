import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export type BudgetScope = 'global' | 'plugin';

export interface WorkBudget {
    id: string;
    workId: string;
    scope: BudgetScope;
    pluginId: string | null;
    monthlyCapCents: number;
    currency: string;
    allowOverage: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateBudgetInput {
    scope: BudgetScope;
    pluginId?: string;
    monthlyCapCents: number;
    allowOverage?: boolean;
    currency?: string;
}

export interface UpdateBudgetInput {
    monthlyCapCents?: number;
    allowOverage?: boolean;
    currency?: string;
}

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

    list: async (workId: string): Promise<{ budgets: WorkBudget[] }> => {
        return serverFetch<{ budgets: WorkBudget[] }>(`/works/${workId}/budgets`);
    },

    create: async (workId: string, data: CreateBudgetInput): Promise<{ budget: WorkBudget }> => {
        return serverMutation<{ budget: WorkBudget }>({
            endpoint: `/works/${workId}/budgets`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    update: async (
        workId: string,
        budgetId: string,
        data: UpdateBudgetInput,
    ): Promise<{ budget: WorkBudget }> => {
        return serverMutation<{ budget: WorkBudget }>({
            endpoint: `/works/${workId}/budgets/${budgetId}`,
            data,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    remove: async (workId: string, budgetId: string): Promise<{ deletedId: string }> => {
        return serverMutation<{ deletedId: string }>({
            endpoint: `/works/${workId}/budgets/${budgetId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};

export interface AdminUsageRow {
    userId: string;
    username: string;
    email: string | null;
    workId: string;
    workName: string;
    units: number;
    costCents: number;
}

export interface AdminUsageResponse {
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    totalSpendCents: number;
    rows: AdminUsageRow[];
}

export const adminUsageAPI = {
    list: async (period?: string): Promise<AdminUsageResponse> => {
        const query = period ? `?period=${encodeURIComponent(period)}` : '';
        return serverFetch<AdminUsageResponse>(`/admin/usage${query}`);
    },
};
