import { Injectable, Logger } from '@nestjs/common';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { CreditLedgerRepository } from '@src/database/repositories/credit-ledger.repository';
import { InvoiceRepository } from '@src/database/repositories/invoice.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { BillingProfile } from '@src/entities/billing-profile.entity';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { Invoice, InvoiceStatus } from '@src/entities/invoice.entity';
import { CreditLedgerService } from '../credits/credit-ledger.service';
import {
    BillingProvider,
    BillingProviderError,
    BillingProviderNotConfiguredError,
    type BillingWebhookEvent,
} from './billing.provider';
import { CREDIT_PACKS, findCreditPack, type CreditPack } from './credit-packs';

/** Correlation refType stamped on every purchase/refund ledger movement. */
export const BILLING_PAYMENT_REF_TYPE = 'billing-payment';

/** A checkout was asked for with an id that is not in the server pack table. */
export class UnknownCreditPackError extends Error {
    constructor(packId: string) {
        super(`Unknown credit pack: ${packId}`);
        this.name = 'UnknownCreditPackError';
    }
}

export interface StartCreditCheckoutOptions {
    userId: string;
    packId: string;
    successUrl: string;
    cancelUrl: string;
    organizationId?: string | null;
    tenantId?: string | null;
}

export interface CreditCheckoutStarted {
    url: string;
    sessionId: string;
    packId: string;
    /** Echoed for the UI's confirmation copy — from the SERVER pack. */
    priceCents: number;
    credits: number;
}

export interface BillingOverview {
    providerConfigured: boolean;
    providerId: string;
    currency: string;
    packs: readonly CreditPack[];
    balanceCredits: number;
    paymentMethod: {
        brand: string | null;
        last4: string | null;
        expMonth: number | null;
        expYear: number | null;
    } | null;
    autoRecharge: {
        enabled: boolean;
        thresholdCredits: number | null;
        packId: string | null;
        failureCount: number;
    };
}

export interface WebhookOutcome {
    /** Provider event id — echoed for log correlation. */
    eventId: string;
    kind: BillingWebhookEvent['kind'];
    /** What the handler actually did. */
    action:
        | 'credited'
        | 'credited-idempotent'
        | 'reversed'
        | 'reversed-idempotent'
        | 'invoice-mirrored'
        | 'payment-method-updated'
        | 'ignored'
        | 'unattributed';
    creditsDelta?: number;
}

/**
 * The money path (billing PRD §5.2 / B5). Sits between the API
 * controllers and the `BillingProvider` seam and owns three rules:
 *
 * 1. **The server prices everything.** Checkout takes a pack ID; the
 *    price and credit count come from {@link CREDIT_PACKS}. A client
 *    never supplies an amount (the DTO rejects one outright), and even if
 *    it did, nothing here would read it.
 *
 * 2. **Ledger writes are idempotent on the provider event id.** Every
 *    credit/reversal uses `idempotencyKey = '{provider}:evt:{eventId}'`,
 *    so a webhook replay — which providers do routinely — resolves to the
 *    existing row and moves the balance zero times.
 *
 * 3. **Amounts come from the verified event, never from the request.**
 *    The controller hands over the raw body + signature; the provider
 *    verifies and normalizes; only then is a number read.
 *
 * Purchases are attributed by provider customer id → `billing_profiles`.
 * An event we cannot attribute is acknowledged and logged, never 500'd
 * (a 5xx makes the provider retry a delivery we will never resolve).
 */
@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);

    constructor(
        private readonly billingProvider: BillingProvider,
        private readonly billingProfileRepository: BillingProfileRepository,
        private readonly invoiceRepository: InvoiceRepository,
        private readonly creditLedgerRepository: CreditLedgerRepository,
        private readonly creditLedgerService: CreditLedgerService,
        private readonly userRepository: UserRepository,
    ) {}

    /** Server-side pack table — the only source of prices. */
    getPacks(): readonly CreditPack[] {
        return CREDIT_PACKS;
    }

    isProviderConfigured(): boolean {
        return this.billingProvider.isConfigured();
    }

    /**
     * Start a hosted checkout for a credit top-up.
     *
     * Rejects unknown pack ids with a stable-named error and never accepts
     * an amount. Lazily creates the provider customer + `billing_profiles`
     * row on first purchase.
     */
    async startCreditCheckout(options: StartCreditCheckoutOptions): Promise<CreditCheckoutStarted> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }

        const pack = findCreditPack(options.packId);
        if (!pack) {
            throw new UnknownCreditPackError(String(options.packId));
        }

        const user = await this.userRepository.findById(options.userId);
        const existing = await this.billingProfileRepository.findByUserId(options.userId);

        const customerId = await this.billingProvider.ensureCustomer({
            userId: options.userId,
            email: user?.email ?? null,
            existingCustomerId: existing?.providerCustomerId ?? null,
        });

        const profile = await this.billingProfileRepository.ensure({
            userId: options.userId,
            provider: this.billingProvider.getProviderId(),
            providerCustomerId: customerId,
            organizationId: options.organizationId ?? null,
            tenantId: options.tenantId ?? null,
        });

        const session = await this.billingProvider.createCreditCheckoutSession({
            userId: options.userId,
            userEmail: user?.email ?? null,
            customerId: profile.providerCustomerId,
            pack,
            successUrl: options.successUrl,
            cancelUrl: options.cancelUrl,
            referenceId: `${options.userId}:${pack.id}`,
        });

        return {
            url: session.url,
            sessionId: session.sessionId,
            packId: pack.id,
            priceCents: pack.priceCents,
            credits: pack.credits,
        };
    }

    /** One round-trip snapshot for the Billing page (PRD §5.2). */
    async getOverview(userId: string): Promise<BillingOverview> {
        const [profile, balanceCredits] = await Promise.all([
            this.billingProfileRepository.findByUserId(userId),
            this.creditLedgerService.getBalance(userId),
        ]);

        return {
            providerConfigured: this.billingProvider.isConfigured(),
            providerId: this.billingProvider.getProviderId(),
            currency: this.billingProvider.getDefaultCurrency(),
            packs: CREDIT_PACKS,
            balanceCredits,
            paymentMethod: profile?.defaultPaymentMethodRef
                ? {
                      brand: profile.paymentMethodBrand ?? null,
                      last4: profile.paymentMethodLast4 ?? null,
                      expMonth: profile.paymentMethodExpMonth ?? null,
                      expYear: profile.paymentMethodExpYear ?? null,
                  }
                : null,
            autoRecharge: {
                enabled: profile?.autoRechargeEnabled ?? false,
                thresholdCredits: profile?.autoRechargeThresholdCredits ?? null,
                packId: profile?.autoRechargePackId ?? null,
                failureCount: profile?.autoRechargeFailureCount ?? 0,
            },
        };
    }

    /** Owner-scoped invoice history (PRD §3.5). */
    async listInvoices(
        userId: string,
        page = 1,
        pageSize = 10,
    ): Promise<{ invoices: Invoice[]; total: number; page: number; pageSize: number }> {
        const safePage = Math.max(1, Math.trunc(page));
        const safeSize = Math.min(50, Math.max(1, Math.trunc(pageSize)));
        const { invoices, total } = await this.invoiceRepository.findForUser(userId, {
            skip: (safePage - 1) * safeSize,
            take: safeSize,
        });
        return { invoices, total, page: safePage, pageSize: safeSize };
    }

    /** Update the auto-recharge settings on the owner's billing profile. */
    async updateAutoRecharge(
        userId: string,
        settings: { enabled: boolean; thresholdCredits?: number | null; packId?: string | null },
    ): Promise<BillingProfile> {
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile) {
            throw new BillingProviderError(
                'Add a payment method before enabling auto-recharge',
                'no-billing-profile',
            );
        }
        if (settings.enabled) {
            if (!profile.defaultPaymentMethodRef) {
                throw new BillingProviderError(
                    'Add a payment method before enabling auto-recharge',
                    'no-payment-method',
                );
            }
            if (settings.packId && !findCreditPack(settings.packId)) {
                throw new UnknownCreditPackError(String(settings.packId));
            }
        }

        const updated = await this.billingProfileRepository.updateAutoRecharge(userId, {
            autoRechargeEnabled: settings.enabled,
            autoRechargeThresholdCredits: settings.thresholdCredits ?? null,
            autoRechargePackId: settings.packId ?? null,
        });
        return updated ?? profile;
    }

    // ── Webhook ──────────────────────────────────────────────────────

    /**
     * Verify + apply one provider delivery.
     *
     * Verification is the provider's job (fail-closed there); attribution
     * and ledger effects are ours. Every write is keyed on the provider
     * EVENT id, so re-delivery is a no-op.
     */
    async handleWebhook(rawBody: string, signature: string | undefined): Promise<WebhookOutcome> {
        const event = await this.billingProvider.verifyAndParseWebhook(rawBody, signature);

        switch (event.kind) {
            case 'credits.purchased':
                return this.applyPurchase(event);
            case 'credits.refunded':
                return this.applyRefund(event);
            case 'invoice.updated':
                return this.mirrorInvoice(event);
            case 'payment_method.updated':
                return this.applyPaymentMethod(event);
            case 'ignored':
            default:
                return { eventId: event.id, kind: event.kind, action: 'ignored' };
        }
    }

    private async applyPurchase(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        const profile = await this.resolveProfile(event);
        if (!profile) {
            return this.unattributed(event);
        }

        // The credits granted come from the SERVER pack table keyed by the
        // pack id we stamped at checkout — not from the event's amount and
        // certainly not from any client. The event's amount is still read
        // (below) as the authoritative record of what was charged.
        const pack = findCreditPack(event.packId);
        if (!pack) {
            this.logger.warn(
                `Billing webhook ${event.id}: purchase carries unknown pack '${event.packId}' — ignored`,
            );
            return { eventId: event.id, kind: event.kind, action: 'ignored' };
        }

        const idempotencyKey = this.eventKey(event.id);
        const already = await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey);

        const entry = await this.creditLedgerService.record({
            userId: profile.userId,
            organizationId: profile.organizationId ?? null,
            tenantId: profile.tenantId ?? null,
            kind: CreditLedgerKind.PURCHASE,
            amountCredits: pack.credits,
            // Amount ACTUALLY charged, straight from the verified event.
            costCentsRef: event.amountCents ?? pack.priceCents,
            refType: BILLING_PAYMENT_REF_TYPE,
            refId: event.paymentId ?? null,
            description: `Credit top-up — ${pack.label}`,
            idempotencyKey,
        });

        // A purchase settles any in-flight auto-recharge for this owner.
        await this.billingProfileRepository.releaseAutoRechargeSlot(profile.userId);
        await this.billingProfileRepository.resetAutoRechargeFailures(profile.userId);

        return {
            eventId: event.id,
            kind: event.kind,
            action: already ? 'credited-idempotent' : 'credited',
            creditsDelta: already ? 0 : (entry?.amountCredits ?? 0),
        };
    }

    private async applyRefund(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        const profile = await this.resolveProfile(event);
        if (!profile) {
            return this.unattributed(event);
        }

        // Size the reversal from what was actually GRANTED for this
        // payment, scaled by the refunded share. Re-deriving from the pack
        // table would misprice a refund of a pack that has since changed.
        const original = event.paymentId
            ? await this.creditLedgerRepository.findLatestByRef(
                  BILLING_PAYMENT_REF_TYPE,
                  event.paymentId,
              )
            : null;
        if (!original || original.amountCredits <= 0) {
            this.logger.warn(
                `Billing webhook ${event.id}: refund has no matching purchase — ignored`,
            );
            return { eventId: event.id, kind: event.kind, action: 'ignored' };
        }

        const chargedCents = original.costCentsRef ?? 0;
        const refundedCents = event.amountCents ?? chargedCents;
        const share = chargedCents > 0 ? Math.min(1, Math.max(0, refundedCents / chargedCents)) : 1;
        const reverseCredits = Math.min(
            original.amountCredits,
            Math.max(1, Math.round(original.amountCredits * share)),
        );

        const idempotencyKey = this.eventKey(event.id);
        const already = await this.creditLedgerRepository.findByIdempotencyKey(idempotencyKey);

        await this.creditLedgerService.record({
            userId: profile.userId,
            organizationId: profile.organizationId ?? null,
            tenantId: profile.tenantId ?? null,
            kind: CreditLedgerKind.ADJUSTMENT,
            amountCredits: -reverseCredits,
            costCentsRef: refundedCents,
            refType: BILLING_PAYMENT_REF_TYPE,
            refId: event.paymentId ?? null,
            description: 'Refund / chargeback reversal',
            // A reversal must land even if it drives the balance negative —
            // the user already spent credits they were refunded for.
            allowNegativeBalance: true,
            idempotencyKey,
        });

        return {
            eventId: event.id,
            kind: event.kind,
            action: already ? 'reversed-idempotent' : 'reversed',
            creditsDelta: already ? 0 : -reverseCredits,
        };
    }

    private async mirrorInvoice(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        const profile = await this.resolveProfile(event);
        if (!profile || !event.invoice) {
            return this.unattributed(event);
        }
        const snapshot = event.invoice;
        await this.invoiceRepository.mirror({
            userId: profile.userId,
            organizationId: profile.organizationId ?? null,
            tenantId: profile.tenantId ?? null,
            provider: profile.provider,
            providerInvoiceId: snapshot.providerInvoiceId,
            number: snapshot.number,
            status: snapshot.status as InvoiceStatus,
            periodStart: snapshot.periodStart,
            periodEnd: snapshot.periodEnd,
            subtotalCents: snapshot.subtotalCents,
            totalCents: snapshot.totalCents,
            amountPaidCents: snapshot.amountPaidCents,
            currency: snapshot.currency,
            hostedUrl: snapshot.hostedUrl,
            pdfUrl: snapshot.pdfUrl,
            lineItems: snapshot.lines.map((line) => ({
                description: line.description,
                quantity: line.quantity,
                amountCents: line.amountCents,
            })),
            issuedAt: snapshot.issuedAt,
        });
        return { eventId: event.id, kind: event.kind, action: 'invoice-mirrored' };
    }

    private async applyPaymentMethod(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        const profile = await this.resolveProfile(event);
        if (!profile || !event.paymentMethod) {
            return this.unattributed(event);
        }
        await this.billingProfileRepository.updatePaymentMethod(profile.userId, {
            // Opaque token ref + display metadata ONLY.
            defaultPaymentMethodRef: event.paymentMethod.ref,
            paymentMethodBrand: event.paymentMethod.brand,
            paymentMethodLast4: event.paymentMethod.last4,
            paymentMethodExpMonth: event.paymentMethod.expMonth,
            paymentMethodExpYear: event.paymentMethod.expYear,
        });
        return { eventId: event.id, kind: event.kind, action: 'payment-method-updated' };
    }

    private async resolveProfile(event: BillingWebhookEvent): Promise<BillingProfile | null> {
        if (event.customerId) {
            const byCustomer = await this.billingProfileRepository.findByCustomerId(
                this.billingProvider.getProviderId(),
                event.customerId,
            );
            if (byCustomer) {
                return byCustomer;
            }
        }
        // `referenceId` is `{userId}:{packId}` — set by US at checkout and
        // echoed back inside the SIGNED event, so it is server-authored
        // data, not client input.
        if (event.referenceId) {
            const [userId] = event.referenceId.split(':');
            if (userId) {
                return this.billingProfileRepository.findByUserId(userId);
            }
        }
        return null;
    }

    private unattributed(event: BillingWebhookEvent): WebhookOutcome {
        this.logger.warn(
            `Billing webhook ${event.id} (${event.providerType}) could not be attributed to an owner — acknowledged`,
        );
        return { eventId: event.id, kind: event.kind, action: 'unattributed' };
    }

    /** `{provider}:evt:{eventId}` — the replay guard for every write. */
    private eventKey(eventId: string): string {
        return `${this.billingProvider.getProviderId()}:evt:${eventId}`;
    }
}
