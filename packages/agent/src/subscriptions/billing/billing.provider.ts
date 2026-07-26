import { Injectable } from '@nestjs/common';
import { config } from '@src/config';
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
    /** Populated for `payment_method.updated`. */
    readonly paymentMethod?: PaymentMethodSummary;
    /** Provider payment id, for correlation on refunds. */
    readonly paymentId: string | null;
    /** Raw provider event type, for logging/diagnostics. Never a secret. */
    readonly providerType: string;
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

    /** Off-session charge against a stored payment method (auto-recharge). */
    async chargeOffSession(_request: OffSessionChargeRequest): Promise<OffSessionChargeResult> {
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
