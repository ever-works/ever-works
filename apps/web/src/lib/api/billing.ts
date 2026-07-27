import 'server-only';
import { serverFetch } from './server-api';
import type {
    BillingOverview,
    BillingPortalResponse,
    CreditCheckoutResponse,
    InvoiceListPage,
    PlanCheckoutResponse,
    PlanCheckoutReturnResponse,
    SubscriptionMutationResponse,
} from './billing.shared';

export type {
    BillingOverview,
    BillingPortalResponse,
    CreditCheckoutResponse,
    InvoiceListPage,
    PlanCheckoutResponse,
    PlanCheckoutReturnResponse,
    SubscriptionMutationResponse,
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
     * Schedule an at-period-end cancellation (audit B07). No body: the
     * subscription is resolved server-side from the session user.
     */
    async cancelSubscription(): Promise<SubscriptionMutationResponse> {
        return serverFetch<SubscriptionMutationResponse>('/billing/subscription/cancel', {
            method: 'POST',
        });
    },

    /** Clear a pending at-period-end cancellation (audit B07). */
    async resumeSubscription(): Promise<SubscriptionMutationResponse> {
        return serverFetch<SubscriptionMutationResponse>('/billing/subscription/resume', {
            method: 'POST',
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

    /**
     * Hosted portal redirect — the PAST_DUE recovery action (audit B08).
     * The return URL is built by the API from its own WEB_URL.
     */
    async billingPortal(): Promise<BillingPortalResponse> {
        return serverFetch<BillingPortalResponse>('/billing/portal', { method: 'POST' });
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
