import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
// THE ONLY vendor-SDK import in the codebase. Everything else talks to
// the abstract `BillingProvider` seam, so swapping providers is a module
// binding change. House rule NN #22: official SDK, never a hand-rolled
// REST client — the SDK owns the wire contract, retries, idempotency
// headers and (critically here) the webhook signature verification.
import Stripe from 'stripe';
import { config } from '@src/config';
import type { BillingSubscriptionStatus } from '@src/entities/billing-profile.entity';
import {
    BillingProvider,
    BillingProviderError,
    BillingProviderNotConfiguredError,
    type BillingInvoiceLine,
    type BillingInvoiceSnapshot,
    type BillingPortalRequest,
    type BillingPortalSession,
    type BillingSubscriptionSnapshot,
    type BillingWebhookEvent,
    type BillingWebhookEventKind,
    type CheckoutSessionSnapshot,
    type CreditCheckoutRequest,
    type CreditCheckoutSession,
    type OffSessionChargeRequest,
    type OffSessionChargeResult,
    type PaymentMethodSummary,
    type PlanCheckoutRequest,
    type PlanCheckoutSession,
    type SubscriptionMutationRequest,
} from './billing.provider';

/**
 * Metadata keys stamped on every object we create at the provider. The
 * webhook reads ONLY these to decide whether an event is ours — which is
 * what stops a checkout's `payment_intent.succeeded` from crediting the
 * ledger a second time after `checkout.session.completed` already did.
 */
export const STRIPE_METADATA_KEYS = {
    kind: 'ever_works_kind',
    userId: 'ever_works_user_id',
    packId: 'ever_works_pack_id',
    referenceId: 'ever_works_reference_id',
    /**
     * Plan checkout (audit B24). Stamped on the checkout session AND
     * mirrored onto `subscription_data.metadata`, so the later
     * `customer.subscription.*` events still carry the plan we sold —
     * without it a renewal could not be attributed to a tier.
     */
    planCode: 'ever_works_plan_code',
} as const;

/** `kind` metadata values — how a purchase at the provider originated. */
export const STRIPE_PURCHASE_KINDS = {
    checkout: 'credit-topup',
    autoRecharge: 'credit-auto-recharge',
    /** A recurring plan subscription (audit B24). */
    planSubscription: 'plan-subscription',
} as const;

export type StripeClientFactory = (secretKey: string) => Stripe;

/**
 * Optional DI token for the SDK client factory. Nothing provides it in
 * production — the provider falls back to the real constructor. It exists
 * so a test (or a future sandbox harness) can inject a fake client
 * WITHOUT the vendor SDK leaking outside this file.
 *
 * It must be an explicit token: a plain default-valued constructor
 * parameter makes Nest try to resolve `Function` and crash the whole app
 * at boot (the known "DI boot-crash from an unresolvable provider" class).
 */
export const STRIPE_CLIENT_FACTORY = Symbol('STRIPE_CLIENT_FACTORY');

/**
 * Real payment provider behind the `BillingProvider` seam (billing PRD
 * §5.2 / B5), driven by the official Stripe Node SDK.
 *
 * ## Configuration
 *
 * Consumes the config getters that already existed and were unconsumed:
 * `config.billing.stripe.getSecretKey()` and `.getWebhookSecret()`
 * (`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`). Both are secrets:
 * they are read at call time, never logged, never returned from any API
 * response, and never written to an entity.
 *
 * ## Fail-closed
 *
 * - No secret key  → every money method throws
 *   `BillingProviderNotConfiguredError` (mapped to a 4xx/503 upstream).
 * - No webhook secret → `verifyAndParseWebhook` throws BEFORE looking at
 *   the payload. Same posture as the Slack / GitHub receivers: an
 *   unconfigured receiver rejects everything rather than trusting it.
 *
 * ## Signature verification
 *
 * `stripe.webhooks.constructEvent` performs the HMAC-SHA256 comparison
 * with the SDK's constant-time `secureCompare` and enforces the delivery
 * timestamp tolerance. We deliberately do NOT hand-roll that check —
 * re-implementing a vendor's signing scheme is exactly what NN #22 exists
 * to prevent. Any failure (missing header, bad digest, stale timestamp)
 * surfaces as a thrown `BillingProviderError` and the controller answers
 * 401.
 *
 * ## Trust boundary
 *
 * Every amount used downstream is read from the verified provider event
 * (`amount_total`, `amount_received`, `amount_refunded`), never from a
 * request body. The client only ever names a PACK ID.
 */
@Injectable()
export class StripeBillingProvider extends BillingProvider {
    private readonly logger = new Logger(StripeBillingProvider.name);
    private client: Stripe | null = null;
    private clientKey: string | null = null;

    /**
     * The factory is an OPTIONAL injection (unprovided in production) so
     * a test can substitute a fake client. Keeping the seam here rather
     * than exporting the SDK preserves the "nothing outside this file
     * imports the vendor SDK" rule.
     */
    constructor(
        @Optional()
        @Inject(STRIPE_CLIENT_FACTORY)
        private readonly clientFactory: StripeClientFactory = defaultStripeClient,
    ) {
        super();
    }

    getProviderId(): string {
        return 'stripe';
    }

    getDefaultCurrency(): string {
        return config.billing.getDefaultCurrency();
    }

    isConfigured(): boolean {
        return nonEmpty(config.billing.stripe.getSecretKey());
    }

    isWebhookConfigured(): boolean {
        return nonEmpty(config.billing.stripe.getWebhookSecret());
    }

    async ensureCustomer(input: {
        userId: string;
        email?: string | null;
        existingCustomerId?: string | null;
    }): Promise<string> {
        const stripe = this.requireClient();
        if (input.existingCustomerId) {
            return input.existingCustomerId;
        }
        const customer = await stripe.customers.create({
            email: input.email ?? undefined,
            metadata: { [STRIPE_METADATA_KEYS.userId]: input.userId },
        });
        return customer.id;
    }

    async createCreditCheckoutSession(
        request: CreditCheckoutRequest,
    ): Promise<CreditCheckoutSession> {
        const stripe = this.requireClient();
        const customerId = await this.ensureCustomer({
            userId: request.userId,
            email: request.userEmail,
            existingCustomerId: request.customerId,
        });

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            customer: customerId,
            client_reference_id: request.referenceId,
            success_url: request.successUrl,
            cancel_url: request.cancelUrl,
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        // Price comes from the SERVER-SIDE pack table.
                        currency: request.pack.currency,
                        unit_amount: request.pack.priceCents,
                        product_data: { name: request.pack.label },
                    },
                },
            ],
            // Metadata on the SESSION only. Deliberately not mirrored onto
            // `payment_intent_data.metadata`: that is what makes the
            // checkout's `payment_intent.succeeded` normalize to
            // `ignored`, so a single purchase credits the ledger once.
            metadata: {
                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.checkout,
                [STRIPE_METADATA_KEYS.userId]: request.userId,
                [STRIPE_METADATA_KEYS.packId]: request.pack.id,
                [STRIPE_METADATA_KEYS.referenceId]: request.referenceId,
            },
        });

        if (!session.url) {
            throw new BillingProviderError('Checkout session did not return a redirect URL');
        }
        return { url: session.url, sessionId: session.id, customerId };
    }

    /**
     * Recurring plan checkout (audit B24) — `mode: 'subscription'`.
     *
     * Two metadata stamps, deliberately:
     *   - on the SESSION, so `checkout.session.completed` is attributable
     *     and the return route can prove ownership;
     *   - mirrored onto `subscription_data.metadata`, so every later
     *     `customer.subscription.*` (renewal, cancel, dunning) still
     *     names the plan. Unlike the credit path — where mirroring onto
     *     the payment intent would double-credit — a subscription's
     *     lifecycle events are a DIFFERENT decision than the checkout, so
     *     they must carry the plan code themselves.
     */
    async createPlanCheckoutSession(request: PlanCheckoutRequest): Promise<PlanCheckoutSession> {
        const stripe = this.requireClient();
        const customerId = await this.ensureCustomer({
            userId: request.userId,
            email: request.userEmail,
            existingCustomerId: request.customerId,
        });

        const metadata = {
            [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
            [STRIPE_METADATA_KEYS.userId]: request.userId,
            [STRIPE_METADATA_KEYS.planCode]: request.plan.code,
            [STRIPE_METADATA_KEYS.referenceId]: request.referenceId,
        };

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            client_reference_id: request.referenceId,
            // The seam leaves the session-identifier token to the
            // implementation; this one is Stripe's.
            success_url: withSessionIdTemplate(request.successUrl),
            cancel_url: request.cancelUrl,
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        // Price comes from the SERVER plan row.
                        currency: request.plan.currency,
                        unit_amount: request.plan.priceCents,
                        recurring: { interval: request.plan.interval },
                        product_data: { name: request.plan.label },
                    },
                },
            ],
            metadata,
            subscription_data: { metadata },
        });

        if (!session.url) {
            throw new BillingProviderError('Checkout session did not return a redirect URL');
        }
        return { url: session.url, sessionId: session.id, customerId };
    }

    /**
     * Read one hosted checkout session back for the RETURN route.
     *
     * Everything the caller authorizes on (`userId`, `planCode`) comes
     * from the metadata WE wrote at creation time and the provider stored
     * server-side — the browser only ever supplies the session id.
     */
    async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionSnapshot> {
        const stripe = this.requireClient();
        let session: Stripe.Checkout.Session;
        try {
            session = await stripe.checkout.sessions.retrieve(sessionId, {
                expand: ['subscription'],
            });
        } catch {
            // Never echo the provider message — it can quote request params.
            throw new BillingProviderError('Checkout session could not be read');
        }

        const meta = session.metadata ?? {};
        const kind = meta[STRIPE_METADATA_KEYS.kind];
        const subscription = session.subscription;
        return {
            sessionId: session.id,
            status: normalizeSessionStatus(session.status),
            // A subscription with a trial settles with `no_payment_required`.
            paid:
                session.payment_status === 'paid' ||
                session.payment_status === 'no_payment_required',
            purpose:
                kind === STRIPE_PURCHASE_KINDS.planSubscription
                    ? 'plan'
                    : kind === STRIPE_PURCHASE_KINDS.checkout
                      ? 'credits'
                      : 'other',
            userId: meta[STRIPE_METADATA_KEYS.userId] ?? null,
            planCode: meta[STRIPE_METADATA_KEYS.planCode] ?? null,
            packId: meta[STRIPE_METADATA_KEYS.packId] ?? null,
            customerId: asId(session.customer),
            subscriptionId: asId(subscription),
            currentPeriodEnd:
                subscription && typeof subscription === 'object'
                    ? readCurrentPeriodEnd(subscription as Stripe.Subscription)
                    : null,
        };
    }

    async chargeOffSession(request: OffSessionChargeRequest): Promise<OffSessionChargeResult> {
        const stripe = this.requireClient();
        try {
            const intent = await stripe.paymentIntents.create(
                {
                    amount: request.pack.priceCents,
                    currency: request.pack.currency,
                    customer: request.customerId,
                    payment_method: request.paymentMethodRef,
                    off_session: true,
                    confirm: true,
                    metadata: {
                        [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.autoRecharge,
                        [STRIPE_METADATA_KEYS.userId]: request.userId,
                        [STRIPE_METADATA_KEYS.packId]: request.pack.id,
                    },
                },
                // Provider-level idempotency: a retried auto-recharge
                // resolves to the SAME payment intent, never a second charge.
                { idempotencyKey: request.idempotencyKey },
            );
            return {
                paymentId: intent.id,
                status: intent.status === 'succeeded' ? 'succeeded' : 'pending',
            };
        } catch (error) {
            const code = (error as { code?: string })?.code;
            // Never log the error object wholesale — it can echo request
            // params including the payment-method reference.
            this.logger.warn(
                `Off-session charge failed for user ${request.userId} (code=${code ?? 'unknown'})`,
            );
            return { paymentId: '', status: 'failed', failureCode: code };
        }
    }

    /**
     * Schedule the cancellation for the end of the paid period (B07).
     *
     * `cancel_at_period_end: true` is an UPDATE, not a delete: the
     * subscription keeps serving until the period ends and
     * {@link resumeSubscription} can reverse it. We deliberately never
     * call `subscriptions.cancel()` (immediate termination) from the
     * self-service path — the owner already paid for the period.
     */
    async cancelSubscriptionAtPeriodEnd(
        request: SubscriptionMutationRequest,
    ): Promise<BillingSubscriptionSnapshot> {
        const stripe = this.requireClient();
        const subscription = await stripe.subscriptions.update(request.subscriptionId, {
            cancel_at_period_end: true,
        });
        return toSubscriptionSnapshot(subscription);
    }

    /** Clear a pending at-period-end cancellation (B07). */
    async resumeSubscription(
        request: SubscriptionMutationRequest,
    ): Promise<BillingSubscriptionSnapshot> {
        const stripe = this.requireClient();
        const subscription = await stripe.subscriptions.update(request.subscriptionId, {
            cancel_at_period_end: false,
        });
        return toSubscriptionSnapshot(subscription);
    }

    /**
     * Hosted portal session — the PAST_DUE recovery action (B08). Card
     * re-entry happens entirely on the provider's tokenized surface, so
     * no cardholder datum reaches the platform, and the return URL is the
     * server-built one the caller passed.
     */
    async createBillingPortalSession(request: BillingPortalRequest): Promise<BillingPortalSession> {
        const stripe = this.requireClient();
        const session = await stripe.billingPortal.sessions.create({
            customer: request.customerId,
            return_url: request.returnUrl,
        });
        if (!session.url) {
            throw new BillingProviderError('Billing portal session did not return a redirect URL');
        }
        return { url: session.url };
    }

    async verifyAndParseWebhook(
        rawBody: string,
        signature: string | undefined,
    ): Promise<BillingWebhookEvent> {
        const webhookSecret = config.billing.stripe.getWebhookSecret();
        // FAIL CLOSED, before touching the payload.
        if (!nonEmpty(webhookSecret)) {
            throw new BillingProviderNotConfiguredError(
                'Billing webhook receiver is not configured',
            );
        }
        if (!nonEmpty(signature)) {
            throw new BillingProviderError('Missing webhook signature header');
        }

        const stripe = this.requireClient();
        let event: Stripe.Event;
        try {
            // Constant-time HMAC comparison + timestamp tolerance, done by
            // the SDK (see class docblock).
            event = stripe.webhooks.constructEvent(rawBody, signature as string, webhookSecret);
        } catch {
            // The thrown message can quote header content — never echo it.
            throw new BillingProviderError('Webhook signature verification failed');
        }

        return this.normalize(event);
    }

    // ── Normalization ────────────────────────────────────────────────

    private normalize(event: Stripe.Event): BillingWebhookEvent {
        const base = {
            id: event.id,
            providerType: event.type,
            referenceId: null as string | null,
            packId: null as string | null,
            amountCents: null as number | null,
            currency: null as string | null,
            paymentId: null as string | null,
            customerId: null as string | null,
        };

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;
                const meta = session.metadata ?? {};
                // A plan checkout activates a tier; it never touches the
                // credits ledger. Handled before the credit branch so the
                // two purchase kinds can never be confused.
                if (meta[STRIPE_METADATA_KEYS.kind] === STRIPE_PURCHASE_KINDS.planSubscription) {
                    // A subscription with a trial settles as
                    // `no_payment_required` — still a live plan.
                    if (
                        session.payment_status !== 'paid' &&
                        session.payment_status !== 'no_payment_required'
                    ) {
                        return { ...base, kind: 'ignored' };
                    }
                    return {
                        ...base,
                        kind: 'subscription.activated',
                        customerId: asId(session.customer),
                        referenceId: session.client_reference_id ?? null,
                        planCode: meta[STRIPE_METADATA_KEYS.planCode] ?? null,
                        subscriptionId: asId(session.subscription),
                        amountCents: session.amount_total ?? null,
                        currency: session.currency ?? null,
                        cancelAtPeriodEnd: false,
                    };
                }
                // Only OUR credit top-ups credit the ledger.
                if (meta[STRIPE_METADATA_KEYS.kind] !== STRIPE_PURCHASE_KINDS.checkout) {
                    return { ...base, kind: 'ignored' };
                }
                // An unpaid/expired session must never grant credits.
                if (session.payment_status !== 'paid') {
                    return { ...base, kind: 'ignored' };
                }
                return {
                    ...base,
                    kind: 'credits.purchased',
                    customerId: asId(session.customer),
                    referenceId: session.client_reference_id ?? null,
                    packId: meta[STRIPE_METADATA_KEYS.packId] ?? null,
                    amountCents: session.amount_total ?? null,
                    currency: session.currency ?? null,
                    paymentId: asId(session.payment_intent),
                };
            }

            case 'payment_intent.succeeded': {
                const intent = event.data.object as Stripe.PaymentIntent;
                const meta = intent.metadata ?? {};
                // Auto-recharge only. A checkout's payment intent carries
                // no metadata by design and lands in `ignored`.
                if (meta[STRIPE_METADATA_KEYS.kind] !== STRIPE_PURCHASE_KINDS.autoRecharge) {
                    return { ...base, kind: 'ignored' };
                }
                return {
                    ...base,
                    kind: 'credits.purchased',
                    customerId: asId(intent.customer),
                    packId: meta[STRIPE_METADATA_KEYS.packId] ?? null,
                    amountCents: intent.amount_received || intent.amount,
                    currency: intent.currency ?? null,
                    paymentId: intent.id,
                };
            }

            case 'charge.refunded': {
                const charge = event.data.object as Stripe.Charge;
                return {
                    ...base,
                    kind: 'credits.refunded',
                    customerId: asId(charge.customer),
                    amountCents: charge.amount_refunded ?? null,
                    currency: charge.currency ?? null,
                    paymentId: asId(charge.payment_intent),
                };
            }

            case 'charge.dispute.created': {
                const dispute = event.data.object as Stripe.Dispute;
                return {
                    ...base,
                    kind: 'credits.refunded',
                    amountCents: dispute.amount ?? null,
                    currency: dispute.currency ?? null,
                    paymentId: asId(dispute.payment_intent),
                };
            }

            case 'invoice.paid':
            case 'invoice.payment_failed':
            case 'invoice.finalized':
            case 'invoice.voided': {
                const invoice = event.data.object as Stripe.Invoice;
                return {
                    ...base,
                    kind: 'invoice.updated',
                    customerId: asId(invoice.customer),
                    currency: invoice.currency ?? null,
                    amountCents: invoice.total ?? null,
                    invoice: toInvoiceSnapshot(invoice),
                };
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.paused':
            case 'customer.subscription.resumed':
            case 'customer.subscription.deleted': {
                const subscription = event.data.object as Stripe.Subscription;
                const meta = subscription.metadata ?? {};
                // Only subscriptions WE sold carry a plan code. Anything
                // else on this account is not ours to act on.
                if (meta[STRIPE_METADATA_KEYS.kind] !== STRIPE_PURCHASE_KINDS.planSubscription) {
                    return { ...base, kind: 'ignored' };
                }
                const live =
                    event.type !== 'customer.subscription.deleted' &&
                    (subscription.status === 'active' || subscription.status === 'trialing');
                const shared = {
                    ...base,
                    customerId: asId(subscription.customer),
                    planCode: meta[STRIPE_METADATA_KEYS.planCode] ?? null,
                    referenceId: meta[STRIPE_METADATA_KEYS.referenceId] ?? null,
                    subscriptionId: subscription.id,
                    currentPeriodEnd: readCurrentPeriodEnd(subscription),
                    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
                    currency: subscription.currency ?? null,
                    // The snapshot rides on EVERY kind, not just the
                    // lifecycle one. An `active` update is how
                    // `cancel_at_period_end` first becomes true — if the
                    // snapshot only travelled with `subscription.updated`,
                    // a scheduled cancellation would never reach the
                    // billing profile and the resume button could never
                    // appear. The kind decides whether the TIER moves; the
                    // snapshot is projected regardless.
                    subscription: toSubscriptionSnapshot(subscription),
                };
                if (live) {
                    return { ...shared, kind: 'subscription.activated' };
                }
                // `incomplete` / `past_due` are transient dunning states —
                // the plan is not revoked until the provider says it is.
                if (
                    event.type === 'customer.subscription.deleted' ||
                    subscription.status === 'canceled' ||
                    subscription.status === 'unpaid' ||
                    subscription.status === 'incomplete_expired'
                ) {
                    return {
                        ...shared,
                        kind: 'subscription.canceled',
                        subscription:
                            event.type === 'customer.subscription.deleted'
                                ? // A delete is terminal regardless of what
                                  // the object still says about the period.
                                  {
                                      ...shared.subscription,
                                      status: 'canceled' as const,
                                      cancelAtPeriodEnd: false,
                                  }
                                : shared.subscription,
                    };
                }
                // Everything left is a LIFECYCLE move that must not touch
                // the tier: dunning (`past_due`), `paused`, `incomplete`.
                // Audit B24 returned `ignored` here, which is why the
                // product could never show a dunning banner or a resume
                // button — the events existed and were thrown away.
                // B07/B08 surfaces them as a snapshot instead. The tier is
                // still moved only by the two branches above.
                return { ...shared, kind: 'subscription.updated' };
            }

            case 'payment_method.attached': {
                const method = event.data.object as Stripe.PaymentMethod;
                return {
                    ...base,
                    kind: 'payment_method.updated',
                    customerId: asId(method.customer),
                    paymentMethod: toPaymentMethodSummary(method),
                };
            }

            default:
                return { ...base, kind: 'ignored' satisfies BillingWebhookEventKind };
        }
    }

    private requireClient(): Stripe {
        const secretKey = config.billing.stripe.getSecretKey();
        if (!nonEmpty(secretKey)) {
            throw new BillingProviderNotConfiguredError();
        }
        // Rebuild only when the key actually rotates (tests flip env).
        if (!this.client || this.clientKey !== secretKey) {
            const factory = this.clientFactory ?? defaultStripeClient;
            this.client = factory(secretKey as string);
            this.clientKey = secretKey as string;
        }
        return this.client;
    }
}

function defaultStripeClient(secretKey: string): Stripe {
    return new Stripe(secretKey);
}

function nonEmpty(value: string | undefined | null): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

/** Stripe expandable fields are `string | Object | null`. */
function asId(value: unknown): string | null {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object' && typeof (value as { id?: string }).id === 'string') {
        return (value as { id: string }).id;
    }
    return null;
}

/**
 * `current_period_end` moved from the subscription root onto each
 * subscription ITEM in recent API versions. Read both shapes so the
 * period end survives a provider API-version bump (it is display/renewal
 * metadata — a missing value degrades to `null`, never an error).
 */
function readCurrentPeriodEnd(subscription: Stripe.Subscription): Date | null {
    const raw = subscription as unknown as Record<string, unknown>;
    const root = raw['current_period_end'];
    if (typeof root === 'number') {
        return toUnixDate(root);
    }
    const firstItem = subscription.items?.data?.[0] as unknown as
        | Record<string, unknown>
        | undefined;
    const itemEnd = firstItem?.['current_period_end'];
    return typeof itemEnd === 'number' ? toUnixDate(itemEnd) : null;
}

/**
 * Append Stripe's `{CHECKOUT_SESSION_ID}` template to the caller's clean
 * success URL. The provider substitutes it at redirect time, which is
 * how the return route learns which session to read back. Kept in this
 * file because the token is vendor-specific.
 */
function withSessionIdTemplate(successUrl: string): string {
    if (successUrl.includes('{CHECKOUT_SESSION_ID}')) {
        return successUrl;
    }
    const separator = successUrl.includes('?') ? '&' : '?';
    return `${successUrl}${separator}session_id={CHECKOUT_SESSION_ID}`;
}

/** Provider session status → our closed set. Unknown ⇒ still `open`. */
function normalizeSessionStatus(
    status: Stripe.Checkout.Session['status'],
): CheckoutSessionSnapshot['status'] {
    if (status === 'complete' || status === 'expired') {
        return status;
    }
    return 'open';
}

function toUnixDate(seconds: number | null | undefined): Date | null {
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? new Date(seconds * 1000)
        : null;
}

function toInvoiceSnapshot(invoice: Stripe.Invoice): BillingInvoiceSnapshot {
    const raw = invoice as unknown as Record<string, unknown>;
    const lines: BillingInvoiceLine[] = (invoice.lines?.data ?? []).map((line) => ({
        description: line.description ?? '',
        quantity: line.quantity ?? 1,
        amountCents: line.amount ?? 0,
    }));

    const statusMap: Record<string, BillingInvoiceSnapshot['status']> = {
        draft: 'draft',
        open: 'open',
        paid: 'paid',
        void: 'void',
        uncollectible: 'uncollectible',
    };

    return {
        providerInvoiceId: invoice.id ?? '',
        number: invoice.number ?? null,
        status: statusMap[invoice.status ?? ''] ?? 'open',
        periodStart: toUnixDate(invoice.period_start),
        periodEnd: toUnixDate(invoice.period_end),
        subtotalCents: invoice.subtotal ?? 0,
        totalCents: invoice.total ?? 0,
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? 'usd',
        hostedUrl: invoice.hosted_invoice_url ?? null,
        pdfUrl: invoice.invoice_pdf ?? null,
        lines,
        issuedAt: toUnixDate((raw['created'] as number | undefined) ?? null),
    };
}

/**
 * Every provider lifecycle token maps 1:1 onto the platform's own set,
 * so this is a lookup, not a heuristic. An unrecognized token (a future
 * provider state) resolves to `none` rather than being trusted as active
 * — the fail-closed direction for anything that gates paid capability.
 */
const SUBSCRIPTION_STATUS_MAP: Record<string, BillingSubscriptionStatus> = {
    active: 'active',
    trialing: 'trialing',
    past_due: 'past_due',
    unpaid: 'unpaid',
    paused: 'paused',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
};

/**
 * Period end moved from the subscription onto its ITEMS in the current
 * API version, so read the item value first and keep the legacy
 * top-level field as a fallback — a webhook replay of an older delivery
 * must still yield a period end.
 */
function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
    const items = subscription.items?.data ?? [];
    for (const item of items) {
        const end = (item as unknown as Record<string, unknown>)['current_period_end'];
        if (typeof end === 'number') {
            return toUnixDate(end);
        }
    }
    const legacy = (subscription as unknown as Record<string, unknown>)['current_period_end'];
    return typeof legacy === 'number' ? toUnixDate(legacy) : null;
}

function toSubscriptionSnapshot(subscription: Stripe.Subscription): BillingSubscriptionSnapshot {
    return {
        subscriptionId: subscription.id,
        status: SUBSCRIPTION_STATUS_MAP[subscription.status] ?? 'none',
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        canceledAt: toUnixDate(subscription.canceled_at),
    };
}

function toPaymentMethodSummary(method: Stripe.PaymentMethod): PaymentMethodSummary {
    // ONLY display metadata. `method.card` never contains a PAN — Stripe
    // returns brand/last4/expiry and nothing else.
    return {
        ref: method.id,
        brand: method.card?.brand ?? null,
        last4: method.card?.last4 ?? null,
        expMonth: method.card?.exp_month ?? null,
        expYear: method.card?.exp_year ?? null,
    };
}
