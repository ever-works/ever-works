import 'server-only';
import { serverFetch } from './server-api';
import {
    buildLedgerQuery,
    buildUsageSummaryQuery,
    type CreditLedgerKind,
    type CreditsBalance,
    type CreditsLedgerPage,
    type SubscriptionPlanList,
    type SubscriptionPlanSummary,
    type UsageSummaryGroupBy,
    type UsageSummaryGrouped,
    type UsageSummaryTotals,
} from './credits.shared';

export type {
    CreditLedgerKind,
    CreditsBalance,
    CreditsLedgerPage,
    SubscriptionPlanList,
    SubscriptionPlanSummary,
    UsageSummaryGroupBy,
    UsageSummaryGrouped,
    UsageSummaryTotals,
};

/**
 * Billing + Usage & Credits (Wave 13) — server-side wrappers over the
 * read-only credits + subscriptions surfaces. Endpoints deliberately
 * do NOT start with `/api` (serverFetch prepends `API_URL`, which is
 * normalized to end in `/api` — see the double-prefix regression specs
 * beside the other lib/api wrappers).
 */
export const creditsAPI = {
    /** Current credits balance for the signed-in user. */
    async balance(): Promise<CreditsBalance> {
        return serverFetch<CreditsBalance>('/credits/balance', { method: 'GET' });
    },

    /** Paginated credits ledger (period YYYY-MM + kind filters). */
    async ledger(
        params: {
            period?: string;
            kinds?: readonly CreditLedgerKind[];
            page?: number;
            pageSize?: number;
        } = {},
    ): Promise<CreditsLedgerPage> {
        return serverFetch<CreditsLedgerPage>(`/credits/ledger${buildLedgerQuery(params)}`, {
            method: 'GET',
        });
    },

    /** §4.1/§4.2 stat-tile totals for a period (default: current month). */
    async usageSummary(params: { period?: string } = {}): Promise<UsageSummaryTotals> {
        return serverFetch<UsageSummaryTotals>(
            `/credits/usage-summary${buildUsageSummaryQuery(params)}`,
            { method: 'GET' },
        );
    },

    /** §4.3 grouped chart rows (day / model / agent / work). */
    async usageGrouped(params: {
        groupBy: UsageSummaryGroupBy;
        period?: string;
    }): Promise<UsageSummaryGrouped> {
        return serverFetch<UsageSummaryGrouped>(
            `/credits/usage-summary${buildUsageSummaryQuery(params)}`,
            { method: 'GET' },
        );
    },
};

export const subscriptionsAPI = {
    /** Current plan (existing endpoint — `enabled` carries degraded state). */
    async currentPlan(): Promise<SubscriptionPlanSummary> {
        return serverFetch<SubscriptionPlanSummary>('/subscriptions/plan', { method: 'GET' });
    },

    /** All active plans for the credits-forward switcher (Wave 13). */
    async listPlans(): Promise<SubscriptionPlanList> {
        return serverFetch<SubscriptionPlanList>('/subscriptions/plans', { method: 'GET' });
    },

    /**
     * Self-service plan change — free plans only BY DESIGN (EW-711 #23);
     * a paid plan must be activated through a billing-verified path.
     */
    async changePlan(planCode: string): Promise<SubscriptionPlanSummary> {
        return serverFetch<SubscriptionPlanSummary>('/subscriptions/plan', {
            method: 'POST',
            body: JSON.stringify({ planCode }),
        });
    },
};
