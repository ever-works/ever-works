import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import { SubscriptionPlanRepository } from '@src/database/repositories/subscription-plan.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { SubscriptionPlan } from '@src/entities/subscription-plan.entity';
import { config } from '@src/config';
import { WorkScheduleAllowedCadence } from '@src/dto';
import { User } from '@src/entities/user.entity';
import { UserRepository } from '@src/database/repositories/user.repository';
import { WorkScheduleBillingMode, WorkScheduleCadence, SubscriptionPlanCode } from '@src/entities';
import type { SubscriptionPlanHosting } from '@src/entities/types';

const ALL_CADENCES: WorkScheduleCadence[] = [
    WorkScheduleCadence.MONTHLY,
    WorkScheduleCadence.WEEKLY,
    WorkScheduleCadence.DAILY,
    WorkScheduleCadence.EVERY_12_HOURS,
    WorkScheduleCadence.EVERY_8_HOURS,
    WorkScheduleCadence.EVERY_3_HOURS,
    WorkScheduleCadence.HOURLY,
];

/**
 * "Unlimited" for a quota stored in an `int` column.
 *
 * 🛑 NOT `Number.MAX_SAFE_INTEGER`. `subscription_plans.maxWorks` is a Postgres `integer`, whose
 * ceiling is 2147483647; MAX_SAFE_INTEGER is 9007199254740991 and Postgres rejects the INSERT with
 * `integer out of range`. Because `seedPlans()` runs inside `onModuleInit`, that rejection does not
 * degrade — it aborts module init and the API never finishes booting, on every environment with a
 * real database. Unit tests cannot catch it: the plan repository is a mock there, so the value is
 * never handed to Postgres.
 */
const UNLIMITED_WORKS = 2_147_483_647;

const PAID_CADENCES: WorkScheduleCadence[] = [
    WorkScheduleCadence.MONTHLY,
    WorkScheduleCadence.WEEKLY,
    WorkScheduleCadence.DAILY,
    WorkScheduleCadence.EVERY_12_HOURS,
];

/**
 * The plan catalog, upserted on `code` at boot by {@link SubscriptionService.seedPlans}.
 *
 * Prices were aligned with Ever Gauzy / Ever Teams on 2026-08-22 (owner directive) so the whole
 * Ever line reads consistently, and the shared Stripe account
 * (`acct_1IDnd6DdBrwbGEir`) now carries a matching price for every row — see
 * {@link ./billing/stripe-catalog.json}. `monthlyPrice` / `annualPrice` / `lifetimePrice` here are
 * MAJOR units (dollars) because the column is `decimal(10,2)`; the catalog holds the same numbers
 * in cents. They must agree, and `stripe-catalog.spec.ts` asserts that they do.
 *
 * 🛑 `code` values are load-bearing and unchanged — they are stored in `user_subscriptions.planCode`
 * and in Stripe metadata on every subscription ever created. What changed is `displayName`:
 * `standard` is now shown as "Pro" and `premium` as "Enterprise", matching what ever.works has
 * always advertised. The DB seed had drifted from the marketing site; this closes that gap.
 *
 * A "seat" is an employee OR an agent — interchangeable, which is the point of the product.
 * `seatsIncluded: null` means UNBOUNDED and suppresses per-seat billing entirely.
 *
 * On the SELF-HOSTED rows, what is being sold is a commercial licence that lifts the buyer's
 * AGPLv3 obligations. Quota fields there are advisory: a self-hoster owns the database and the
 * platform cannot meaningfully enforce them. They are seeded so the plan switcher and the licence
 * paperwork describe the same thing.
 */
const PLAN_SEED_DATA: Array<{
    code: SubscriptionPlanCode;
    displayName: string;
    hosting: SubscriptionPlanHosting;
    maxWorks: number;
    allowedCadences: WorkScheduleCadence[];
    monthlyPrice: string;
    annualPrice: string;
    lifetimePrice: string | null;
    seatsIncluded: number | null;
    seatMonthlyPrice: string | null;
    monthlyCredits: number;
    overagePricePerRun: string;
}> = [
    /* ------------------------------------------------------------------ cloud */
    {
        code: SubscriptionPlanCode.FREE,
        displayName: 'Free',
        hosting: 'cloud',
        maxWorks: 1,
        // allowedCadences: [WorkScheduleCadence.MONTHLY],
        allowedCadences: ALL_CADENCES, // for now everything is free
        monthlyPrice: '0',
        annualPrice: '0',
        lifetimePrice: null,
        // One seat, and no per-seat price: upgrading is how you get more, not a top-up.
        seatsIncluded: 1,
        seatMonthlyPrice: null,
        // Free accounts live on the universal 50-credits-a-day grant, not a monthly allowance.
        monthlyCredits: 0,
        overagePricePerRun: '10',
    },
    {
        code: SubscriptionPlanCode.STANDARD,
        displayName: 'Pro',
        hosting: 'cloud',
        maxWorks: 5,
        allowedCadences: PAID_CADENCES,
        // Ever Gauzy / Ever Teams cloud Small Business: $25/mo, $204/yr (displays "$17/mo").
        monthlyPrice: '25',
        annualPrice: '204',
        lifetimePrice: null,
        seatsIncluded: 10,
        seatMonthlyPrice: '5',
        monthlyCredits: 3000,
        overagePricePerRun: '8',
    },
    {
        code: SubscriptionPlanCode.PREMIUM,
        displayName: 'Enterprise',
        hosting: 'cloud',
        maxWorks: 15,
        allowedCadences: ALL_CADENCES,
        // Ever Gauzy / Ever Teams Enterprise: $199/mo, $1,668/yr (displays "$139/mo").
        monthlyPrice: '199',
        annualPrice: '1668',
        lifetimePrice: null,
        // Option 2 (unlimited organizations, 10 seats each) is the metered default. Option 1 (one
        // organization, unlimited seats) is the same plan with seat metering switched off on the
        // subscription rather than a separate row.
        seatsIncluded: 10,
        seatMonthlyPrice: '10',
        monthlyCredits: 25000,
        overagePricePerRun: '0',
    },

    /* ------------------------------------------------------------- self-hosted */
    {
        code: SubscriptionPlanCode.SELFHOSTED_COMMUNITY,
        displayName: 'Community Edition',
        hosting: 'selfhosted',
        // Free AGPLv3 download with no limits, mirroring Gauzy's Community Edition. Never bought,
        // so it has no Stripe object at all. Quotas are advisory here anyway — a self-hoster owns
        // the database — but the value still has to fit the column. See {@link UNLIMITED_WORKS}.
        maxWorks: UNLIMITED_WORKS,
        allowedCadences: ALL_CADENCES,
        monthlyPrice: '0',
        annualPrice: '0',
        lifetimePrice: null,
        seatsIncluded: null, // unbounded
        seatMonthlyPrice: null,
        monthlyCredits: 0,
        overagePricePerRun: '0',
    },
    {
        code: SubscriptionPlanCode.SELFHOSTED_PRO,
        displayName: 'Pro Edition',
        hosting: 'selfhosted',
        maxWorks: 5,
        allowedCadences: PAID_CADENCES,
        // Ever Gauzy self-hosted Small Business Edition: $49/mo, $408/yr (displays "$34/mo"),
        // or a $99 one-time perpetual commercial licence.
        monthlyPrice: '49',
        annualPrice: '408',
        lifetimePrice: '99',
        seatsIncluded: 10,
        seatMonthlyPrice: '5',
        monthlyCredits: 3000,
        overagePricePerRun: '8',
    },
    {
        code: SubscriptionPlanCode.SELFHOSTED_ENTERPRISE,
        displayName: 'Enterprise Edition',
        hosting: 'selfhosted',
        maxWorks: 15,
        allowedCadences: ALL_CADENCES,
        monthlyPrice: '199',
        annualPrice: '1668',
        lifetimePrice: null,
        seatsIncluded: 10,
        seatMonthlyPrice: '10',
        monthlyCredits: 25000,
        overagePricePerRun: '0',
    },
];

@Injectable()
export class SubscriptionService implements OnModuleInit {
    private readonly logger = new Logger(SubscriptionService.name);

    constructor(
        private readonly planRepository: SubscriptionPlanRepository,
        private readonly userSubscriptionRepository: UserSubscriptionRepository,
        private readonly userRepository: UserRepository,
    ) {}

    async onModuleInit() {
        await this.seedPlans();
    }

    async seedPlans() {
        await Promise.all(
            PLAN_SEED_DATA.map((plan) =>
                this.planRepository.upsert({
                    ...plan,
                    currency: config.billing.getDefaultCurrency(),
                    active: true,
                }),
            ),
        );
    }

    isEnabled() {
        return config.subscriptions.isEnabled();
    }

    /**
     * Wave 13 (Billing page) — all active seeded plans for the plan/tier
     * switcher. Read-only; plans are seeded at boot by {@link seedPlans}
     * regardless of the `SUBSCRIPTIONS_ENABLED` flag, so the switcher can
     * render (degraded) even on deploys where billing is off.
     */
    async listPlans(): Promise<SubscriptionPlan[]> {
        return this.planRepository.findAllActive();
    }

    async getActiveSubscription(userId: string) {
        return this.userSubscriptionRepository.findActiveByUser(userId);
    }

    async resolvePlanForUser(user: User): Promise<SubscriptionPlan> {
        if (!this.isEnabled()) {
            return this.resolveDefaultPlan();
        }

        const subscription = await this.getActiveSubscription(user.id);
        if (subscription?.plan) {
            return subscription.plan as SubscriptionPlan;
        }

        if (user.defaultPlan) {
            return user.defaultPlan as SubscriptionPlan;
        }

        return this.resolveDefaultPlan();
    }

    async getCadenceAllowances(user: User): Promise<WorkScheduleAllowedCadence[]> {
        if (!this.isEnabled()) {
            return ALL_CADENCES.map((cadence) => ({
                cadence,
                allowed: true,
                payPerUse: false,
            }));
        }

        const plan = await this.resolvePlanForUser(user);
        const allowedSet = new Set(plan.allowedCadences || []);

        return ALL_CADENCES.map((cadence) => ({
            cadence,
            allowed: allowedSet.has(cadence),
            payPerUse: !allowedSet.has(cadence),
            reason: allowedSet.has(cadence)
                ? undefined
                : `Upgrade to ${this.recommendationForCadence(cadence)} for this cadence`,
        }));
    }

    getDefaultCadence(plan: SubscriptionPlan): WorkScheduleCadence {
        const allowed = (plan.allowedCadences || []) as WorkScheduleCadence[];
        if (allowed.length > 0) {
            return allowed[allowed.length - 1];
        }

        return WorkScheduleCadence.MONTHLY;
    }

    requiresUsageBilling(
        cadence: WorkScheduleCadence,
        plan: SubscriptionPlan,
        billingMode: WorkScheduleBillingMode,
    ): boolean {
        if (!this.isEnabled()) {
            return false;
        }

        const allowedSet = new Set(plan.allowedCadences || []);
        if (allowedSet.has(cadence)) {
            return false;
        }

        return billingMode !== WorkScheduleBillingMode.USAGE;
    }

    private recommendationForCadence(cadence: WorkScheduleCadence): string {
        switch (cadence) {
            case WorkScheduleCadence.HOURLY:
            case WorkScheduleCadence.EVERY_3_HOURS:
            case WorkScheduleCadence.EVERY_8_HOURS:
                return 'Premium';
            case WorkScheduleCadence.EVERY_12_HOURS:
            case WorkScheduleCadence.DAILY:
            case WorkScheduleCadence.WEEKLY:
                return 'Standard';
            default:
                return 'Free';
        }
    }

    private normalizePlanCode(value: string): SubscriptionPlanCode {
        const normalized = value?.toLowerCase();
        if (Object.values(SubscriptionPlanCode).includes(normalized as SubscriptionPlanCode)) {
            return normalized as SubscriptionPlanCode;
        }

        return SubscriptionPlanCode.FREE;
    }

    /**
     * A plan that carries a recurring subscription price must be paid for
     * through a billing-verified path; only free plans (`monthlyPrice` 0) are
     * self-serviceable. (Per-run overage is metered separately and does not
     * make a plan "paid" to switch onto.)
     */
    private isPaidPlan(plan: SubscriptionPlan): boolean {
        const raw = plan.monthlyPrice;
        // Fail closed: a plan is free (self-serviceable) ONLY when its
        // `monthlyPrice` is explicitly present and parses to a finite,
        // non-positive number. A missing / null / NaN / positive value is
        // treated as PAID so a malformed plan row can never be self-granted.
        // (`Number(null)` is 0 and `Number(undefined)` is NaN — neither should
        // read as "free", hence the explicit null/undefined guard.)
        if (raw === null || raw === undefined) {
            return true;
        }
        const price = Number(raw);
        return !(Number.isFinite(price) && price <= 0);
    }

    private async resolvePlanOrThrow(planCode: SubscriptionPlanCode): Promise<SubscriptionPlan> {
        const plan = await this.planRepository.findByCode(this.normalizePlanCode(planCode));
        if (!plan) {
            throw new NotFoundException('Plan not found');
        }
        return plan;
    }

    private async persistDefaultPlan(
        user: User,
        plan: SubscriptionPlan,
    ): Promise<SubscriptionPlan> {
        await this.userRepository.update(user.id, { defaultPlanId: plan.id });
        user.defaultPlan = plan;
        user.defaultPlanId = plan.id;
        return plan;
    }

    /**
     * PRIVILEGED grant — assigns ANY plan (including paid tiers) with NO
     * self-service gate. Call this ONLY from a billing-verified path (a
     * payment-provider webhook, once wired) or an admin/platform context.
     *
     * Security (EW-711 #23): user-initiated plan changes MUST go through
     * {@link changePlanSelfService}, which refuses paid plans — otherwise any
     * authenticated user could escalate to a paid tier without paying.
     */
    async assignPlanToUser(user: User, planCode: SubscriptionPlanCode): Promise<SubscriptionPlan> {
        if (!this.isEnabled()) {
            throw new BadRequestException('Subscriptions are disabled');
        }
        const plan = await this.resolvePlanOrThrow(planCode);
        return this.persistDefaultPlan(user, plan);
    }

    /**
     * User-initiated (self-service) plan change. May only move the caller to a
     * FREE plan — the sign-up default, a self-downgrade, or a cancel. A paid
     * plan requires a billing-verified grant ({@link assignPlanToUser}), so a
     * self-assignment of one is rejected with 403.
     *
     * EW-711 #23 — closes the free→paid privilege escalation on
     * `POST /api/subscriptions/plan` (any authenticated user could previously
     * self-grant PREMIUM/STANDARD with no payment).
     */
    async changePlanSelfService(
        user: User,
        planCode: SubscriptionPlanCode,
    ): Promise<SubscriptionPlan> {
        if (!this.isEnabled()) {
            throw new BadRequestException('Subscriptions are disabled');
        }
        const plan = await this.resolvePlanOrThrow(planCode);
        // EW-711 #23 — a paid plan requires a billing-verified grant
        // ({@link assignPlanToUser}). The only exception is the e2e/test
        // escape hatch (default OFF, hard-gated off in production) so the
        // tier-gating / billing-grace specs can reach STANDARD/PREMIUM
        // without a real billing integration. See
        // `config.subscriptions.allowSelfServePaidPlans`.
        if (this.isPaidPlan(plan) && !config.subscriptions.allowSelfServePaidPlans()) {
            throw new ForbiddenException(
                'Paid plans must be activated through billing and cannot be self-assigned.',
            );
        }
        return this.persistDefaultPlan(user, plan);
    }

    async summarizePlan(user: User) {
        const [plan, allowances] = await Promise.all([
            this.resolvePlanForUser(user),
            this.getCadenceAllowances(user),
        ]);

        return {
            plan,
            allowances,
            enabled: this.isEnabled(),
        };
    }

    private async resolveDefaultPlan(): Promise<SubscriptionPlan> {
        const defaultCode = this.normalizePlanCode(config.subscriptions.getDefaultPlanCode());
        const plan = await this.planRepository.findByCode(defaultCode);

        if (plan) {
            return plan;
        }

        this.logger.warn(`Subscription plan ${defaultCode} not found, falling back to FREE`);
        const fallback = await this.planRepository.findByCode(SubscriptionPlanCode.FREE);

        if (!fallback) {
            throw new Error('Default subscription plan not found');
        }

        return fallback;
    }
}
