import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import { SubscriptionPlanRepository } from '@src/database/repositories/subscription-plan.repository';
import { UserSubscriptionRepository } from '@src/database/repositories/user-subscription.repository';
import { SubscriptionPlan } from '@src/entities/subscription-plan.entity';
import { config } from '@src/config';
import { DirectoryScheduleAllowedCadence } from '@src/dto';
import { User } from '@src/entities/user.entity';
import { UserRepository } from '@src/database/repositories/user.repository';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    SubscriptionPlanCode,
} from '@src/entities';

const ALL_CADENCES: DirectoryScheduleCadence[] = [
    DirectoryScheduleCadence.MONTHLY,
    DirectoryScheduleCadence.WEEKLY,
    DirectoryScheduleCadence.DAILY,
    DirectoryScheduleCadence.HOURLY,
];

const PLAN_SEED_DATA: Array<{
    code: SubscriptionPlanCode;
    displayName: string;
    maxDirectories: number;
    allowedCadences: DirectoryScheduleCadence[];
    monthlyPrice: string;
    overagePricePerRun: string;
}> = [
    {
        code: SubscriptionPlanCode.FREE,
        displayName: 'Free',
        maxDirectories: 1,
        // allowedCadences: [DirectoryScheduleCadence.MONTHLY],
        allowedCadences: ALL_CADENCES, // for now everything is free
        monthlyPrice: '0',
        overagePricePerRun: '10',
    },
    {
        code: SubscriptionPlanCode.STANDARD,
        displayName: 'Standard',
        maxDirectories: 5,
        allowedCadences: [
            DirectoryScheduleCadence.MONTHLY,
            DirectoryScheduleCadence.WEEKLY,
            DirectoryScheduleCadence.DAILY,
        ],
        monthlyPrice: '29',
        overagePricePerRun: '8',
    },
    {
        code: SubscriptionPlanCode.PREMIUM,
        displayName: 'Premium',
        maxDirectories: 15,
        allowedCadences: [
            DirectoryScheduleCadence.MONTHLY,
            DirectoryScheduleCadence.WEEKLY,
            DirectoryScheduleCadence.DAILY,
            DirectoryScheduleCadence.HOURLY,
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

    async getCadenceAllowances(user: User): Promise<DirectoryScheduleAllowedCadence[]> {
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

    getDefaultCadence(plan: SubscriptionPlan): DirectoryScheduleCadence {
        const allowed = (plan.allowedCadences || []) as DirectoryScheduleCadence[];
        if (allowed.length > 0) {
            return allowed[allowed.length - 1];
        }

        return DirectoryScheduleCadence.MONTHLY;
    }

    requiresUsageBilling(
        cadence: DirectoryScheduleCadence,
        plan: SubscriptionPlan,
        billingMode: DirectoryScheduleBillingMode,
    ): boolean {
        if (!this.isEnabled()) {
            return false;
        }

        const allowedSet = new Set(plan.allowedCadences || []);
        if (allowedSet.has(cadence)) {
            return false;
        }

        return billingMode !== DirectoryScheduleBillingMode.USAGE;
    }

    private recommendationForCadence(cadence: DirectoryScheduleCadence): string {
        switch (cadence) {
            case DirectoryScheduleCadence.HOURLY:
                return 'Premium';
            case DirectoryScheduleCadence.DAILY:
            case DirectoryScheduleCadence.WEEKLY:
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

    async assignPlanToUser(user: User, planCode: SubscriptionPlanCode): Promise<SubscriptionPlan> {
        if (!this.isEnabled()) {
            throw new BadRequestException('Subscriptions are disabled');
        }

        const normalized = this.normalizePlanCode(planCode);
        const plan = await this.planRepository.findByCode(normalized);

        if (!plan) {
            throw new NotFoundException('Plan not found');
        }

        await this.userRepository.update(user.id, { defaultPlanId: plan.id });
        user.defaultPlan = plan;
        user.defaultPlanId = plan.id;

        return plan;
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
