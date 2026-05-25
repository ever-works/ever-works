import 'server-only';
import { serverFetch } from './server-api';

/**
 * Phase 7 PR II — wire-format type for the new account-wide
 * spend endpoint (`GET /me/usage/account-wide`). Mirrors the
 * agent's `UserBudgetSummary` shape; kept here to avoid a
 * runtime dep on the agent package from apps/web.
 */
export interface AccountWideUsage {
    userId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
}

export const usageAPI = {
    /**
     * Phase 7 PR II — current-month account-wide spend + cap
     * status. Used by the Dashboard `Month Spend` tile (spec
     * §5.1) which clicks through to the cap settings.
     */
    async accountWide(): Promise<AccountWideUsage> {
        return serverFetch<AccountWideUsage>('/me/usage/account-wide', { method: 'GET' });
    },
};
