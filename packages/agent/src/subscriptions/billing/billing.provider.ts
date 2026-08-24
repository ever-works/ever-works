import { Injectable } from '@nestjs/common';
import { config } from '@src/config';
import type { BillingSubscriptionStatus } from '@src/entities/billing-profile.entity';
import { UsageLedgerEntry } from '@src/entities/usage-ledger-entry.entity';
import type { CreditPack } from './credit-packs';

/**
 * The payment-provider seam (billing PRD §5.1). ONE abstract class, one
 * DI token, N implementations — `ManualBillingProvider` (no money moves)
 * and `StripeBillingProvider` (the real one) today.
 *
 * ## Swappability rule
 *
 * Nothing outside a provider implementation file may import a vendor SDK.
 * Every type crossing this boundary is defined here in vendor-neutral
 * terms: a checkout is `{url, sessionId}`, a webhook is a
 * {@link BillingWebhookEvent} with a small closed `kind` union, a payment
 * method is a display summary. Swapping providers is a module binding
 * change, not a refactor.
 *
 * ## Not-configured posture
 *
 * Every money-moving method defaults to throwing
 * {@link BillingProviderNotConfiguredError}. A deployment with no keys
 * therefore FAILS CLOSED: checkout returns a mapped 4xx/503 and the UI
 * degrades to the coming-soon card. It never falls back to "pretend it
 * worked".
 */

/**
 * The provider is not wired (no secret key / no webhook secret), or the
 * bound implementation does not move money at all. Stable `name` so the
 * API boundary maps it to a distinct status instead of an unmapped 500.
 */
export class BillingProviderNotConfiguredError extends Error {
    constructor(message = 'Payment provider is not configured on this deployment') {
        super(message);
        this.name = 'BillingProviderNotConfiguredError';
    }
}

/** A provider call failed for a reason the caller may surface as 4xx. */
export class BillingProviderError extends Error {
    constructor(
        message: string,
        public readonly code?: string,
    ) {
        super(message);
        this.name = 'BillingProviderError';
    }
}

/** Who is buying, and what. Amounts always come from the server-side pack. */
export interface CreditCheckoutRequest {
    readonly userId: string;
    /** Email for the provider customer record; optional. */
    readonly userEmail?: string | null;
    /** Existing provider customer id, when the buyer has one. */
    readonly customerId?: string | null;
    /** The server-resolved pack — never client-supplied numbers. */
    readonly pack: CreditPack;
    /** Where the provider returns the buyer after a successful payment. */
    readonly successUrl: string;
    /** Where the provider returns the buyer after cancelling. */
    readonly cancelUrl: string;
    /**
     * Correlation id echoed back on the provider event so the webhook can
     * attribute the payment without trusting anything from the browser.
     */
    readonly referenceId: string;
}

export interface CreditCheckoutSession {
    /** Redirect the browser here. */
    readonly url: string;
    readonly sessionId: string;
    /** The provider customer used/created for this checkout. */
    readonly customerId: string;
}

/**
 * A subscription plan, priced by the SERVER from `subscription_plans`.
 *
 * The seam deliberately takes a flat descriptor rather than the TypeORM
 * entity: a provider implementation must never reach into our schema,
 * and the caller must be the one that decided what this plan costs.
 */
export interface BillingPlanDescriptor {
    /** `subscription_plans.code` — echoed back on the provider event. */
    readonly code: string;
    /** Display label shown on the hosted checkout page. */
    readonly label: string;
    /** Recurring price in cents, from the server plan row. */
    readonly priceCents: number;
    readonly currency: string;
    /**
     * The recurrence, for a recurring plan. Ignored entirely when {@link mode} is `payment` — a
     * perpetual licence does not recur.
     */
    readonly interval: 'month' | 'year';

    /**
     * How the plan is bought. `subscription` (the default, and what every caller sent before this
     * field existed) recurs; `payment` is a one-off perpetual commercial licence that lifts the
     * buyer's AGPLv3 obligations.
     *
     * 🛑 Read this from the SKU, never from a marketing toggle position: on self-hosted, the
     * "annual" slot is a yearly subscription on one tier and a one-time licence on another.
     */
    readonly mode?: 'subscription' | 'payment' | null;

    /**
     * Catalog `lookup_key` for this plan, e.g. `ever_works_cloud_pro_monthly`.
     *
     * When set AND resolvable in the provider account, the provider bills the CATALOG price object
     * instead of minting an ad-hoc one from {@link priceCents}. That is what puts Ever Works on the
     * same shared Stripe account and the same lookup-key convention as every other Ever product,
     * and it is what makes a charge auditable after the fact: the invoice line carries a key that
     * maps back to a reviewed commit rather than to a number that happened to be in a plan row.
     *
     * 🛑 Optional on purpose. A deployment whose catalog has not been synced — a self-hoster, CI,
     * local dev — leaves this unset (or sets a key the account does not have) and the provider
     * falls back to the existing inline-price path. Billing must not stop working because a catalog
     * sync has not been run.
     */
    readonly lookupKey?: string | null;

    /**
     * Catalog `lookup_key` for this plan's per-additional-seat price, e.g.
     * `ever_works_cloud_pro_seat_monthly`. Ignored unless {@link extraSeats} is greater than zero.
     *
     * A seat is an employee OR an agent — the two are interchangeable in Ever Works. Mirrors Ever
     * Gauzy / Ever Teams, which include 10 and bill per additional one.
     */
    readonly seatLookupKey?: string | null;

    /**
     * Seats to bill BEYOND the plan's included allowance. Already net of `seatsIncluded`; the
     * provider does not subtract anything. Zero, absent, or a plan with unbounded seats all mean
     * "no seat line item".
     */
    readonly extraSeats?: number | null;
}

/**
 * Who is subscribing, and to what (audit B24). Same trust posture as
 * {@link CreditCheckoutRequest}: the caller names a PLAN CODE, never a
 * price, and the return URLs are built server-side.
 */
export interface PlanCheckoutRequest {
    readonly userId: string;
    readonly userEmail?: string | null;
    readonly customerId?: string | null;
    /** The server-resolved plan — never client-supplied numbers. */
    readonly plan: BillingPlanDescriptor;
    /**
     * Where the provider returns the buyer after a successful payment.
     *
     * The IMPLEMENTATION is responsible for appending its own session
     * identifier to this URL (providers use different template tokens);
     * the caller supplies a clean, server-built URL and stays
     * vendor-neutral. The return route needs that identifier to read the
     * session back — see {@link CheckoutSessionSnapshot}.
     */
    readonly successUrl: string;
    readonly cancelUrl: string;
    /** `{userId}:{planCode}` — echoed back on the signed provider event. */
    readonly referenceId: string;
}

export interface PlanCheckoutSession {
    /** Redirect the browser here. */
    readonly url: string;
    readonly sessionId: string;
    readonly customerId: string;
}

/**
 * A read-back of a hosted checkout session, used by the RETURN route so
 * a buyer who lands back on the Billing page sees their plan immediately
 * instead of waiting for the asynchronous webhook.
 *
 * `userId` is the value WE stamped into the session metadata at creation
 * time, so the return route can prove the session belongs to the caller
 * before acting on it — a session id in a URL is not an authorization.
 */
export interface CheckoutSessionSnapshot {
    readonly sessionId: string;
    readonly status: 'complete' | 'open' | 'expired';
    /** True when the provider settled the money (or none was required). */
    readonly paid: boolean;
    /** What the session was created for. */
    readonly purpose: 'plan' | 'credits' | 'other';
    /** Platform user id from OUR metadata — the ownership check. */
    readonly userId: string | null;
    readonly planCode: string | null;
    readonly packId: string | null;
    readonly customerId: string | null;
    /** Provider subscription id, for plan sessions. */
    readonly subscriptionId: string | null;
    readonly currentPeriodEnd: Date | null;
}

/** Off-session charge for auto-recharge (PRD §3.4). */
export interface OffSessionChargeRequest {
    readonly customerId: string;
    /** Opaque provider payment-method token reference. */
    readonly paymentMethodRef: string;
    readonly pack: CreditPack;
    readonly userId: string;
    /** Provider-level idempotency key — a retry must not double-charge. */
    readonly idempotencyKey: string;
}

export interface OffSessionChargeResult {
    /** Provider payment id; becomes the ledger idempotency key suffix. */
    readonly paymentId: string;
    /** `succeeded` credits immediately; `pending` waits for the webhook. */
    readonly status: 'succeeded' | 'pending' | 'failed';
    readonly failureCode?: string;
}

/** Default payment-method display metadata. NEVER a PAN or CVC. */
export interface PaymentMethodSummary {
    readonly ref: string;
    readonly brand: string | null;
    readonly last4: string | null;
    readonly expMonth: number | null;
    readonly expYear: number | null;
}

/**
 * Ask the provider for a HOSTED card-capture surface (billing PRD §3.3).
 *
 * The browser is redirected to a page the PROVIDER serves and renders;
 * the PAN/CVC are posted straight to them and are tokenized there. No
 * card datum ever transits our servers, our forms, or our logs — the
 * only thing that comes back is an opaque payment-method reference.
 * That is the whole reason this is a redirect and not a form we own.
 */
export interface PaymentMethodSetupRequest {
    readonly userId: string;
    /** Provider customer the captured method attaches to. Server-resolved. */
    readonly customerId: string;
    readonly userEmail?: string | null;
    /** Where the provider returns the buyer after saving the card. */
    readonly successUrl: string;
    /** Where the provider returns the buyer after cancelling. */
    readonly cancelUrl: string;
}

export interface PaymentMethodSetupSession {
    /** Redirect the browser here — the provider's hosted card element. */
    readonly url: string;
    readonly sessionId: string;
}

/** One line on a mirrored invoice. */
export interface BillingInvoiceLine {
    readonly description: string;
    readonly quantity: number;
    readonly amountCents: number;
}

/** The invoice/receipt shape the mirror stores, vendor-neutral. */
export interface BillingInvoiceSnapshot {
    readonly providerInvoiceId: string;
    readonly number: string | null;
    /** Raw provider status, already normalized to our closed set. */
    readonly status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'refunded';
    /**
     * The provider subscription that generated this invoice, when any, and
     * which of OUR subscription kinds it is (read from the metadata WE
     * stamped on the subscription). `null` kind = not ours / one-off.
     * Lets the pay-as-you-go lifecycle react to its own invoices without
     * ever touching the plan tier (billing spec FR-21).
     */
    readonly subscriptionId?: string | null;
    readonly subscriptionKind?: 'plan' | 'payg' | null;
    /** True when the delivery was a payment failure (dunning has started). */
    readonly paymentFailed?: boolean;
    readonly periodStart: Date | null;
    readonly periodEnd: Date | null;
    readonly subtotalCents: number;
    readonly totalCents: number;
    readonly amountPaidCents: number;
    readonly currency: string;
    readonly hostedUrl: string | null;
    readonly pdfUrl: string | null;
    readonly lines: BillingInvoiceLine[];
    readonly issuedAt: Date | null;
}

/**
 * A subscription's lifecycle as the provider currently reports it
 * (audit B07/B08). Vendor-neutral: `status` is the shared token set from
 * {@link BillingSubscriptionStatus}, dates are real `Date`s, and the id
 * is opaque. Returned by cancel/resume AND carried on the reconciling
 * webhook, so both paths persist the same shape.
 */
export interface BillingSubscriptionSnapshot {
    readonly subscriptionId: string;
    readonly status: BillingSubscriptionStatus;
    /** Cancel requested, paid period still running. */
    readonly cancelAtPeriodEnd: boolean;
    /** When a pending cancellation takes effect. */
    readonly currentPeriodEnd: Date | null;
    /** When the subscription actually ended. */
    readonly canceledAt: Date | null;
    /** Start of the current period (pay-as-you-go cycles are computed over [start, end)). */
    readonly currentPeriodStart?: Date | null;
    /** The first (metered) subscription item, for pay-as-you-go subscriptions. */
    readonly subscriptionItemId?: string | null;
}

// ── Pay-as-you-go (billing spec §3.5) ─────────────────────────────────

/**
 * Create the provider's usage-only subscription for pay-as-you-go. No
 * flat fee: the single item is the catalog's metered price, so the
 * provider rates whatever the meter receives and invoices it in arrears
 * (and mid-cycle once accrued usage reaches `invoiceThresholdCents`).
 */
export interface MeteredSubscriptionRequest {
    readonly userId: string;
    readonly customerId: string;
    /** Stored default payment method the arrears invoices are charged to. */
    readonly paymentMethodRef: string;
    /** Catalog `lookup_key` of the metered price (`ever_works_payg_credits_monthly`). */
    readonly lookupKey: string;
    /** `billing_thresholds.amount_gte` — invoice mid-cycle at this accrued amount. */
    readonly invoiceThresholdCents: number;
    /** `{userId}:payg` — echoed back on the signed provider events. */
    readonly referenceId: string;
}

/** One usage report to the provider's meter. `value` is whole credits. */
export interface MeterEventRequest {
    readonly eventName: string;
    readonly customerId: string;
    readonly value: number;
    /** Idempotency identifier (`run:{runId}`); Stripe de-duplicates within a rolling 24h. */
    readonly identifier: string;
    readonly timestamp: Date;
}

export type MeterEventOutcome =
    | { readonly status: 'accepted' }
    /** Provider refused; `terminal` = do not retry (e.g. outside the backdating window). */
    | { readonly status: 'failed'; readonly failureCode: string; readonly terminal: boolean };

/** Cancel/resume input. The id is server-resolved, never client-supplied. */
export interface SubscriptionMutationRequest {
    readonly subscriptionId: string;
}

/**
 * Hosted self-service portal (the PAST_DUE recovery action, B08). The
 * return URL is always built server-side from the platform's own web
 * origin — accepting one from the client would be an open redirect.
 */
export interface BillingPortalRequest {
    readonly customerId: string;
    readonly returnUrl: string;
}

export interface BillingPortalSession {
    readonly url: string;
}

/**
 * The closed set of provider events the money path reacts to. Anything
 * else the provider sends is acknowledged and ignored — an unknown event
 * type must never 500 a webhook (the provider would retry forever).
 */
export type BillingWebhookEventKind =
    /** A credit top-up (checkout or off-session charge) settled. */
    | 'credits.purchased'
    /** A settled payment was refunded or charged back. */
    | 'credits.refunded'
    /** An invoice/receipt was created or updated. */
    | 'invoice.updated'
    /** The customer's default payment method changed. */
    | 'payment_method.updated'
    /**
     * A paid plan is now in force (audit B24) — first checkout, renewal,
     * or a provider-side change back to an active/trialing state. The
     * ONLY billing-verified path that may grant a paid tier.
     */
    | 'subscription.activated'
    /** A paid plan lapsed (cancelled, unpaid, or deleted). */
    | 'subscription.canceled'
    /**
     * A subscription's LIFECYCLE moved (audit B07/B08) — dunning, pause,
     * resume, or a period roll — carrying the full provider snapshot.
     *
     * Deliberately NOT a grant or a revoke. Those remain
     * `subscription.activated` / `subscription.canceled` above, which are
     * the only two kinds allowed to move a user's tier. This one exists
     * so the states those two treat as "not actionable" (`past_due`,
     * `paused`, `incomplete`) still reach the product instead of being
     * dropped — that is what makes a dunning banner or a resume button
     * possible without giving the lifecycle path the power to downgrade
     * anyone.
     */
    | 'subscription.updated'
    /** A stored payment method was detached from the customer. */
    | 'payment_method.removed'
    /**
     * The pay-as-you-go (usage-only) subscription's lifecycle moved —
     * created, period rolled, dunning, cancelled. Carries the full
     * snapshot. NEVER touches the plan tier; handled by `PaygService`.
     */
    | 'payg.updated'
    /** Recognized envelope, no action for us. */
    | 'ignored';

export interface BillingWebhookEvent {
    /** Provider event id — THE idempotency key for every ledger write. */
    readonly id: string;
    readonly kind: BillingWebhookEventKind;
    /** Provider customer this event belongs to, when it carries one. */
    readonly customerId: string | null;
    /** `referenceId` echoed from checkout, when present. */
    readonly referenceId: string | null;
    /** Credit pack id echoed from checkout metadata, when present. */
    readonly packId: string | null;
    /** Amount the provider actually moved, in cents. Server truth. */
    readonly amountCents: number | null;
    readonly currency: string | null;
    /** Populated for `invoice.updated`. */
    readonly invoice?: BillingInvoiceSnapshot;
    /** Populated for `payment_method.updated` and `payment_method.removed`. */
    readonly paymentMethod?: PaymentMethodSummary;
    /** Populated for `subscription.updated` (audit B07/B08). */
    readonly subscription?: BillingSubscriptionSnapshot;
    /** Provider payment id, for correlation on refunds. */
    readonly paymentId: string | null;
    /** Raw provider event type, for logging/diagnostics. Never a secret. */
    readonly providerType: string;
    /**
     * Plan code echoed from OUR subscription metadata. Populated for
     * `subscription.*` kinds only. Optional so the existing credit-path
     * event literals stay valid.
     */
    readonly planCode?: string | null;
    /** Provider subscription id, for `subscription.*` kinds. */
    readonly subscriptionId?: string | null;
    /** End of the paid period currently in force. */
    readonly currentPeriodEnd?: Date | null;
    /** The provider will not renew at `currentPeriodEnd`. */
    readonly cancelAtPeriodEnd?: boolean | null;
}

export abstract class BillingProvider {
    abstract getDefaultCurrency(): string;

    /**
     * Stable provider id persisted on `billing_profiles.provider` and
     * `invoices.provider`. Lowercase, no spaces.
     */
    getProviderId(): string {
        return 'manual';
    }

    /**
     * True only when every credential this provider needs is present.
     * The API surfaces this as `providerConfigured` so the UI can render
     * the coming-soon state instead of a button that always errors.
     */
    isConfigured(): boolean {
        return false;
    }

    /** True when webhook deliveries can be signature-verified. */
    isWebhookConfigured(): boolean {
        return false;
    }

    // Optional hook for forwarding charges to an external gateway.
    async recordUsageCharge(_entry: UsageLedgerEntry): Promise<void> {
        return;
    }

    /** Create (or reuse) the provider customer for a platform user. */
    async ensureCustomer(_input: {
        userId: string;
        email?: string | null;
        existingCustomerId?: string | null;
    }): Promise<string> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Hosted checkout for a credit top-up. */
    async createCreditCheckoutSession(
        _request: CreditCheckoutRequest,
    ): Promise<CreditCheckoutSession> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Hosted checkout for a recurring PLAN subscription (audit B24).
     * Same posture as the credit checkout: the caller hands over a
     * server-priced plan descriptor, never a client number.
     */
    async createPlanCheckoutSession(_request: PlanCheckoutRequest): Promise<PlanCheckoutSession> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Read one hosted checkout session back, for the return route. The
     * snapshot carries the metadata WE stamped at creation time so the
     * caller can verify ownership before acting on it.
     */
    async retrieveCheckoutSession(_sessionId: string): Promise<CheckoutSessionSnapshot> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Off-session charge against a stored payment method (auto-recharge). */
    async chargeOffSession(_request: OffSessionChargeRequest): Promise<OffSessionChargeResult> {
        throw new BillingProviderNotConfiguredError();
    }

    // ── Payment-method management (billing PRD §3.3) ─────────────────
    //
    // Add / replace / remove, all expressed in terms of an OPAQUE
    // provider reference. Capture is a redirect to the provider's hosted
    // element (see {@link PaymentMethodSetupRequest}); nothing in this
    // seam ever accepts a card number, and no implementation may add a
    // method that does.

    /** Hosted card-capture session — the ONLY way a card is added. */
    async createPaymentMethodSetupSession(
        _request: PaymentMethodSetupRequest,
    ): Promise<PaymentMethodSetupSession> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Every card stored against a provider customer. Display metadata only. */
    async listPaymentMethods(_customerId: string): Promise<PaymentMethodSummary[]> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Read one stored method, but ONLY if it belongs to `customerId`.
     * Returns `null` when it does not exist or is owned by somebody else —
     * the ownership check that keeps a guessed reference from reaching
     * another account's card. Implementations must not throw for a
     * foreign reference; a `null` lets the caller answer 404.
     */
    async findPaymentMethod(
        _customerId: string,
        _paymentMethodRef: string,
    ): Promise<PaymentMethodSummary | null> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Promote a stored method to the customer's default (replace). */
    async setDefaultPaymentMethod(
        _customerId: string,
        _paymentMethodRef: string,
    ): Promise<PaymentMethodSummary> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Detach a stored method from the customer (remove). */
    async detachPaymentMethod(_customerId: string, _paymentMethodRef: string): Promise<void> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Schedule a cancellation for the end of the paid period (audit B07).
     *
     * At-period-end ONLY by design: the owner keeps what they paid for,
     * and {@link resumeSubscription} can undo it with no gap in service.
     * There is deliberately no immediate-termination method on this seam.
     */
    async cancelSubscriptionAtPeriodEnd(
        _request: SubscriptionMutationRequest,
    ): Promise<BillingSubscriptionSnapshot> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Undo a pending at-period-end cancellation (audit B07). */
    async resumeSubscription(
        _request: SubscriptionMutationRequest,
    ): Promise<BillingSubscriptionSnapshot> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Hosted self-service portal — the PAST_DUE recovery action (B08).
     * Card capture stays entirely on the provider's tokenized surface, so
     * no cardholder datum ever reaches the platform.
     */
    async createBillingPortalSession(
        _request: BillingPortalRequest,
    ): Promise<BillingPortalSession> {
        throw new BillingProviderNotConfiguredError();
    }

    // ── Pay-as-you-go (billing spec §3.5) ─────────────────────────────

    /** Create the usage-only subscription that the meter bills against. */
    async createMeteredSubscription(
        _request: MeteredSubscriptionRequest,
    ): Promise<BillingSubscriptionSnapshot> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Cancel a usage-only subscription IMMEDIATELY, invoicing accrued usage
     * now. Unlike a plan (where the owner paid for the period and
     * at-period-end is the only right answer), nothing is prepaid here:
     * overflow must stop at once and what was consumed is billed at once.
     */
    async cancelMeteredSubscriptionNow(
        _request: SubscriptionMutationRequest,
    ): Promise<BillingSubscriptionSnapshot> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Read one subscription back (reconcile after create / on demand). */
    async retrieveSubscriptionSnapshot(
        _subscriptionId: string,
    ): Promise<BillingSubscriptionSnapshot> {
        throw new BillingProviderNotConfiguredError();
    }

    /** Report usage to the provider's meter. Never throws for a provider refusal — returns it. */
    async reportMeterEvent(_request: MeterEventRequest): Promise<MeterEventOutcome> {
        throw new BillingProviderNotConfiguredError();
    }

    /**
     * Verify a webhook delivery and normalize it. Implementations MUST
     * fail closed: no signing secret, missing signature, or a bad digest
     * all throw — never return an unverified event.
     */
    async verifyAndParseWebhook(_rawBody: string, _signature: string | undefined) {
        return Promise.reject<BillingWebhookEvent>(new BillingProviderNotConfiguredError());
    }
}

/**
 * The default binding: books the platform's own ledger, moves no money.
 * Every money-moving method inherits the not-configured throw, so a
 * deployment without a real provider degrades cleanly rather than
 * pretending a purchase succeeded.
 */
@Injectable()
export class ManualBillingProvider extends BillingProvider {
    getDefaultCurrency(): string {
        return config.billing.getDefaultCurrency();
    }
}
