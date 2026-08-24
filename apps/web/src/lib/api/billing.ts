import 'server-only';
import { serverFetch } from './server-api';
import type {
    BillingOverview,
    BillingPortalResponse,
    PaygMutationResponse,
    SeatsResponse,
    CreditCheckoutResponse,
    InvoiceListPage,
    PlanCheckoutResponse,
    PlanCheckoutReturnResponse,
    SubscriptionMutationResponse,
    PaymentMethodListPage,
    PaymentMethodSetupResponse,
} from './billing.shared';

export type {
    BillingOverview,
    BillingPortalResponse,
    PaygMutationResponse,
    SeatsResponse,
    CreditCheckoutResponse,
    InvoiceListPage,
    PlanCheckoutResponse,
    PlanCheckoutReturnResponse,
    SubscriptionMutationResponse,
    PaymentMethodListPage,
    PaymentMethodSetupResponse,
};

/**
 * The money path (billing PRD B5) — server-side wrappers over
 * `/api/billing/*` and `/api/credits/checkout`.
 *
 * Endpoints deliberately do NOT start with `/api` (serverFetch prepends
 * `API_URL`, which is normalized to end in `/api` — see the
 * double-prefix regression specs beside the other lib/api wrappers).
 */
/**
 * Billing cadence for a plan checkout. `lifetime` is a one-off
 * `mode: 'payment'` purchase, and the catalog carries exactly one such SKU:
 * the $99 perpetual self-hosted commercial licence.
 */
export type PlanCheckoutInterval = 'monthly' | 'annual' | 'lifetime';

export interface PlanCheckoutOptions {
    organizationId?: string | null;
    interval?: PlanCheckoutInterval;
    /** TOTAL seats, inclusive of the plan allowance - not the extras. */
    seats?: number;
}

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
        options: PlanCheckoutOptions = {},
    ): Promise<PlanCheckoutResponse> {
        const body: {
            planCode: string;
            organizationId?: string;
            interval?: PlanCheckoutInterval;
            seats?: number;
        } = { planCode };
        if (options.organizationId) {
            body.organizationId = options.organizationId;
        }
        // Sent only when present, so the one-field body every existing caller
        // produces stays byte-identical and the API keeps defaulting to
        // monthly. NEVER add a price field here — the DTO is
        // `forbidNonWhitelisted` and would 400 the whole request.
        if (options.interval) {
            body.interval = options.interval;
        }
        if (typeof options.seats === 'number') {
            body.seats = options.seats;
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

    /**
     * Pay-as-you-go (billing spec §3.5): enable / disable / re-cap. The
     * body carries no price — the per-credit rate is the server catalog's.
     */
    async updatePayg(settings: {
        enabled?: boolean;
        monthlyCapCredits?: number;
    }): Promise<PaygMutationResponse> {
        return serverFetch<PaygMutationResponse>('/billing/payg', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
    },

    /** Seat allowance + usage (billing spec §3.6). */
    async seats(): Promise<SeatsResponse> {
        return serverFetch<SeatsResponse>('/billing/seats', { method: 'GET' });
    },

    /**
     * Set the TOTAL seats wanted. A total, not a delta: a delta double-charges
     * on a retry. The API bills the extras from the stored plan row.
     */
    async setSeats(seats: number): Promise<SeatsResponse> {
        return serverFetch<SeatsResponse>('/billing/seats', {
            method: 'POST',
            body: JSON.stringify({ seats }),
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

    // ── Payment methods (billing PRD §3.3, audit B10 + B25) ─────────
    //
    // Note what is NOT here: any call that sends card data. Adding a
    // card is `startPaymentMethodSetup()`, which returns a redirect to
    // the PROVIDER'S hosted element — the PAN is posted to them, never
    // to this app or to our API.

    /** The owner's stored cards, display metadata + opaque handles only. */
    async paymentMethods(): Promise<PaymentMethodListPage> {
        return serverFetch<PaymentMethodListPage>('/billing/payment-methods', { method: 'GET' });
    },

    /** Start a hosted card capture. The body is empty by contract. */
    async startPaymentMethodSetup(): Promise<PaymentMethodSetupResponse> {
        return serverFetch<PaymentMethodSetupResponse>('/billing/payment-methods/setup-session', {
            method: 'POST',
            body: JSON.stringify({}),
        });
    },

    /** Promote a stored card to the default — the "replace" action. */
    async setDefaultPaymentMethod(id: string): Promise<{ status: string }> {
        return serverFetch(`/billing/payment-methods/${encodeURIComponent(id)}/default`, {
            method: 'PUT',
        });
    },

    /** Remove a stored card; 409 when it is the last on a paid plan. */
    async removePaymentMethod(id: string): Promise<PaymentMethodListPage> {
        return serverFetch<PaymentMethodListPage>(
            `/billing/payment-methods/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
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
