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

/**
 * One stored card on the manage-payment-methods surface (billing PRD
 * §3.3, audit B10 + B25).
 *
 * `id` is an opaque HANDLE, not the provider's payment-method reference —
 * the reference never leaves the API. Everything else is display
 * metadata; there is no field here that could carry a card number,
 * because a card number never reaches our servers in the first place.
 */
export interface PaymentMethodRow {
    id: string;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    isDefault: boolean;
}

export interface PaymentMethodListPage {
    status: string;
    /** False ⇒ render the coming-soon state instead of live controls. */
    providerConfigured: boolean;
    methods: PaymentMethodRow[];
}

export interface PaymentMethodSetupResponse {
    status: string;
    /** The PROVIDER'S hosted card element — redirect the browser here. */
    url: string;
    sessionId: string;
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

/** One graduated pay-as-you-go tier (billing spec §3.5). `upTo: null` = open-ended. */
export interface PaygTier {
    upTo: number | null;
    /** Cents per credit as a decimal string (Stripe `unit_amount_decimal`). */
    centsPerCredit: string;
}

/** `GET /api/billing/payg` / `overview.payg` — pay-as-you-go state (billing spec §3.5). */
export interface PaygState {
    /** The provider is configured, so the feature can be turned on at all. */
    available: boolean;
    enabled: boolean;
    subscriptionStatus: SubscriptionLifecycleStatus;
    /** Arrears invoice failed — overflow suspended until it is paid. */
    pastDue: boolean;
    monthlyCapCredits: number;
    defaultMonthlyCapCredits: number;
    maxMonthlyCapCredits: number;
    minMonthlyCapCredits: number;
    cycleUsedCredits: number;
    cycleEstimateCents: number;
    periodStart: string | null;
    periodEnd: string | null;
    tiers: PaygTier[];
    invoiceThresholdCents: number;
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
    /**
     * Optional on the wire: an older API (or a degraded response) simply
     * omits it, and {@link subscriptionState} falls back to `none` rather
     * than the page crashing on an undefined read.
     */
    subscription?: SubscriptionState;
    /** Pay-as-you-go (billing spec §3.5). Optional on the wire for older API builds. */
    payg?: PaygState | null;
}

/** `PUT /api/billing/payg` response: the success envelope spread over the state. */
export type PaygMutationResponse = { status: string } & PaygState;

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
export function formatPaymentMethod(
    method: Pick<PaymentMethodSummary, 'brand' | 'last4'> | null,
): string | null {
    if (!method || !method.last4) {
        return null;
    }
    const brand = method.brand ? method.brand.replace(/^./, (c) => c.toUpperCase()) : 'Card';
    return `${brand} •••• ${method.last4}`;
}

/** `04 / 2031`, or null when the provider gave us no expiry. */
export function formatCardExpiry(
    method: Pick<PaymentMethodSummary, 'expMonth' | 'expYear'> | null,
): string | null {
    if (!method?.expMonth || !method?.expYear) {
        return null;
    }
    return `${String(method.expMonth).padStart(2, '0')} / ${method.expYear}`;
}

/**
 * True when the manage-payment-methods surface should offer live
 * controls. Same two gates as buying credits: the deployment master
 * switch AND real provider keys.
 */
export function canManagePaymentMethods(
    page: Pick<PaymentMethodListPage, 'providerConfigured'> | null,
    paymentsEnabled: boolean,
): boolean {
    return Boolean(paymentsEnabled && page?.providerConfigured);
}

/**
 * Whether removing this card is offerable at all.
 *
 * Mirrors the API rule so the button is disabled rather than clicked
 * into a 409: the LAST card cannot be removed while a paid plan is
 * active. The server re-checks — this is UX, not the enforcement point.
 */
export function canRemovePaymentMethod(
    methods: readonly PaymentMethodRow[],
    onPaidPlan: boolean,
): boolean {
    return methods.length > 1 || !onPaidPlan;
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
 * Pay-as-you-go (billing spec §3.5) is offerable under the same two gates
 * as buying credits plus a payment method on file (the arrears invoices
 * charge it). Same single-testable-place rule as {@link canBuyCredits}.
 */
export function canConfigurePayg(
    overview: BillingOverview | null,
    paymentsEnabled: boolean,
): boolean {
    return (
        canBuyCredits(overview, paymentsEnabled) &&
        Boolean(overview?.payg?.available) &&
        // A card is required to ENABLE arrears billing, but an already
        // enabled owner must retain the control needed to turn it off after
        // a card is detached or expires.
        (Boolean(overview?.paymentMethod) || Boolean(overview?.payg?.enabled))
    );
}

/**
 * What Stripe bills for `credits` in one cycle under graduated tiers, in cents
 * (same arithmetic as the API's `estimatePaygCents`). Used for the live
 * estimate while the owner types a cap.
 */
export function estimatePaygCents(credits: number, tiers: readonly PaygTier[]): number {
    if (!Number.isFinite(credits) || credits <= 0) return 0;
    let remaining = Math.floor(credits);
    let previousUpTo = 0;
    let total = 0;
    for (const tier of tiers) {
        if (remaining <= 0) break;
        const span = tier.upTo === null ? remaining : Math.max(0, tier.upTo - previousUpTo);
        const inTier = Math.min(remaining, span);
        total += inTier * Number(tier.centsPerCredit);
        remaining -= inTier;
        if (tier.upTo !== null) previousUpTo = tier.upTo;
    }
    return Math.round(total);
}

/** `1.00¢`, `0.91¢` — a tier rate for display. */
export function formatCentsPerCredit(centsPerCredit: string): string {
    const value = Number(centsPerCredit);
    if (!Number.isFinite(value)) return `${centsPerCredit}¢`;
    return `${value.toFixed(2)}¢`;
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
