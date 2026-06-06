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

const ALL_CADENCES: WorkScheduleCadence[] = [
    WorkScheduleCadence.MONTHLY,
    WorkScheduleCadence.WEEKLY,
    WorkScheduleCadence.DAILY,
    WorkScheduleCadence.EVERY_12_HOURS,
    WorkScheduleCadence.EVERY_8_HOURS,
    WorkScheduleCadence.EVERY_3_HOURS,
    WorkScheduleCadence.HOURLY,
];

const PLAN_SEED_DATA: Array<{
    code: SubscriptionPlanCode;
    displayName: string;
    maxWorks: number;
    allowedCadences: WorkScheduleCadence[];
    monthlyPrice: string;
    overagePricePerRun: string;
}> = [
    {
        code: SubscriptionPlanCode.FREE,
        displayName: 'Free',
        maxWorks: 1,
        // allowedCadences: [WorkScheduleCadence.MONTHLY],
        allowedCadences: ALL_CADENCES, // for now everything is free
        monthlyPrice: '0',
        overagePricePerRun: '10',
    },
    {
        code: SubscriptionPlanCode.STANDARD,
        displayName: 'Standard',
        maxWorks: 5,
        allowedCadences: [
            WorkScheduleCadence.MONTHLY,
            WorkScheduleCadence.WEEKLY,
            WorkScheduleCadence.DAILY,
            WorkScheduleCadence.EVERY_12_HOURS,
        ],
        monthlyPrice: '29',
        overagePricePerRun: '8',
    },
    {
        code: SubscriptionPlanCode.PREMIUM,
        displayName: 'Premium',
        maxWorks: 15,
        allowedCadences: [
            WorkScheduleCadence.MONTHLY,
            WorkScheduleCadence.WEEKLY,
            WorkScheduleCadence.DAILY,
            WorkScheduleCadence.EVERY_12_HOURS,
            WorkScheduleCadence.EVERY_8_HOURS,
            WorkScheduleCadence.EVERY_3_HOURS,
            WorkScheduleCadence.HOURLY,
        ],
        monthlyPrice: '99',
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
        return Number(plan.monthlyPrice) > 0;
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
        if (this.isPaidPlan(plan)) {
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
