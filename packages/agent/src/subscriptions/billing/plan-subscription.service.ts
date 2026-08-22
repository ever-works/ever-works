import { Injectable, Logger } from '@nestjs/common';
import { BillingProfileRepository } from '@src/database/repositories/billing-profile.repository';
import { SubscriptionPlanRepository } from '@src/database/repositories/subscription-plan.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { SubscriptionPlan } from '@src/entities/subscription-plan.entity';
import { SubscriptionPlanCode } from '@src/entities/types';
import {
    SubscriptionBillingProvider,
    SubscriptionStatus,
} from '@src/entities/user-subscription.entity';
import { SubscriptionService } from '../subscription.service';
import {
    BillingProvider,
    BillingProviderNotConfiguredError,
    type BillingWebhookEvent,
} from './billing.provider';
import { billableSeats, resolveSkuForPlanRow, type CatalogInterval } from './stripe-catalog';

/** A checkout was asked for with a plan code that is not sellable. */
export class UnknownSubscriptionPlanError extends Error {
    constructor(planCode: string) {
        super(`Unknown subscription plan: ${planCode}`);
        this.name = 'UnknownSubscriptionPlanError';
    }
}

/**
 * The plan exists but there is nothing to buy — a free tier, or a plan
 * row whose price is missing/malformed. Free moves stay on the existing
 * self-service path (`POST /api/subscriptions/plan`).
 */
export class PlanNotPurchasableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanNotPurchasableError';
    }
}

/**
 * The caller asked to finalize a checkout session that is not theirs (or
 * does not exist). Deliberately ONE error for both, so a session id in a
 * URL cannot be used to probe other accounts' checkouts — the API maps it
 * to 404, matching `OrganizationMembershipService`'s existence-leak rule.
 */
export class CheckoutSessionNotFoundError extends Error {
    constructor() {
        super('Checkout session not found');
        this.name = 'CheckoutSessionNotFoundError';
    }
}

export interface StartPlanCheckoutOptions {
    userId: string;
    planCode: string;
    successUrl: string;
    cancelUrl: string;
    organizationId?: string | null;
    tenantId?: string | null;
    /**
     * Total seats (employees OR agents) the buyer wants, INCLUSIVE of the plan allowance. The
     * service clamps this against the plan row and bills only the excess, so a caller cannot
     * under-report to pay less. Absent means "just the included allowance".
     */
    seats?: number | null;
    /**
     * Which billing period to buy. Defaults to `monthly` — the only period this path supported
     * before the shared catalog existed.
     *
     * An interval the resolved plan does not sell is refused, never silently downgraded to one it
     * does: quietly selling a monthly subscription to someone who asked for a perpetual licence is
     * worse than a 400.
     */
    interval?: CatalogInterval | null;
}

export interface PlanCheckoutStarted {
    url: string;
    sessionId: string;
    planCode: string;
    /** Echoed for the UI's confirmation copy — from the SERVER plan row. */
    priceCents: number;
    currency: string;
}

export interface PlanCheckoutReturn {
    /** `active` once the plan is in force; `pending` while money settles. */
    status: 'active' | 'pending' | 'ignored';
    activated: boolean;
    planCode: string | null;
}

/** What `applyWebhook` did, mirrored into the BillingService outcome. */
export type PlanWebhookAction =
    | 'subscription-activated'
    | 'subscription-canceled'
    /**
     * A lifecycle snapshot was accepted (audit B07/B08) — dunning, pause,
     * resume or a period roll. Distinct from activated/canceled because
     * it changes NEITHER: the tier is untouched and only the billing
     * profile's view of the subscription moves.
     */
    | 'subscription-reconciled'
    | 'ignored'
    | 'unattributed';

/**
 * Paid-plan purchase (audit B24).
 *
 * Before this service existed the platform had a credit top-up checkout
 * but **no way to actually buy a tier**: `POST /api/subscriptions/plan`
 * refuses paid plans by design (EW-711 #23) and `assignPlanToUser` — the
 * privileged grant — had no caller. This is that caller.
 *
 * Three invariants, mirroring {@link BillingService}:
 *
 * 1. **The server prices everything.** Checkout takes a plan CODE; the
 *    recurring amount is read from the `subscription_plans` row. A client
 *    never supplies a price (the DTO rejects extra fields outright).
 *
 * 2. **Only a billing-verified path grants a paid tier.** Activation
 *    happens from the signature-verified webhook, or from a return-route
 *    read-back of the session straight from the provider. Neither trusts
 *    the browser: the return route authorizes on the `userId` WE stamped
 *    into the session metadata, not on the session id in the URL.
 *
 * 3. **Entitlements are untouched.** Activation writes the plan the user
 *    is on; every limit/lever continues to resolve through
 *    `EntitlementsService` keyed by plan code. Nothing here grants
 *    credits or bypasses a gate.
 */
@Injectable()
export class PlanSubscriptionService {
    private readonly logger = new Logger(PlanSubscriptionService.name);

    constructor(
        private readonly billingProvider: BillingProvider,
        private readonly planRepository: SubscriptionPlanRepository,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
        private readonly billingProfileRepository: BillingProfileRepository,
        private readonly userRepository: UserRepository,
        private readonly subscriptionService: SubscriptionService,
    ) {}

    /**
     * Start a hosted checkout for a recurring plan.
     *
     * Fails closed on every axis: subscriptions off, provider not wired,
     * unknown/inactive plan, or a plan with no positive price.
     */
    async startPlanCheckout(options: StartPlanCheckoutOptions): Promise<PlanCheckoutStarted> {
        if (!this.subscriptionService.isEnabled()) {
            throw new PlanNotPurchasableError('Subscriptions are disabled on this deployment');
        }
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }

        const interval: CatalogInterval = options.interval ?? 'monthly';

        const plan = await this.resolveSellablePlan(options.planCode, interval);
        const catalogSku = resolveSkuForPlanRow({ code: plan.code, hosting: plan.hosting, interval });
        // What the buyer will actually be charged. The catalog wins because the catalog price is
        // what the provider bills; the row is the fallback for an unsynced deployment. Reading the
        // row first would echo 0 for any period the row has no column value for — showing someone
        // "$0" on a confirmation screen for a charge that is about to be 204.00.
        const priceCents = catalogSku?.price.amountCents ?? planPriceCentsForInterval(plan, interval);

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

        const session = await this.billingProvider.createPlanCheckoutSession({
            userId: options.userId,
            userEmail: user?.email ?? null,
            customerId: profile.providerCustomerId,
            plan: {
                code: plan.code,
                label: `${plan.displayName} plan`,
                priceCents,
                currency: plan.currency || this.billingProvider.getDefaultCurrency(),
                interval: interval === 'annual' ? 'year' : 'month',
                // A `lifetime` SKU is bought outright. Decided from the catalog SKU, never from
                // the interval name alone — see `resolveCatalogSku`.
                mode: catalogSku?.mode ?? (interval === 'lifetime' ? 'payment' : 'subscription'),
                // Prefer the catalog price in the shared Stripe account over the row's own amount,
                // so the invoice line carries a lookup_key that maps back to a reviewed commit.
                // `null` here is normal on a deployment whose catalog has not been synced — the
                // provider falls back to billing `priceCents` exactly as it did before.
                ...this.catalogKeysFor(plan, interval, options.seats ?? null),
            },
            successUrl: options.successUrl,
            cancelUrl: options.cancelUrl,
            referenceId: `${options.userId}:${plan.code}`,
        });

        return {
            url: session.url,
            sessionId: session.sessionId,
            planCode: plan.code,
            priceCents,
            currency: plan.currency,
        };
    }

    /**
     * The catalog fields for a plan row: which shared-account price to bill, which per-seat price
     * to add, and how many seats are actually billable.
     *
     * Seats are clamped against the PLAN's own allowance, on the server, from the stored row — a
     * caller cannot ask for a seat count that bills less than it should, and a plan with unbounded
     * seats (the Community Edition, and Enterprise "Option 1") always yields zero extras.
     *
     * Returns empty when the catalog does not know this plan, which leaves the descriptor exactly
     * as it was before the shared account existed.
     */
    private catalogKeysFor(
        plan: SubscriptionPlan,
        interval: CatalogInterval,
        requestedSeats: number | null,
    ): { lookupKey?: string; seatLookupKey?: string | null; extraSeats?: number } {
        const sku = resolveSkuForPlanRow({ code: plan.code, hosting: plan.hosting, interval });
        if (!sku) return {};

        const extraSeats =
            requestedSeats === null ? 0 : billableSeats(sku.plan, requestedSeats);

        return {
            lookupKey: sku.lookupKey,
            seatLookupKey: extraSeats > 0 ? sku.seatLookupKey : null,
            extraSeats,
        };
    }

    /**
     * Finalize the browser's return from a hosted checkout.
     *
     * The webhook is still the authority — this exists so a buyer who
     * lands back on the Billing page sees the new tier immediately
     * instead of waiting on an asynchronous delivery. It is safe to run
     * alongside the webhook: both funnel into the same idempotent
     * {@link activate}.
     *
     * SECURITY: `sessionId` is attacker-controllable (it comes back in a
     * query string). Authorization is the `userId` the PROVIDER stored in
     * our session metadata — a session belonging to anyone else is
     * indistinguishable from one that does not exist.
     */
    async syncCheckoutReturn(userId: string, sessionId: string): Promise<PlanCheckoutReturn> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }

        const snapshot = await this.billingProvider.retrieveCheckoutSession(sessionId);
        if (!snapshot.userId || snapshot.userId !== userId) {
            throw new CheckoutSessionNotFoundError();
        }
        if (snapshot.purpose !== 'plan') {
            // A credit top-up session returning through this route is not
            // an error — it simply activates no plan.
            return { status: 'ignored', activated: false, planCode: null };
        }
        if (snapshot.status !== 'complete' || !snapshot.paid) {
            return { status: 'pending', activated: false, planCode: snapshot.planCode };
        }

        const activated = await this.activate({
            userId,
            planCode: snapshot.planCode,
            providerSubscriptionId: snapshot.subscriptionId,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            cancelAtPeriodEnd: false,
        });

        return {
            status: activated ? 'active' : 'pending',
            activated,
            planCode: snapshot.planCode,
        };
    }

    // ── Webhook ──────────────────────────────────────────────────────

    /**
     * Apply one verified `subscription.*` delivery. Called by
     * {@link BillingService.handleWebhook}; never reached for an
     * unverified payload.
     */
    async applyWebhook(event: BillingWebhookEvent): Promise<PlanWebhookAction> {
        const userId = await this.resolveUserId(event);
        if (!userId) {
            this.logger.warn(
                `Billing webhook ${event.id} (${event.providerType}) — subscription event could not be attributed to an owner; acknowledged`,
            );
            return 'unattributed';
        }

        if (event.kind === 'subscription.activated') {
            const activated = await this.activate({
                userId,
                planCode: event.planCode ?? null,
                providerSubscriptionId: event.subscriptionId ?? null,
                currentPeriodEnd: event.currentPeriodEnd ?? null,
                cancelAtPeriodEnd: event.cancelAtPeriodEnd ?? false,
            });
            return activated ? 'subscription-activated' : 'ignored';
        }

        if (event.kind === 'subscription.canceled') {
            const canceled = await this.cancel(userId, event.subscriptionId ?? null);
            return canceled ? 'subscription-canceled' : 'ignored';
        }

        // `subscription.updated` (audit B07/B08) is a LIFECYCLE SNAPSHOT —
        // dunning, pause, resume, a period roll. It deliberately does NOT
        // grant and does NOT revoke: the grant is `subscription.activated`
        // and the revoke is `subscription.canceled`, both of which the
        // provider emits alongside this. Reconciling the snapshot is the
        // billing profile's job, not the tier's.
        if (event.kind === 'subscription.updated') {
            return 'subscription-reconciled';
        }

        // Any OTHER kind is acknowledged, never acted on.
        //
        // This branch used to be a bare fallthrough to `cancel()`, which
        // meant every kind that was not `subscription.activated` revoked
        // the plan. That was safe only while the union had exactly two
        // members; the moment a third arrived (this change), a `past_due`
        // or `paused` delivery would have silently downgraded a paying
        // customer. Revoking is now something only an explicit
        // `subscription.canceled` can do.
        this.logger.warn(
            `Billing webhook ${event.id}: unhandled subscription kind '${event.kind}' — acknowledged without changing the plan`,
        );
        return 'ignored';
    }

    // ── Persistence ──────────────────────────────────────────────────

    /**
     * Put a user on a paid plan. Idempotent: re-running for the same
     * plan rewrites the same row and re-asserts the same default plan, so
     * a webhook replay (or a webhook racing the return route) moves
     * nothing twice.
     */
    private async activate(input: {
        userId: string;
        planCode: string | null;
        providerSubscriptionId: string | null;
        currentPeriodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
    }): Promise<boolean> {
        const plan = input.planCode ? await this.findPlanByCode(input.planCode) : null;
        if (!plan) {
            this.logger.warn(
                `Plan activation skipped — unknown plan code '${input.planCode ?? 'none'}'`,
            );
            return false;
        }

        await this.userSubscriptionRepository.createOrUpdate(input.userId, {
            planCode: plan.code,
            planId: plan.id,
            status: SubscriptionStatus.ACTIVE,
            billingProvider: providerEnum(this.billingProvider.getProviderId()),
            currentPeriodEnd: input.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: input.cancelAtPeriodEnd,
            providerSubscriptionId: input.providerSubscriptionId ?? null,
        });

        // THE privileged grant (`assignPlanToUser`) — documented as
        // "call only from a billing-verified path", which is exactly here.
        // The `user_subscriptions` row above is written regardless so the
        // provider's truth is recorded even on a deployment where the
        // subscriptions flag was switched off after the sale.
        if (this.subscriptionService.isEnabled()) {
            const user = await this.userRepository.findById(input.userId);
            if (user) {
                await this.subscriptionService.assignPlanToUser(user, plan.code);
            }
        }
        return true;
    }

    /**
     * Revoke a lapsed plan: mark the subscription canceled and drop the
     * account back to the free tier through the existing self-service
     * downgrade path (which permits free plans by design).
     */
    private async cancel(userId: string, providerSubscriptionId: string | null): Promise<boolean> {
        let subscription = null;
        if (providerSubscriptionId) {
            subscription =
                await this.userSubscriptionRepository.findByProviderSubscriptionId(
                    providerSubscriptionId,
                );
            if (!subscription) {
                // The provider named a subscription we never recorded.
                // Do NOT fall back to "cancel whatever is active on this
                // account" — an owner can legitimately hold a second,
                // live subscription that this event says nothing about.
                this.logger.warn(
                    'Subscription cancel skipped — provider subscription is not on file',
                );
                return false;
            }
        } else {
            subscription = await this.userSubscriptionRepository.findActiveByUser(userId);
        }

        if (!subscription) {
            return false;
        }
        // Belt and braces: never cancel a row belonging to someone else,
        // whatever the attribution path decided.
        if (subscription.userId !== userId) {
            this.logger.warn(
                'Subscription cancel skipped — provider subscription belongs to another owner',
            );
            return false;
        }
        await this.userSubscriptionRepository.cancel(subscription.id);

        if (this.subscriptionService.isEnabled()) {
            const user = await this.userRepository.findById(userId);
            if (user) {
                // Free plans are exactly what `changePlanSelfService`
                // permits (sign-up default / downgrade / cancel).
                await this.subscriptionService.changePlanSelfService(
                    user,
                    SubscriptionPlanCode.FREE,
                );
            }
        }
        return Boolean(subscription);
    }

    // ── Resolution helpers ───────────────────────────────────────────

    private async resolveSellablePlan(
        planCode: string,
        interval: CatalogInterval = 'monthly',
    ): Promise<SubscriptionPlan> {
        const plan = await this.findPlanByCode(planCode);
        if (!plan || !plan.active) {
            throw new UnknownSubscriptionPlanError(String(planCode));
        }
        // A free tier is free on every period, so this stays keyed on the monthly price: it is the
        // "is this plan sold at all?" question, not "does it sell this period?".
        if (planPriceCents(plan) <= 0) {
            throw new PlanNotPurchasableError(
                'Free plans do not require checkout — switch to them directly',
            );
        }
        // A period the plan does not sell must be refused, never downgraded to one it does. Both
        // sources have to agree: the catalog decides what Stripe can charge, the row decides what
        // an unsynced deployment charges, and selling a period only one of them knows about would
        // bill the wrong amount on half the fleet.
        const sku = resolveSkuForPlanRow({ code: plan.code, hosting: plan.hosting, interval });
        if (!sku && planPriceCentsForInterval(plan, interval) <= 0) {
            throw new PlanNotPurchasableError(
                `This plan is not sold on a ${interval} basis`,
            );
        }
        return plan;
    }

    private async findPlanByCode(planCode: string): Promise<SubscriptionPlan | null> {
        const normalized = String(planCode ?? '').toLowerCase();
        if (!Object.values(SubscriptionPlanCode).includes(normalized as SubscriptionPlanCode)) {
            return null;
        }
        return this.planRepository.findByCode(normalized as SubscriptionPlanCode);
    }

    /**
     * Attribute a verified subscription event to an owner. Provider
     * customer id first (the mapping we control), then the `referenceId`
     * WE stamped at checkout — both are server-authored values echoed
     * back inside a SIGNED event, never client input.
     */
    private async resolveUserId(event: BillingWebhookEvent): Promise<string | null> {
        if (event.subscriptionId) {
            const existing = await this.userSubscriptionRepository.findByProviderSubscriptionId(
                event.subscriptionId,
            );
            if (existing) {
                return existing.userId;
            }
        }
        if (event.customerId) {
            const profile = await this.billingProfileRepository.findByCustomerId(
                this.billingProvider.getProviderId(),
                event.customerId,
            );
            if (profile) {
                return profile.userId;
            }
        }
        if (event.referenceId) {
            const [userId] = event.referenceId.split(':');
            if (userId) {
                return userId;
            }
        }
        return null;
    }
}

/**
 * `subscription_plans.monthlyPrice` is a DECIMAL string. Fail closed:
 * anything that does not parse to a finite, positive number prices at 0
 * (i.e. "not sellable") rather than silently charging something odd.
 */
function planPriceCents(plan: SubscriptionPlan): number {
    const price = Number(plan.monthlyPrice);
    if (!Number.isFinite(price) || price <= 0) {
        return 0;
    }
    return Math.round(price * 100);
}

/**
 * The plan row's own price for one billing period, in cents.
 *
 * This is the FALLBACK amount — what gets billed on a deployment whose Stripe catalog has not been
 * synced. When the catalog resolves, the provider bills the catalog price instead and this number
 * only rides along on the response for the UI's confirmation copy.
 *
 * `annualPrice` is the YEARLY charge, not the per-month figure the marketing site displays.
 */
function planPriceCentsForInterval(plan: SubscriptionPlan, interval: CatalogInterval): number {
    const raw =
        interval === 'annual'
            ? Number(plan.annualPrice)
            : interval === 'lifetime'
              ? Number(plan.lifetimePrice)
              : Number(plan.monthlyPrice);
    if (!Number.isFinite(raw) || raw <= 0) {
        return 0;
    }
    return Math.round(raw * 100);
}

/** Map the provider id onto the entity's closed billing-provider set. */
function providerEnum(providerId: string): SubscriptionBillingProvider {
    return providerId === SubscriptionBillingProvider.STRIPE
        ? SubscriptionBillingProvider.STRIPE
        : SubscriptionBillingProvider.MANUAL;
}
