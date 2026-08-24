import { Injectable, Logger } from '@nestjs/common';
import { AgentRepository } from '@src/database/repositories/agent.repository';
import { OrganizationMemberRepository } from '@src/database/repositories/organization-member.repository';
import { SubscriptionPlanRepository } from '@src/database/repositories/subscription-plan.repository';
import { TenantRepository } from '@src/database/repositories/tenant.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { SubscriptionStatus } from '@src/entities/user-subscription.entity';
import type { SubscriptionPlanCode } from '@src/entities/types';
import { config } from '@src/config';
import { BillingProvider, BillingProviderNotConfiguredError } from './billing.provider';
import { billableSeats, resolveSkuForPlanRow } from './stripe-catalog';

/**
 * A seat-consuming write was refused because the owner's plan has no seat
 * left. Stable `name` so the API boundary maps it to a distinct 402 rather
 * than an unmapped 500 (same posture as `InsufficientCreditsError`).
 */
export class SeatLimitExceededError extends Error {
    constructor(
        public readonly ownerUserId: string,
        public readonly used: number,
        public readonly allowance: number,
    ) {
        super(
            `Seat limit reached: ${used} of ${allowance} seats in use. ` +
                'Add seats in Billing, or archive an agent / remove a member.',
        );
        this.name = 'SeatLimitExceededError';
    }
}

export interface SeatsView {
    /** Seats the plan includes before per-seat billing starts. `null` = unbounded. */
    included: number | null;
    /** Additional seats bought on top of the plan. */
    purchased: number;
    /** `included + purchased`, or `null` when the plan is unbounded. */
    allowance: number | null;
    /** People (distinct members) currently holding a seat. */
    members: number;
    /** Active (non-archived) agents currently holding a seat. */
    agents: number;
    /** `members + agents`. */
    used: number;
    /** Seats left, or `null` when unbounded. */
    available: number | null;
    /** Per additional seat per month, in cents. `null` when the plan sells no seats. */
    seatPriceCents: number | null;
    /** False when the deployment cannot sell seats (no provider / subscriptions off). */
    purchasable: boolean;
}

/**
 * Seats (billing spec §3.6).
 *
 * A seat is an **employee OR an agent** — the two are interchangeable, which
 * is the point of the product. Seats were already being SOLD (the plan
 * checkout adds a catalog per-seat line item) and then forgotten: nothing
 * persisted the count, so nothing could enforce it and the Billing page had
 * nothing to show. This service is the one place that answers "how many
 * seats does this owner have, how many are in use, and may this write take
 * one".
 *
 * ## Scope: the Tenant, not the Organization
 *
 * Access in Ever Works is tenant-wide, so a person who belongs to three
 * Organizations in one Tenant occupies ONE seat, and an agent built by a team
 * member is platform capacity exactly like one the owner built. Counting per
 * Organization would over-bill every team that organizes itself into more
 * than one.
 *
 * ## Fail-open by construction
 *
 * `assertSeatAvailable` is a no-op whenever subscriptions are disabled, the
 * owner is on an unbounded plan, or anything about the resolution fails. A
 * billing lookup must never be the reason somebody cannot add a teammate;
 * the only case that refuses is a resolved allowance that is genuinely full.
 */
@Injectable()
export class SeatsService {
    private readonly logger = new Logger(SeatsService.name);

    constructor(
        private readonly billingProvider: BillingProvider,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
        private readonly planRepository: SubscriptionPlanRepository,
        private readonly organizationMemberRepository: OrganizationMemberRepository,
        private readonly agentRepository: AgentRepository,
        private readonly userRepository: UserRepository,
        private readonly tenantRepository: TenantRepository,
    ) {}

    /** Everything the Billing page renders about seats, for one owner. */
    async getSeats(userId: string): Promise<SeatsView> {
        const subscription = await this.userSubscriptionRepository.findActiveByUser(userId);
        const plan =
            subscription?.plan ??
            (await this.planRepository.findByCode(
                config.subscriptions.getDefaultPlanCode() as SubscriptionPlanCode,
            ));

        const included = plan ? this.seatsIncludedOf(plan) : 1;
        const purchased = Math.max(0, subscription?.seats ?? 0);
        const allowance = included === null ? null : included + purchased;

        const { members, agents } = await this.countUsage(userId);
        const used = members + agents;

        return {
            included,
            purchased,
            allowance,
            members,
            agents,
            used,
            available: allowance === null ? null : Math.max(0, allowance - used),
            seatPriceCents: this.seatPriceCentsOf(plan),
            purchasable:
                this.billingProvider.isConfigured() &&
                config.subscriptions.isEnabled() &&
                Boolean(subscription?.providerSubscriptionId) &&
                included !== null,
        };
    }

    /**
     * Refuse a seat-consuming write when the owner is full (billing spec
     * FR-28). Called from the member-admission and agent-creation paths.
     *
     * `count` is how many seats the write needs (1 for a member or an
     * agent). Fail-open on every axis except a genuinely full allowance.
     */
    async assertSeatAvailable(ownerUserId: string, count = 1): Promise<void> {
        if (!config.subscriptions.isEnabled()) return;
        let seats: SeatsView;
        try {
            seats = await this.getSeats(ownerUserId);
        } catch (error) {
            // A billing lookup must never block adding a teammate.
            this.logger.warn(
                `Seat check failed for owner ${ownerUserId} (fail-open): ${
                    (error as Error).message
                }`,
            );
            return;
        }
        if (seats.allowance === null) return;
        if (seats.used + count <= seats.allowance) return;
        throw new SeatLimitExceededError(ownerUserId, seats.used, seats.allowance);
    }

    /**
     * The billing owner a seat-consuming write is charged to: the Tenant
     * owner, falling back to the acting user when there is no Tenant (a solo
     * account, where the two are the same person anyway).
     */
    async resolveBillingOwner(userId: string): Promise<string> {
        try {
            const user = await this.userRepository.findById(userId);
            if (!user?.tenantId) return userId;
            // Explicit lookup rather than a relation: `User` deliberately
            // declares no `@ManyToOne(() => Tenant)` (the EW-654 cycle rule),
            // so `user.tenant` is undefined on a plain findById and reading it
            // would silently bill the acting user instead of the owner.
            const tenant = await this.tenantRepository.findById(user.tenantId);
            const owner = tenant?.ownerUserId;
            return typeof owner === 'string' && owner.length > 0 ? owner : userId;
        } catch {
            return userId;
        }
    }

    /**
     * Buy or release additional seats (billing spec FR-29).
     *
     * `totalSeats` is what the owner wants IN TOTAL; the extras billed are
     * `max(0, totalSeats − included)`, clamped on the server from the stored
     * plan row so a caller can never ask to be billed for fewer seats than
     * it uses. Never lets an owner drop the allowance below what is already
     * in use — that would leave the account instantly over its limit.
     */
    async setSeats(userId: string, totalSeats: number): Promise<SeatsView> {
        if (!this.billingProvider.isConfigured()) {
            throw new BillingProviderNotConfiguredError();
        }
        const subscription = await this.userSubscriptionRepository.findActiveByUser(userId);
        if (
            !subscription ||
            subscription.status !== SubscriptionStatus.ACTIVE ||
            !subscription.providerSubscriptionId
        ) {
            throw new SeatsNotPurchasableError('This account has no manageable subscription');
        }
        const plan =
            subscription.plan ?? (await this.planRepository.findByCode(subscription.planCode));
        if (!plan) {
            throw new SeatsNotPurchasableError('Unknown plan on this subscription');
        }
        const included = this.seatsIncludedOf(plan);
        if (included === null) {
            throw new SeatsNotPurchasableError('This plan already includes unlimited seats');
        }

        const { members, agents } = await this.countUsage(userId);
        const used = members + agents;
        const requested = Math.max(0, Math.floor(Number(totalSeats)));
        if (requested < used) {
            throw new SeatsBelowUsageError(requested, used);
        }

        const monthlySku = resolveSkuForPlanRow({
            code: plan.code,
            hosting: plan.hosting,
            interval: 'monthly',
        });
        const annualSku = resolveSkuForPlanRow({
            code: plan.code,
            hosting: plan.hosting,
            interval: 'annual',
        });
        if (!monthlySku?.seatLookupKey || !annualSku?.seatLookupKey) {
            throw new SeatsNotPurchasableError('This plan sells no additional seats');
        }

        const extras = billableSeats(monthlySku.plan, requested);
        const snapshot = await this.billingProvider.updateSeatQuantity({
            subscriptionId: subscription.providerSubscriptionId,
            seatLookupKeys: {
                monthly: monthlySku.seatLookupKey,
                annual: annualSku.seatLookupKey,
            },
            seatItemId: subscription.providerSeatItemId ?? null,
            quantity: extras,
        });

        await this.userSubscriptionRepository.updateSeats(subscription.id, {
            seats: snapshot.seats ?? extras,
            providerSeatItemId: snapshot.seatItemId ?? null,
        });
        return this.getSeats(userId);
    }

    // ── internals ─────────────────────────────────────────────────────

    private async countUsage(ownerUserId: string): Promise<{ members: number; agents: number }> {
        const user = await this.userRepository.findById(ownerUserId);
        const tenantId = user?.tenantId ?? null;
        if (!tenantId) {
            // No Tenant yet (a brand-new solo account): the owner is the only
            // person, and their own agents are all there is to count.
            const agents = await this.agentRepository.countActiveForUser(ownerUserId);
            return { members: 1, agents };
        }
        const [distinctMembers, agents] = await Promise.all([
            this.organizationMemberRepository.countDistinctUsersForTenant(tenantId),
            this.agentRepository.countActiveForTenant(tenantId),
        ]);
        // The owner may hold no roster row (the members list renders them
        // synthetically), so they would otherwise be free.
        const members = Math.max(1, distinctMembers);
        return { members, agents };
    }

    private seatsIncludedOf(plan: { seatsIncluded?: number | null }): number | null {
        const value = plan.seatsIncluded;
        if (value === null || value === undefined) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
    }

    private seatPriceCentsOf(plan: { seatMonthlyPrice?: string | null } | null): number | null {
        if (!plan?.seatMonthlyPrice) return null;
        const dollars = Number(plan.seatMonthlyPrice);
        return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
    }
}

/** The account has no subscription seats can be added to. Maps to 409. */
export class SeatsNotPurchasableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SeatsNotPurchasableError';
    }
}

/** Asked to drop the allowance below the seats already in use. Maps to 400. */
export class SeatsBelowUsageError extends Error {
    constructor(
        public readonly requested: number,
        public readonly used: number,
    ) {
        super(
            `Cannot set ${requested} seats: ${used} are already in use. ` +
                'Archive an agent or remove a member first.',
        );
        this.name = 'SeatsBelowUsageError';
    }
}
