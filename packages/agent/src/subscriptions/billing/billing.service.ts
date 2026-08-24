import { Injectable, Logger, Optional } from '@nestjs/common';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { CreditLedgerRepository } from '@src/database/repositories/credit-ledger.repository';
import { InvoiceRepository } from '@src/database/repositories/invoice.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import {
    BillingProfile,
    isPastDueSubscriptionStatus,
    type BillingSubscriptionStatus,
} from '@src/entities/billing-profile.entity';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { Invoice, InvoiceStatus } from '@src/entities/invoice.entity';
import { CreditLedgerService } from '../credits/credit-ledger.service';
import {
    BillingProvider,
    BillingProviderError,
    BillingProviderNotConfiguredError,
    type BillingSubscriptionSnapshot,
    type BillingWebhookEvent,
} from './billing.provider';
import { CREDIT_PACKS, findCreditPack, type CreditPack } from './credit-packs';
import { PlanSubscriptionService } from './plan-subscription.service';
import { PaygService, type PaygStateView } from './payg.service';

/** Correlation refType stamped on every purchase/refund ledger movement. */
export const BILLING_PAYMENT_REF_TYPE = 'billing-payment';

/** A checkout was asked for with an id that is not in the server pack table. */
export class UnknownCreditPackError extends Error {
    constructor(packId: string) {
        super(`Unknown credit pack: ${packId}`);
        this.name = 'UnknownCreditPackError';
    }
}

/**
 * A lifecycle mutation (cancel / resume / portal) was asked for on an
 * owner who has no manageable provider subscription. Stable `name` so the
 * API boundary maps it to a 409 instead of an unmapped 500.
 *
 * This is also what a CROSS-OWNER attempt surfaces as: every lifecycle
 * call resolves the profile from the authenticated user id, so asking
 * about somebody else's subscription resolves to "you have none".
 */
export class NoActiveSubscriptionError extends Error {
    constructor(message = 'No manageable subscription for this account') {
        super(message);
        this.name = 'NoActiveSubscriptionError';
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

/**
 * The subscription lifecycle as the Billing page renders it (audit
 * B07/B08). Deliberately does NOT carry the provider subscription id:
 * the client never needs it, and every mutation is resolved server-side
 * from the session user.
 */
export interface SubscriptionStateView {
    status: BillingSubscriptionStatus;
    /** Cancel requested; the plan runs until `currentPeriodEnd`. */
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    canceledAt: Date | null;
    /** `past_due` / `unpaid` — drives the recovery banner. */
    pastDue: boolean;
    /** There is a real provider subscription that cancel/resume can act on. */
    manageable: boolean;
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
    /** Real lifecycle state — the status chip is no longer assumed active. */
    subscription: SubscriptionStateView;
    /** Pay-as-you-go state (billing spec §3.5); `null` when the collaborator is not wired. */
    payg: PaygStateView | null;
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
        | 'payment-method-removed'
        | 'payment-method-removed-noop'
        // Paid-plan lifecycle (audit B24) — delegated to
        // `PlanSubscriptionService`, which owns the tier grant/revoke.
        | 'subscription-activated'
        | 'subscription-canceled'
        | 'subscription-reconciled'
        // Pay-as-you-go usage subscription lifecycle (billing spec §3.5).
        | 'payg-reconciled'
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
        /**
         * Paid-plan lifecycle (audit B24). Appended LAST so every
         * existing positional construction in the specs keeps working;
         * `@Optional()` so a caller that only needs the credits path can
         * still build the service without the plan collaborator.
         */
        @Optional()
        private readonly planSubscriptionService?: PlanSubscriptionService,
        /**
         * Pay-as-you-go (billing spec §3.5). Appended LAST + `@Optional()`
         * for the same arity reason as the plan collaborator.
         */
        @Optional()
        private readonly paygService?: PaygService,
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
        const [profile, balanceCredits, payg] = await Promise.all([
            this.billingProfileRepository.findByUserId(userId),
            this.creditLedgerService.getBalance(userId),
            this.paygService
                ? this.paygService.getState(userId).catch((error: unknown) => {
                      this.logger.warn(
                          `Billing overview: pay-as-you-go state unavailable for ${userId}: ${
                              error instanceof Error ? error.message : String(error)
                          }`,
                      );
                      return null;
                  })
                : Promise.resolve(null),
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
            subscription: this.toSubscriptionState(profile),
            payg,
        };
    }

    // ── Subscription lifecycle (audit B07/B08) ───────────────────────

    /**
     * Project the persisted lifecycle columns into what the UI renders.
     *
     * No profile, or no provider subscription id, ⇒ `none` + not
     * manageable: the account is on the free tier (or payments are not
     * wired), so the page shows a plain plan card and no cancel control
     * rather than a button that would 409.
     */
    private toSubscriptionState(profile: BillingProfile | null): SubscriptionStateView {
        const status: BillingSubscriptionStatus = profile?.subscriptionStatus ?? 'none';
        const hasSubscription = Boolean(profile?.providerSubscriptionId);
        return {
            status,
            cancelAtPeriodEnd: profile?.cancelAtPeriodEnd ?? false,
            currentPeriodEnd: profile?.currentPeriodEnd ?? null,
            canceledAt: profile?.subscriptionCanceledAt ?? null,
            pastDue: isPastDueSubscriptionStatus(profile?.subscriptionStatus),
            // Manageable only when the provider is wired AND we hold an
            // id to act on — otherwise cancel/resume have nothing to call.
            manageable: hasSubscription && this.billingProvider.isConfigured(),
        };
    }

    /**
     * Schedule a cancellation for the end of the paid period (B07).
     *
     * Owner-scoped by construction: the profile is resolved from the
     * AUTHENTICATED user id — there is no subscription id parameter to
     * smuggle, so no caller can reach another account's (or another
     * org's) subscription. {@link requireOwnedSubscription} additionally
     * re-checks ownership on the row that came back, so a future lookup
     * bug cannot turn into a cross-owner mutation.
     */
    async cancelSubscription(userId: string): Promise<SubscriptionStateView> {
        const profile = await this.requireOwnedSubscription(userId);
        const snapshot = await this.billingProvider.cancelSubscriptionAtPeriodEnd({
            subscriptionId: profile.providerSubscriptionId as string,
        });
        return this.persistSubscriptionSnapshot(userId, snapshot);
    }

    /** Undo a pending at-period-end cancellation (B07). */
    async resumeSubscription(userId: string): Promise<SubscriptionStateView> {
        const profile = await this.requireOwnedSubscription(userId);
        if (profile.subscriptionStatus === 'canceled') {
            // Already ended — there is nothing to resume, and pretending
            // otherwise would leave the UI showing a plan that is gone.
            throw new NoActiveSubscriptionError('This subscription has already ended');
        }
        const snapshot = await this.billingProvider.resumeSubscription({
            subscriptionId: profile.providerSubscriptionId as string,
        });
        return this.persistSubscriptionSnapshot(userId, snapshot);
    }

    /**
     * Hosted portal session — the PAST_DUE recovery action (B08).
     *
     * Needs only a provider CUSTOMER (not a subscription), so an owner
     * whose card failed can fix it even after the subscription lapsed.
     * The return URL is built by the caller from the platform's own web
     * origin; nothing from the browser reaches the provider.
     */
    async createBillingPortalSession(userId: string, returnUrl: string): Promise<{ url: string }> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile || profile.userId !== userId || !profile.providerCustomerId) {
            throw new NoActiveSubscriptionError('No billing account for this user');
        }
        return this.billingProvider.createBillingPortalSession({
            customerId: profile.providerCustomerId,
            returnUrl,
        });
    }

    /**
     * Resolve the caller's OWN profile and assert it carries a
     * subscription the provider can act on.
     *
     * The `profile.userId !== userId` re-check is deliberate defence in
     * depth: the lookup is already keyed by user id, so a mismatch can
     * only mean a future bug in the query — and a mismatch here would be
     * a cross-account mutation, the one failure this path must never have.
     */
    private async requireOwnedSubscription(userId: string): Promise<BillingProfile> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile || profile.userId !== userId) {
            throw new NoActiveSubscriptionError();
        }
        if (!profile.providerSubscriptionId) {
            throw new NoActiveSubscriptionError();
        }
        return profile;
    }

    /** Persist a provider snapshot and return the projected view. */
    private async persistSubscriptionSnapshot(
        userId: string,
        snapshot: BillingSubscriptionSnapshot,
    ): Promise<SubscriptionStateView> {
        const updated = await this.billingProfileRepository.updateSubscriptionState(userId, {
            providerSubscriptionId: snapshot.subscriptionId,
            subscriptionStatus: snapshot.status,
            cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            subscriptionCanceledAt: snapshot.canceledAt,
        });
        // The row read-back is authoritative when we have it; the
        // snapshot is the fallback so a repository that returns nothing
        // still yields the state the provider just confirmed.
        return updated
            ? this.toSubscriptionState(updated)
            : {
                  status: snapshot.status,
                  cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
                  currentPeriodEnd: snapshot.currentPeriodEnd,
                  canceledAt: snapshot.canceledAt,
                  pastDue: isPastDueSubscriptionStatus(snapshot.status),
                  manageable: this.billingProvider.isConfigured(),
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
            case 'payment_method.removed':
                return this.applyPaymentMethodRemoved(event);
            case 'subscription.activated':
            case 'subscription.canceled':
            case 'subscription.updated':
                return this.applySubscription(event);
            case 'payg.updated':
                return this.applyPayg(event);
            case 'ignored':
            default:
                return { eventId: event.id, kind: event.kind, action: 'ignored' };
        }
    }

    /**
     * Subscription deliveries — the ONE entry point for all three kinds.
     *
     * Two things can happen, and they are deliberately separate:
     *
     *  1. **The snapshot projection** (audit B07/B08) runs for every kind
     *     that carries one. It is what the Billing page reads: the status
     *     chip, the past-due banner, a pending at-period-end cancel. A
     *     `past_due` or `paused` delivery moves ONLY this.
     *  2. **The tier move** (audit B24) is delegated to
     *     `PlanSubscriptionService` and happens for exactly two kinds —
     *     `subscription.activated` and `subscription.canceled`. Nothing
     *     else may grant or revoke a paid plan.
     *
     * Keeping (2) narrow is the point. Before these were separated, the
     * plan handler's `else` branch revoked on every non-activation kind,
     * so a dunning delivery would have downgraded a paying customer.
     *
     * A deployment that lacks the plan collaborator acknowledges the
     * delivery rather than 500-ing it into an infinite provider retry.
     */
    private async applySubscription(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        const reconciled = await this.reconcileSubscriptionSnapshot(event);

        if (event.kind === 'subscription.activated' || event.kind === 'subscription.canceled') {
            if (!this.planSubscriptionService) {
                this.logger.warn(
                    `Billing webhook ${event.id}: subscription event received but plan handling is not wired — acknowledged`,
                );
                return { eventId: event.id, kind: event.kind, action: 'ignored' };
            }
            const action = await this.planSubscriptionService.applyWebhook(event);
            return { eventId: event.id, kind: event.kind, action };
        }

        if (!reconciled) {
            return this.unattributed(event);
        }
        return { eventId: event.id, kind: event.kind, action: 'subscription-reconciled' };
    }

    /**
     * The pay-as-you-go usage subscription's lifecycle (billing spec §3.5)
     * — delegated whole to `PaygService`, which owns those columns. Never
     * reaches `PlanSubscriptionService`: the usage subscription carries no
     * plan code and must never move a tier.
     */
    private async applyPayg(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        if (!this.paygService) {
            this.logger.warn(
                `Billing webhook ${event.id}: pay-as-you-go event received but PAYG is not wired — acknowledged`,
            );
            return { eventId: event.id, kind: event.kind, action: 'ignored' };
        }
        const action = await this.paygService.applyWebhook(event);
        return { eventId: event.id, kind: event.kind, action };
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
        const mirrored = await this.invoiceRepository.mirror({
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
        // A pay-as-you-go invoice also drives the usage subscription's
        // suspend/resume (billing spec FR-21). Best-effort: a failure here
        // must not un-mirror the invoice or 500 the delivery.
        if (snapshot.subscriptionKind === 'payg' && this.paygService) {
            try {
                const effectiveStatus = mirrored.status ?? snapshot.status;
                await this.paygService.applyInvoice(profile, {
                    ...snapshot,
                    status: effectiveStatus,
                    // A retained PAID mirror means this is an older failure
                    // delivery for the same invoice, not a new dunning event.
                    paymentFailed:
                        Boolean(snapshot.paymentFailed) && effectiveStatus !== InvoiceStatus.PAID,
                });
            } catch (error) {
                this.logger.warn(
                    `Billing webhook ${event.id}: pay-as-you-go invoice handling failed (ignored): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
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

    /**
     * A card was detached at the provider (our own remove route, or the
     * provider dashboard). Clear the stored summary ONLY when the removed
     * reference is the one we hold — detaching a non-default card must
     * not blank the default — and take auto-recharge down with it, since
     * an off-session charge is inoperable without a stored method.
     */
    private async applyPaymentMethodRemoved(event: BillingWebhookEvent): Promise<WebhookOutcome> {
        const profile = await this.resolveProfile(event);
        if (!profile || !event.paymentMethod) {
            return this.unattributed(event);
        }
        if (profile.defaultPaymentMethodRef !== event.paymentMethod.ref) {
            return { eventId: event.id, kind: event.kind, action: 'payment-method-removed-noop' };
        }
        await this.billingProfileRepository.updatePaymentMethod(profile.userId, {
            defaultPaymentMethodRef: null,
            paymentMethodBrand: null,
            paymentMethodLast4: null,
            paymentMethodExpMonth: null,
            paymentMethodExpYear: null,
        });
        if (profile.autoRechargeEnabled) {
            await this.billingProfileRepository.updateAutoRecharge(profile.userId, {
                autoRechargeEnabled: false,
                autoRechargeThresholdCredits: profile.autoRechargeThresholdCredits ?? null,
                autoRechargePackId: profile.autoRechargePackId ?? null,
            });
        }
        return { eventId: event.id, kind: event.kind, action: 'payment-method-removed' };
    }

    /**
     * Reconcile the provider's view of the subscription onto the owner's
     * profile (audit B07/B08).
     *
     * This is what makes the status chip and the PAST_DUE banner true
     * without anyone visiting the page: dunning, recovery, an
     * out-of-band cancellation in the provider's own portal, and the
     * terminal delete all arrive here and overwrite the same columns.
     *
     * Naturally idempotent — it is a last-write-wins projection of state,
     * not a ledger movement, so a replayed delivery writes the same row.
     */
    private async reconcileSubscriptionSnapshot(event: BillingWebhookEvent): Promise<boolean> {
        const profile = await this.resolveProfile(event);
        if (!profile || !event.subscription) {
            return false;
        }
        const snapshot = event.subscription;
        await this.billingProfileRepository.updateSubscriptionState(profile.userId, {
            providerSubscriptionId: snapshot.subscriptionId,
            subscriptionStatus: snapshot.status,
            cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            subscriptionCanceledAt: snapshot.canceledAt,
        });
        return true;
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
