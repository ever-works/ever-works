import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
// THE ONLY vendor-SDK import in the codebase. Everything else talks to
// the abstract `BillingProvider` seam, so swapping providers is a module
// binding change. House rule NN #22: official SDK, never a hand-rolled
// REST client — the SDK owns the wire contract, retries, idempotency
// headers and (critically here) the webhook signature verification.
import Stripe from 'stripe';
import { config } from '@src/config';
import {
    BillingProvider,
    BillingProviderError,
    BillingProviderNotConfiguredError,
    type BillingInvoiceLine,
    type BillingInvoiceSnapshot,
    type BillingWebhookEvent,
    type BillingWebhookEventKind,
    type CreditCheckoutRequest,
    type CreditCheckoutSession,
    type OffSessionChargeRequest,
    type OffSessionChargeResult,
    type PaymentMethodSummary,
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
} as const;

/** `kind` metadata values — the two ways a credit purchase can originate. */
export const STRIPE_PURCHASE_KINDS = {
    checkout: 'credit-topup',
    autoRecharge: 'credit-auto-recharge',
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
