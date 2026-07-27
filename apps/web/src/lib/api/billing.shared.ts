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

/**
 * Vendor-neutral subscription lifecycle (audit B07/B08). Mirrors the
 * API's `BillingSubscriptionStatus`; `none` means the account has no
 * provider subscription at all (free tier / payments not wired), which
 * is distinct from `canceled` (it had one and it ended).
 */
export type SubscriptionLifecycleStatus =
    | 'none'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'unpaid'
    | 'paused'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired';

export interface SubscriptionState {
    status: SubscriptionLifecycleStatus;
    /** Cancel requested; the plan runs until `currentPeriodEnd`. */
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    canceledAt: string | null;
    pastDue: boolean;
    /** There is a real provider subscription cancel/resume can act on. */
    manageable: boolean;
}

/** What an overview with no subscription block looks like. */
export const EMPTY_SUBSCRIPTION_STATE: SubscriptionState = {
    status: 'none',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    canceledAt: null,
    pastDue: false,
    manageable: false,
};

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
    /**
     * Optional on the wire: an older API (or a degraded response) simply
     * omits it, and {@link subscriptionState} falls back to `none` rather
     * than the page crashing on an undefined read.
     */
    subscription?: SubscriptionState;
}

export interface SubscriptionMutationResponse {
    status: string;
    subscription: SubscriptionState;
}

export interface BillingPortalResponse {
    status: string;
    url: string;
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

/** Paid-plan checkout (audit B24). Prices are echoed FROM the server. */
export interface PlanCheckoutResponse {
    status: string;
    url: string;
    sessionId: string;
    planCode: string;
    priceCents: number;
    currency: string;
}

/** Result of finalizing the browser's return from a plan checkout. */
export interface PlanCheckoutReturnResponse {
    /**
     * `active` once the tier is in force; `pending` while money settles;
     * `ignored` when a credit top-up session returned through this plan
     * route — not an error, it simply activates no plan.
     */
    status: 'active' | 'pending' | 'ignored';
    /** True once the plan is actually in force for the owner. */
    activated: boolean;
    planCode: string | null;
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

/**
 * A paid tier is purchasable only when the deployment's master switch is
 * on, the provider is wired AND subscriptions are enabled (an upgrade
 * that cannot be applied must not be offered). Same single-testable-place
 * rule as {@link canBuyCredits} — audit B24.
 */
export function canUpgradePlan(
    overview: BillingOverview | null,
    paymentsEnabled: boolean,
    subscriptionsEnabled: boolean,
): boolean {
    return canBuyCredits(overview, paymentsEnabled) && subscriptionsEnabled;
}

// ── Subscription lifecycle (audit B07/B08) ─────────────────────────

/** Never-undefined lifecycle state for the page to render from. */
export function subscriptionState(overview: BillingOverview | null): SubscriptionState {
    return overview?.subscription ?? EMPTY_SUBSCRIPTION_STATE;
}

/**
 * Badge tone for the plan status chip. `none` reads as positive because
 * an account with no provider subscription is a perfectly healthy free
 * account — the chip should not imply something is wrong.
 */
export function subscriptionStatusTone(
    status: SubscriptionLifecycleStatus,
): 'positive' | 'negative' | 'warning' | 'neutral' {
    switch (status) {
        case 'none':
        case 'active':
        case 'trialing':
            return 'positive';
        case 'past_due':
        case 'unpaid':
            return 'negative';
        case 'canceled':
        case 'incomplete_expired':
            return 'neutral';
        case 'paused':
        case 'incomplete':
            return 'warning';
        default:
            return 'neutral';
    }
}

/**
 * Message keys the status chip can render, as a literal union — next-intl
 * types `t()` against the message tree, so a plain `string` would not
 * typecheck at the call site.
 */
export type SubscriptionStatusLabelKey =
    | 'currentPlan.statusActive'
    | `currentPlan.statuses.${Exclude<SubscriptionLifecycleStatus, 'none' | 'active'>}`;

/**
 * Translation key (relative to `dashboard.settings.billing`) for a
 * status. `active` and `none` deliberately keep the pre-existing
 * `currentPlan.statusActive` key so the copy — and anything asserting on
 * it — is unchanged for the common case.
 */
export function subscriptionStatusLabelKey(
    status: SubscriptionLifecycleStatus,
): SubscriptionStatusLabelKey {
    return status === 'none' || status === 'active'
        ? 'currentPlan.statusActive'
        : `currentPlan.statuses.${status}`;
}

/** The recovery banner shows only for a genuinely uncollected subscription. */
export function isSubscriptionPastDue(overview: BillingOverview | null): boolean {
    const state = subscriptionState(overview);
    return state.pastDue || state.status === 'past_due' || state.status === 'unpaid';
}

/**
 * Cancel is offerable while the plan is live and not already scheduled to
 * end. Both gates from `canBuyCredits` still apply — a deployment with
 * payments off never shows a money control.
 */
export function canCancelSubscription(
    overview: BillingOverview | null,
    paymentsEnabled: boolean,
): boolean {
    const state = subscriptionState(overview);
    return (
        canBuyCredits(overview, paymentsEnabled) &&
        state.manageable &&
        !state.cancelAtPeriodEnd &&
        (state.status === 'active' ||
            state.status === 'trialing' ||
            state.status === 'past_due' ||
            state.status === 'unpaid' ||
            state.status === 'paused')
    );
}

/** Resume is offerable only while a scheduled cancellation is still pending. */
export function canResumeSubscription(
    overview: BillingOverview | null,
    paymentsEnabled: boolean,
): boolean {
    const state = subscriptionState(overview);
    return (
        canBuyCredits(overview, paymentsEnabled) &&
        state.manageable &&
        state.cancelAtPeriodEnd &&
        state.status !== 'canceled' &&
        state.status !== 'incomplete_expired'
    );
}
