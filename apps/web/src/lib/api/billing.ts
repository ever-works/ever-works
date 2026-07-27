import 'server-only';
import { serverFetch } from './server-api';
import type {
    BillingOverview,
    CreditCheckoutResponse,
    InvoiceListPage,
    PlanCheckoutResponse,
    PlanCheckoutReturnResponse,
} from './billing.shared';

export type {
    BillingOverview,
    CreditCheckoutResponse,
    InvoiceListPage,
    PlanCheckoutResponse,
    PlanCheckoutReturnResponse,
};

/**
 * The money path (billing PRD B5) — server-side wrappers over
 * `/api/billing/*` and `/api/credits/checkout`.
 *
 * Endpoints deliberately do NOT start with `/api` (serverFetch prepends
 * `API_URL`, which is normalized to end in `/api` — see the
 * double-prefix regression specs beside the other lib/api wrappers).
 */
export const billingAPI = {
    /** One round-trip snapshot for the Billing page. */
    async overview(): Promise<BillingOverview> {
        return serverFetch<BillingOverview>('/billing/overview', { method: 'GET' });
    },

    /** Owner-scoped invoice history, newest-first. */
    async invoices(params: { page?: number; pageSize?: number } = {}): Promise<InvoiceListPage> {
        const search = new URLSearchParams();
        if (params.page && params.page > 1) {
            search.set('page', String(params.page));
        }
        if (params.pageSize) {
            search.set('pageSize', String(params.pageSize));
        }
        const qs = search.toString();
        return serverFetch<InvoiceListPage>(`/billing/invoices${qs ? `?${qs}` : ''}`, {
            method: 'GET',
        });
    },

    /**
     * Start a credit top-up. The body carries a PACK ID only — the API
     * prices it from its own table and rejects any amount field.
     */
    async startCreditCheckout(packId: string): Promise<CreditCheckoutResponse> {
        return serverFetch<CreditCheckoutResponse>('/credits/checkout', {
            method: 'POST',
            body: JSON.stringify({ packId }),
        });
    },

    /**
     * Start a paid-plan checkout (audit B24). The body carries a PLAN
     * CODE (and optionally an org the caller belongs to) — the API prices
     * it from `subscription_plans` and rejects any price field. The
     * return URLs are built by the API from `WEB_URL`, never here.
     */
    async startPlanCheckout(
        planCode: string,
        organizationId?: string | null,
    ): Promise<PlanCheckoutResponse> {
        const body: { planCode: string; organizationId?: string } = { planCode };
        if (organizationId) {
            body.organizationId = organizationId;
        }
        return serverFetch<PlanCheckoutResponse>('/billing/checkout/plan', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    /**
     * Finalize the browser's return from a plan checkout so the new tier
     * shows immediately. The webhook is still the authority; this call is
     * idempotent and scoped to the session user by the API.
     */
    async completePlanCheckout(sessionId: string): Promise<PlanCheckoutReturnResponse> {
        const search = new URLSearchParams({ sessionId });
        return serverFetch<PlanCheckoutReturnResponse>(
            `/billing/checkout/plan/return?${search.toString()}`,
            { method: 'GET' },
        );
    },

    /** Enable/disable threshold-triggered top-ups. */
    async updateAutoRecharge(settings: {
        enabled: boolean;
        thresholdCredits?: number;
        packId?: string;
    }): Promise<{ status: string; enabled: boolean; thresholdCredits: number | null }> {
        return serverFetch('/billing/auto-recharge', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
    },
};
