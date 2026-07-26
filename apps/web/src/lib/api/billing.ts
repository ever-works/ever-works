import 'server-only';
import { serverFetch } from './server-api';
import type { BillingOverview, CreditCheckoutResponse, InvoiceListPage } from './billing.shared';

export type { BillingOverview, CreditCheckoutResponse, InvoiceListPage };

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
