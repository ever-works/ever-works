/**
 * The money path (billing PRD B5) — client-safe wire types + pure helpers
 * for the live Billing page surfaces: credit packs, checkout, payment
 * method, auto-recharge and invoice history.
 *
 * Kept apart from `billing.ts` (which is `server-only`) so `'use client'`
 * components can import types and helpers without pulling the server
 * guard into the client bundle — same split as `credits.shared.ts`.
 *
 * NOTE: nothing here carries a price. Prices come from the API's
 * server-side pack table; the client only ever sends a pack ID.
 */

export interface CreditPackSummary {
    id: string;
    priceCents: number;
    credits: number;
    currency: string;
    label: string;
}

export interface PaymentMethodSummary {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
}

export interface AutoRechargeSettings {
    enabled: boolean;
    thresholdCredits: number | null;
    packId: string | null;
    failureCount: number;
}

export interface BillingOverview {
    status: string;
    /** False ⇒ render the coming-soon state instead of live controls. */
    providerConfigured: boolean;
    providerId: string;
    currency: string;
    packs: CreditPackSummary[];
    balanceCredits: number;
    paymentMethod: PaymentMethodSummary | null;
    autoRecharge: AutoRechargeSettings;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'refunded';

export interface InvoiceRow {
    id: string;
    number: string | null;
    status: InvoiceStatus;
    periodStart: string | null;
    periodEnd: string | null;
    subtotalCents: number;
    totalCents: number;
    amountPaidCents: number;
    currency: string;
    hostedUrl: string | null;
    pdfUrl: string | null;
    issuedAt: string;
}

export interface InvoiceListPage {
    status: string;
    invoices: InvoiceRow[];
    total: number;
    page: number;
    pageSize: number;
}

export interface CreditCheckoutResponse {
    status: string;
    url: string;
    sessionId: string;
    packId: string;
    priceCents: number;
    credits: number;
}

// ── Pure helpers (unit-tested in billing.shared.unit.spec.ts) ───────

/** Bonus credits a pack grants over the 1 credit = 1¢ par rate. */
export function packBonusPercent(pack: Pick<CreditPackSummary, 'priceCents' | 'credits'>): number {
    if (!Number.isFinite(pack.priceCents) || pack.priceCents <= 0) {
        return 0;
    }
    const bonus = ((pack.credits - pack.priceCents) / pack.priceCents) * 100;
    return bonus > 0 ? Math.round(bonus) : 0;
}

/** `visa •••• 4242` — display only; the token reference never leaves the API. */
export function formatPaymentMethod(method: PaymentMethodSummary | null): string | null {
    if (!method || !method.last4) {
        return null;
    }
    const brand = method.brand ? method.brand.replace(/^./, (c) => c.toUpperCase()) : 'Card';
    return `${brand} •••• ${method.last4}`;
}

/** `04 / 2031`, or null when the provider gave us no expiry. */
export function formatCardExpiry(method: PaymentMethodSummary | null): string | null {
    if (!method?.expMonth || !method?.expYear) {
        return null;
    }
    return `${String(method.expMonth).padStart(2, '0')} / ${method.expYear}`;
}

/** Badge tone bucket for an invoice status (colors mapped in the component). */
export type InvoiceTone = 'positive' | 'negative' | 'neutral';

export function invoiceStatusTone(status: InvoiceStatus): InvoiceTone {
    switch (status) {
        case 'paid':
            return 'positive';
        case 'void':
        case 'uncollectible':
        case 'refunded':
            return 'negative';
        default:
            return 'neutral';
    }
}

/**
 * A pack is selectable only when the provider is actually wired. Keeps
 * the "provider not configured degrades to coming-soon" rule in one
 * testable place instead of scattered across JSX conditions.
 */
export function canBuyCredits(overview: BillingOverview | null, paymentsEnabled: boolean): boolean {
    return Boolean(paymentsEnabled && overview?.providerConfigured);
}

/** Auto-recharge is only offerable once a payment method is on file. */
export function canConfigureAutoRecharge(
    overview: BillingOverview | null,
    paymentsEnabled: boolean,
): boolean {
    return canBuyCredits(overview, paymentsEnabled) && Boolean(overview?.paymentMethod);
}
