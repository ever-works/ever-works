import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { BillingProvider, BillingProviderNotConfiguredError } from './billing.provider';

/**
 * The client asked for a payment method that is not on the caller's own
 * provider customer — it does not exist, or it belongs to somebody else.
 * Both answer 404: a distinct "exists but is not yours" status would turn
 * this route into an oracle for other accounts' stored cards.
 */
export class PaymentMethodNotFoundError extends Error {
    constructor(message = 'Payment method not found') {
        super(message);
        this.name = 'PaymentMethodNotFoundError';
    }
}

/**
 * Removing the LAST payment method while a paid subscription is active.
 *
 * **The behaviour is: refuse, with a 409.** That is what the rest of this
 * codebase implies rather than a choice made here:
 *
 *   - `BillingService.updateAutoRecharge` already answers 409 for
 *     "no payment method on file" instead of silently degrading, and the
 *     web layer already has copy for that status.
 *   - Paid plans cannot be self-assigned (`POST /api/subscriptions/plan`
 *     answers 403); a paid tier is only ever reached through a
 *     billing-verified path. Letting a user strand their own paid
 *     subscription with nothing to charge would create exactly the state
 *     that rule exists to prevent — and silently cancelling their plan
 *     from a DELETE on an unrelated resource would be worse.
 *   - The money path's stated posture is "fail closed, never guess"
 *     (billing PRD §6). Refusing is the fail-closed answer; the user is
 *     told to add a replacement first (add-then-remove always works,
 *     since the check is only about the LAST one).
 */
export class LastPaymentMethodError extends Error {
    constructor(
        message = 'Add another payment method before removing the last one on a paid plan',
    ) {
        super(message);
        this.name = 'LastPaymentMethodError';
    }
}

/**
 * One stored card as it crosses the wire.
 *
 * `id` is a **derived handle**, not the provider reference. See
 * {@link paymentMethodHandle}.
 */
export interface PaymentMethodRow {
    id: string;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    isDefault: boolean;
}

export interface PaymentMethodList {
    providerConfigured: boolean;
    methods: PaymentMethodRow[];
}

export interface PaymentMethodSetupStarted {
    url: string;
    sessionId: string;
}

/**
 * Stable, non-reversible handle for a provider payment-method reference.
 *
 * The opaque `pm_…` reference never leaves the API — the same rule the
 * billing overview projection already follows. The client addresses a
 * card by `sha256(ref)` instead, and every mutation resolves that handle
 * by scanning the CALLER'S OWN methods. A handle lifted from another
 * account therefore matches nothing and answers 404: selecting a card
 * outside your own provider customer is not merely forbidden, it is
 * unrepresentable.
 *
 * No secret is involved because this is a lookup key, not a token: it
 * grants nothing on its own, and forging one buys you a 404.
 */
export function paymentMethodHandle(ref: string): string {
    return createHash('sha256').update(ref).digest('hex').slice(0, 32);
}

/**
 * Add / replace / remove a stored payment method (billing PRD §3.3,
 * audit B10 + B25) — additive beside the read-only summary that
 * `BillingService.getOverview` has always returned.
 *
 * ## Card data never reaches us
 *
 * There is no "card details" input anywhere in this flow. Adding a card
 * is a redirect to the provider's own hosted element
 * (`BillingProvider.createPaymentMethodSetupSession`); the PAN and CVC
 * are posted to the PROVIDER and tokenized there. What we store is the
 * opaque reference plus brand / last4 / expiry, exactly the columns
 * `billing_profiles` has always had. No route in this service accepts a
 * card number, and the DTOs forbid unknown fields so one cannot be
 * smuggled in.
 *
 * ## Owner scoping
 *
 * Every method starts from `billing_profiles` resolved by the SESSION
 * user id. Nothing is ever read from a client-supplied user, org, tenant
 * or customer id, so a caller cannot address another owner's — or
 * another organization's — billing at all. The provider customer used
 * for a list/mutate is always `profile.providerCustomerId`.
 */
@Injectable()
export class PaymentMethodService {
    private readonly logger = new Logger(PaymentMethodService.name);

    constructor(
        private readonly billingProvider: BillingProvider,
        private readonly billingProfileRepository: BillingProfileRepository,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
        private readonly userRepository: UserRepository,
    ) {}

    /**
     * Start a hosted card capture. Lazily creates the provider customer +
     * `billing_profiles` row so a user can add a card BEFORE their first
     * purchase (previously the row only appeared at checkout, which is
     * why the payment method was effectively read-only — audit B10).
     */
    async startSetup(
        userId: string,
        urls: { successUrl: string; cancelUrl: string },
    ): Promise<PaymentMethodSetupStarted> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }

        const user = await this.userRepository.findById(userId);
        const existing = await this.billingProfileRepository.findByUserId(userId);
        const customerId = await this.billingProvider.ensureCustomer({
            userId,
            email: user?.email ?? null,
            existingCustomerId: existing?.providerCustomerId ?? null,
        });
        const profile = await this.billingProfileRepository.ensure({
            userId,
            provider: this.billingProvider.getProviderId(),
            providerCustomerId: customerId,
            organizationId: existing?.organizationId ?? null,
            tenantId: existing?.tenantId ?? null,
        });

        const session = await this.billingProvider.createPaymentMethodSetupSession({
            userId,
            customerId: profile.providerCustomerId,
            userEmail: user?.email ?? null,
            successUrl: urls.successUrl,
            cancelUrl: urls.cancelUrl,
        });
        return { url: session.url, sessionId: session.sessionId };
    }

    /**
     * The caller's stored cards, read live from the provider.
     *
     * Reading live (rather than trusting the mirrored summary) is what
     * makes the flow work on a deployment with no webhook secret: the
     * card the user just saved on the hosted page shows up on the next
     * page load, and {@link reconcileDefault} adopts it as the default.
     */
    async list(userId: string): Promise<PaymentMethodList> {
        const providerConfigured = this.billingProvider.isConfigured();
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!providerConfigured || !profile) {
            return { providerConfigured, methods: [] };
        }

        const methods = await this.billingProvider.listPaymentMethods(profile.providerCustomerId);
        const defaultRef = await this.reconcileDefault(
            userId,
            profile.defaultPaymentMethodRef ?? null,
            methods,
        );
        return {
            providerConfigured,
            methods: methods.map((method) => ({
                id: paymentMethodHandle(method.ref),
                brand: method.brand,
                last4: method.last4,
                expMonth: method.expMonth,
                expYear: method.expYear,
                isDefault: method.ref === defaultRef,
            })),
        };
    }

    /** Promote one stored card to the default — the "replace" action. */
    async setDefault(userId: string, handle: string): Promise<PaymentMethodRow> {
        const { profile, method } = await this.requireOwnedMethod(userId, handle);
        const updated = await this.billingProvider.setDefaultPaymentMethod(
            profile.providerCustomerId,
            method.ref,
        );
        await this.billingProfileRepository.updatePaymentMethod(userId, {
            defaultPaymentMethodRef: updated.ref,
            paymentMethodBrand: updated.brand,
            paymentMethodLast4: updated.last4,
            paymentMethodExpMonth: updated.expMonth,
            paymentMethodExpYear: updated.expYear,
        });
        return {
            id: paymentMethodHandle(updated.ref),
            brand: updated.brand,
            last4: updated.last4,
            expMonth: updated.expMonth,
            expYear: updated.expYear,
            isDefault: true,
        };
    }

    /**
     * Remove a stored card.
     *
     * Refuses (409, see {@link LastPaymentMethodError}) when it is the
     * last one and a paid subscription is active. Otherwise: detach at
     * the provider, then promote a survivor to default — or, when none
     * remain, clear the stored summary and switch auto-recharge OFF,
     * because an off-session charge cannot run without a stored method
     * and leaving the toggle "on" would be a lie in the UI.
     */
    async remove(userId: string, handle: string): Promise<PaymentMethodList> {
        const { profile, method, all } = await this.requireOwnedMethod(userId, handle);

        if (all.length <= 1 && (await this.hasActivePaidSubscription(userId))) {
            throw new LastPaymentMethodError();
        }

        await this.billingProvider.detachPaymentMethod(profile.providerCustomerId, method.ref);

        const remaining = all.filter((candidate) => candidate.ref !== method.ref);
        const wasDefault = profile.defaultPaymentMethodRef === method.ref;
        if (wasDefault) {
            const promoted = remaining[0] ?? null;
            if (promoted) {
                // Keep the provider's own default in step with ours — an
                // auto-recharge charges `defaultPaymentMethodRef`, so a
                // divergence here would charge a card we no longer show.
                await this.billingProvider.setDefaultPaymentMethod(
                    profile.providerCustomerId,
                    promoted.ref,
                );
            }
            await this.billingProfileRepository.updatePaymentMethod(userId, {
                defaultPaymentMethodRef: promoted?.ref ?? null,
                paymentMethodBrand: promoted?.brand ?? null,
                paymentMethodLast4: promoted?.last4 ?? null,
                paymentMethodExpMonth: promoted?.expMonth ?? null,
                paymentMethodExpYear: promoted?.expYear ?? null,
            });
            if (!promoted && profile.autoRechargeEnabled) {
                await this.billingProfileRepository.updateAutoRecharge(userId, {
                    autoRechargeEnabled: false,
                    autoRechargeThresholdCredits: profile.autoRechargeThresholdCredits ?? null,
                    autoRechargePackId: profile.autoRechargePackId ?? null,
                });
                this.logger.log(
                    `Auto-recharge disabled for user ${userId}: last payment method removed`,
                );
            }
        }

        return this.list(userId);
    }

    /**
     * Resolve a client handle against the CALLER'S OWN methods.
     *
     * This is the authorization step: the handle is matched only against
     * cards attached to `profile.providerCustomerId`, so there is no code
     * path in which a client value selects a foreign payment method.
     */
    private async requireOwnedMethod(userId: string, handle: string) {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }
        const profile = await this.billingProfileRepository.findByUserId(userId);
        if (!profile) {
            throw new PaymentMethodNotFoundError();
        }
        const all = await this.billingProvider.listPaymentMethods(profile.providerCustomerId);
        const method = all.find((candidate) => paymentMethodHandle(candidate.ref) === handle);
        if (!method) {
            throw new PaymentMethodNotFoundError();
        }
        return { profile, method, all };
    }

    /**
     * Keep the mirrored summary honest with the provider: adopt the first
     * card when we hold none (the no-webhook path right after a hosted
     * setup), and drop a stored reference the provider no longer has.
     */
    private async reconcileDefault(
        userId: string,
        storedRef: string | null,
        methods: Array<{
            ref: string;
            brand: string | null;
            last4: string | null;
            expMonth: number | null;
            expYear: number | null;
        }>,
    ): Promise<string | null> {
        const stillThere = storedRef
            ? (methods.find((method) => method.ref === storedRef) ?? null)
            : null;
        if (stillThere) {
            return stillThere.ref;
        }
        const adopted = methods[0] ?? null;
        if (!storedRef && !adopted) {
            return null;
        }
        await this.billingProfileRepository.updatePaymentMethod(userId, {
            defaultPaymentMethodRef: adopted?.ref ?? null,
            paymentMethodBrand: adopted?.brand ?? null,
            paymentMethodLast4: adopted?.last4 ?? null,
            paymentMethodExpMonth: adopted?.expMonth ?? null,
            paymentMethodExpYear: adopted?.expYear ?? null,
        });
        return adopted?.ref ?? null;
    }

    /**
     * ACTIVE subscription on a plan that actually costs money.
     * `monthlyPrice` is a decimal string column, hence the parse.
     */
    private async hasActivePaidSubscription(userId: string): Promise<boolean> {
        const subscription = await this.userSubscriptionRepository.findActiveByUser(userId);
        const price = Number(subscription?.plan?.monthlyPrice ?? 0);
        return Number.isFinite(price) && price > 0;
    }
}
