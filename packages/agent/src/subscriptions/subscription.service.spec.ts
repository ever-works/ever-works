import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionPlanCode } from '@src/entities/types';
import { WorkScheduleBillingMode, WorkScheduleCadence } from '@ever-works/contracts/api';

/**
 * SubscriptionService is the agent-package gateway between user accounts and
 * the seeded `SubscriptionPlan` rows. It owns: idempotent plan seeding from
 * a hard-coded `PLAN_SEED_DATA` table, the FREE/STANDARD/PREMIUM cadence
 * matrix (which maps directly to the upgrade-recommendation copy in the UI),
 * the per-user "active subscription → user.defaultPlan → resolved-default"
 * fallback chain, and a kill-switch reading `config.subscriptions.isEnabled`
 * from env.
 *
 * No real DB / Nest container is booted — the three repositories are pure
 * `jest.fn()` shells, and the env knobs are flipped via `process.env`.
 */

const ALL_CADENCES_IN_PUBLIC_ORDER: WorkScheduleCadence[] = [
    WorkScheduleCadence.MONTHLY,
    WorkScheduleCadence.WEEKLY,
    WorkScheduleCadence.DAILY,
    WorkScheduleCadence.EVERY_12_HOURS,
    WorkScheduleCadence.EVERY_8_HOURS,
    WorkScheduleCadence.EVERY_3_HOURS,
    WorkScheduleCadence.HOURLY,
];

const STANDARD_ALLOWED_CADENCES: WorkScheduleCadence[] = [
    WorkScheduleCadence.MONTHLY,
    WorkScheduleCadence.WEEKLY,
    WorkScheduleCadence.DAILY,
    WorkScheduleCadence.EVERY_12_HOURS,
];

function makePlanRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        upsert: jest.fn().mockResolvedValue(undefined),
        findByCode: jest.fn(),
        ...overrides,
    };
}

function makeUserSubscriptionRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        findActiveByUser: jest.fn(),
        ...overrides,
    };
}

function makeUserRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeService(
    plan: Record<string, jest.Mock> = {},
    userSub: Record<string, jest.Mock> = {},
    user: Record<string, jest.Mock> = {},
) {
    const planRepository = makePlanRepository(plan);
    const userSubscriptionRepository = makeUserSubscriptionRepository(userSub);
    const userRepository = makeUserRepository(user);
    const service = new SubscriptionService(
        planRepository as any,
        userSubscriptionRepository as any,
        userRepository as any,
    );
    return { service, planRepository, userSubscriptionRepository, userRepository };
}

const FREE_PLAN = {
    id: 'plan-free',
    code: SubscriptionPlanCode.FREE,
    displayName: 'Free',
    maxWorks: 1,
    allowedCadences: ALL_CADENCES_IN_PUBLIC_ORDER,
    monthlyPrice: '0',
    overagePricePerRun: '10',
};

const STANDARD_PLAN = {
    id: 'plan-standard',
    code: SubscriptionPlanCode.STANDARD,
    displayName: 'Standard',
    maxWorks: 5,
    allowedCadences: STANDARD_ALLOWED_CADENCES,
    monthlyPrice: '29',
    overagePricePerRun: '8',
};

const PREMIUM_PLAN = {
    id: 'plan-premium',
    code: SubscriptionPlanCode.PREMIUM,
    displayName: 'Premium',
    maxWorks: 15,
    allowedCadences: ALL_CADENCES_IN_PUBLIC_ORDER,
    monthlyPrice: '99',
    overagePricePerRun: '0',
};

describe('SubscriptionService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            // Default: subscriptions enabled. Tests that need disabled flip
            // the var at the top of the test before calling the service.
            SUBSCRIPTIONS_ENABLED: 'true',
        };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('onModuleInit + seedPlans (idempotent boot-time seeding)', () => {
        it('upserts every PLAN_SEED_DATA row via the plan repository on boot', async () => {
            process.env.BILLING_DEFAULT_CURRENCY = 'eur';
            const { service, planRepository } = makeService();

            await service.onModuleInit();

            // Three rows: FREE, STANDARD, PREMIUM
            expect(planRepository.upsert).toHaveBeenCalledTimes(3);
            const codes = planRepository.upsert.mock.calls.map((call) => call[0].code).sort();
            expect(codes).toEqual(
                [
                    SubscriptionPlanCode.FREE,
                    SubscriptionPlanCode.STANDARD,
                    SubscriptionPlanCode.PREMIUM,
                ].sort(),
            );
        });

        it('forwards the configured default currency on every upsert + sets active=true', async () => {
            process.env.BILLING_DEFAULT_CURRENCY = 'eur';
            const { service, planRepository } = makeService();
            await service.seedPlans();
            for (const call of planRepository.upsert.mock.calls) {
                expect(call[0].currency).toBe('eur');
                expect(call[0].active).toBe(true);
            }
        });

        it('FREE seed row pins maxWorks=1, monthlyPrice=0, overagePricePerRun=10, displayName=Free', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const free = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.FREE);
            expect(free).toMatchObject({
                code: SubscriptionPlanCode.FREE,
                displayName: 'Free',
                maxWorks: 1,
                monthlyPrice: '0',
                overagePricePerRun: '10',
            });
        });

        it('STANDARD seed row pins maxWorks=5, monthlyPrice=29 + the 4 allowed cadences', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const std = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.STANDARD);
            expect(std).toMatchObject({
                code: SubscriptionPlanCode.STANDARD,
                displayName: 'Standard',
                maxWorks: 5,
                monthlyPrice: '29',
                overagePricePerRun: '8',
            });
            expect(std.allowedCadences).toEqual(STANDARD_ALLOWED_CADENCES);
        });

        it('PREMIUM seed row pins maxWorks=15, monthlyPrice=99, overagePricePerRun=0 + ALL cadences', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const premium = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.PREMIUM);
            expect(premium).toMatchObject({
                code: SubscriptionPlanCode.PREMIUM,
                displayName: 'Premium',
                maxWorks: 15,
                monthlyPrice: '99',
                overagePricePerRun: '0',
            });
            // Premium has the same cadence set as the FREE "everything-allowed
            // for now" row, but listed in the explicit order from the seed —
            // confirm it contains exactly the seven values without ordering.
            expect(new Set(premium.allowedCadences)).toEqual(new Set(ALL_CADENCES_IN_PUBLIC_ORDER));
            expect(premium.allowedCadences).toHaveLength(7);
        });

        it('all seeds run in parallel via Promise.all (no per-row sequencing)', async () => {
            // Resolve order doesn't matter — but Promise.all means a single
            // rejection causes the whole onModuleInit to reject. Pin that.
            const { service, planRepository } = makeService({
                upsert: jest
                    .fn()
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(new Error('db down'))
                    .mockResolvedValueOnce(undefined),
            });

            await expect(service.onModuleInit()).rejects.toThrow('db down');
            expect(planRepository.upsert).toHaveBeenCalledTimes(3);
        });
    });

    describe('isEnabled (mirrors config.subscriptions.isEnabled — strict "true" literal)', () => {
        it.each([
            ['true', true],
            ['false', false],
            ['TRUE', false],
            ['1', false],
            ['', false],
            [undefined, false],
        ] as const)('SUBSCRIPTIONS_ENABLED=%j → %s', (raw, expected) => {
            if (raw === undefined) {
                delete process.env.SUBSCRIPTIONS_ENABLED;
            } else {
                process.env.SUBSCRIPTIONS_ENABLED = raw;
            }
            const { service } = makeService();
            expect(service.isEnabled()).toBe(expected);
        });
    });

    describe('getActiveSubscription', () => {
        it('forwards userId verbatim to userSubscriptionRepository.findActiveByUser', async () => {
            const subscription = { id: 'sub-1', plan: STANDARD_PLAN };
            const { service, userSubscriptionRepository } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue(subscription) },
            );

            await expect(service.getActiveSubscription('u1')).resolves.toBe(subscription);
            expect(userSubscriptionRepository.findActiveByUser).toHaveBeenCalledWith('u1');
        });
    });

    describe('resolvePlanForUser (active sub → user.defaultPlan → default plan fallback)', () => {
        it('returns the active subscription plan when one exists', async () => {
            const subscription = { id: 'sub-1', plan: PREMIUM_PLAN };
            const { service, userSubscriptionRepository, planRepository } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue(subscription) },
            );

            const plan = await service.resolvePlanForUser({ id: 'u1' } as any);
            expect(plan).toBe(PREMIUM_PLAN);
            expect(userSubscriptionRepository.findActiveByUser).toHaveBeenCalledWith('u1');
            expect(planRepository.findByCode).not.toHaveBeenCalled();
        });

        it('falls back to user.defaultPlan when there is no active subscription', async () => {
            const { service, userSubscriptionRepository, planRepository } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue(null) },
            );

            const plan = await service.resolvePlanForUser({
                id: 'u1',
                defaultPlan: STANDARD_PLAN,
            } as any);
            expect(plan).toBe(STANDARD_PLAN);
            expect(userSubscriptionRepository.findActiveByUser).toHaveBeenCalledWith('u1');
            expect(planRepository.findByCode).not.toHaveBeenCalled();
        });

        it('falls back to user.defaultPlan when active subscription has no plan field', async () => {
            // Edge: an active subscription row that lost its `plan` join — we
            // skip past it instead of returning `undefined`.
            const { service } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue({ id: 'sub-1' }) },
            );

            const plan = await service.resolvePlanForUser({
                id: 'u1',
                defaultPlan: PREMIUM_PLAN,
            } as any);
            expect(plan).toBe(PREMIUM_PLAN);
        });

        it('falls back to resolveDefaultPlan when no active sub AND no user.defaultPlan', async () => {
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'standard';
            const { service, planRepository } = makeService(
                { findByCode: jest.fn().mockResolvedValue(STANDARD_PLAN) },
                { findActiveByUser: jest.fn().mockResolvedValue(null) },
            );

            const plan = await service.resolvePlanForUser({ id: 'u1' } as any);
            expect(plan).toBe(STANDARD_PLAN);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.STANDARD);
        });

        it('short-circuits to resolveDefaultPlan when the kill-switch is OFF (no DB lookup of active sub)', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service, planRepository, userSubscriptionRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(FREE_PLAN),
            });

            const plan = await service.resolvePlanForUser({
                id: 'u1',
                defaultPlan: STANDARD_PLAN,
            } as any);
            expect(plan).toBe(FREE_PLAN);
            expect(userSubscriptionRepository.findActiveByUser).not.toHaveBeenCalled();
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.FREE);
        });
    });

    describe('resolveDefaultPlan (private, exercised via resolvePlanForUser when kill-switch is OFF)', () => {
        it('uses the env-configured default plan code', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'premium';
            const { service, planRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(PREMIUM_PLAN),
            });

            const plan = await service.resolvePlanForUser({ id: 'u1' } as any);
            expect(plan).toBe(PREMIUM_PLAN);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.PREMIUM);
        });

        it('lowercases env value before normalising (matches config.getDefaultPlanCode no-normalisation behavior)', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'PREMIUM';
            const { service, planRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(PREMIUM_PLAN),
            });

            await service.resolvePlanForUser({ id: 'u1' } as any);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.PREMIUM);
        });

        it('coerces unknown plan code → FREE (silent fallback at normaliser)', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'enterprise-tier-2';
            const findByCode = jest.fn().mockResolvedValue(FREE_PLAN);
            const { service, planRepository } = makeService({ findByCode });

            await service.resolvePlanForUser({ id: 'u1' } as any);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.FREE);
        });

        it('falls back to FREE + warns when the configured default plan is missing in DB', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'standard';
            const { service, planRepository } = makeService({
                findByCode: jest
                    .fn()
                    .mockResolvedValueOnce(null) // 'standard' missing
                    .mockResolvedValueOnce(FREE_PLAN), // 'free' present
            });

            const plan = await service.resolvePlanForUser({ id: 'u1' } as any);
            expect(plan).toBe(FREE_PLAN);
            expect(planRepository.findByCode).toHaveBeenNthCalledWith(
                1,
                SubscriptionPlanCode.STANDARD,
            );
            expect(planRepository.findByCode).toHaveBeenNthCalledWith(
                2,
                SubscriptionPlanCode.FREE,
            );
        });

        it('throws when the configured plan AND the FREE fallback are both missing', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'premium';
            const { service } = makeService({
                findByCode: jest.fn().mockResolvedValue(null),
            });

            await expect(service.resolvePlanForUser({ id: 'u1' } as any)).rejects.toThrow(
                /Default subscription plan not found/,
            );
        });
    });

    describe('getCadenceAllowances', () => {
        it('returns ALL cadences `allowed:true, payPerUse:false` when the kill-switch is OFF', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service } = makeService();

            const result = await service.getCadenceAllowances({ id: 'u1' } as any);
            expect(result).toHaveLength(7);
            for (const allowance of result) {
                expect(allowance.allowed).toBe(true);
                expect(allowance.payPerUse).toBe(false);
                expect(allowance.reason).toBeUndefined();
            }
        });

        it('returns the cadence list in the documented public order (Monthly→Hourly)', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service } = makeService();
            const result = await service.getCadenceAllowances({ id: 'u1' } as any);
            expect(result.map((a) => a.cadence)).toEqual(ALL_CADENCES_IN_PUBLIC_ORDER);
        });

        it('marks cadences NOT in the resolved plan as payPerUse:true with the upgrade-recommendation reason', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'true';
            const { service } = makeService(
                {},
                {
                    findActiveByUser: jest
                        .fn()
                        .mockResolvedValue({ plan: STANDARD_PLAN }),
                },
            );

            const result = await service.getCadenceAllowances({ id: 'u1' } as any);
            const byCadence = Object.fromEntries(result.map((a) => [a.cadence, a]));

            // Standard plan allowances (4 of them): allowed:true, payPerUse:false, no reason
            for (const cadence of STANDARD_ALLOWED_CADENCES) {
                expect(byCadence[cadence].allowed).toBe(true);
                expect(byCadence[cadence].payPerUse).toBe(false);
                expect(byCadence[cadence].reason).toBeUndefined();
            }

            // The three NOT-allowed cadences should recommend Premium
            for (const cadence of [
                WorkScheduleCadence.EVERY_8_HOURS,
                WorkScheduleCadence.EVERY_3_HOURS,
                WorkScheduleCadence.HOURLY,
            ]) {
                expect(byCadence[cadence].allowed).toBe(false);
                expect(byCadence[cadence].payPerUse).toBe(true);
                expect(byCadence[cadence].reason).toBe(
                    'Upgrade to Premium for this cadence',
                );
            }
        });

        it('treats a plan with `allowedCadences=null` as zero-allowance (every cadence becomes pay-per-use)', async () => {
            const planWithoutCadences = { ...STANDARD_PLAN, allowedCadences: null };
            const { service } = makeService(
                {},
                {
                    findActiveByUser: jest
                        .fn()
                        .mockResolvedValue({ plan: planWithoutCadences }),
                },
            );

            const result = await service.getCadenceAllowances({ id: 'u1' } as any);
            for (const allowance of result) {
                expect(allowance.allowed).toBe(false);
                expect(allowance.payPerUse).toBe(true);
                expect(allowance.reason).toMatch(/^Upgrade to /);
            }
        });
    });

    describe('recommendationForCadence (private, exercised via reason copy)', () => {
        // The decision matrix backs the upgrade-recommendation copy in the UI.
        // Validated by emitting a pure-payPerUse plan (allowedCadences: []) so
        // EVERY cadence triggers the reason field.
        it.each([
            [WorkScheduleCadence.HOURLY, 'Premium'],
            [WorkScheduleCadence.EVERY_3_HOURS, 'Premium'],
            [WorkScheduleCadence.EVERY_8_HOURS, 'Premium'],
            [WorkScheduleCadence.EVERY_12_HOURS, 'Standard'],
            [WorkScheduleCadence.DAILY, 'Standard'],
            [WorkScheduleCadence.WEEKLY, 'Standard'],
            [WorkScheduleCadence.MONTHLY, 'Free'],
        ] as const)('%s cadence → recommend %s', async (cadence, recommended) => {
            const emptyPlan = { ...FREE_PLAN, allowedCadences: [] };
            const { service } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue({ plan: emptyPlan }) },
            );
            const result = await service.getCadenceAllowances({ id: 'u1' } as any);
            const a = result.find((x) => x.cadence === cadence)!;
            expect(a.reason).toBe(`Upgrade to ${recommended} for this cadence`);
        });
    });

    describe('getDefaultCadence', () => {
        it('returns the LAST entry of plan.allowedCadences (smallest interval = best slot)', () => {
            const { service } = makeService();
            const cadence = service.getDefaultCadence({
                allowedCadences: [
                    WorkScheduleCadence.MONTHLY,
                    WorkScheduleCadence.WEEKLY,
                    WorkScheduleCadence.DAILY,
                ],
            } as any);
            expect(cadence).toBe(WorkScheduleCadence.DAILY);
        });

        it('returns MONTHLY when allowedCadences is empty', () => {
            const { service } = makeService();
            expect(service.getDefaultCadence({ allowedCadences: [] } as any)).toBe(
                WorkScheduleCadence.MONTHLY,
            );
        });

        it('returns MONTHLY when allowedCadences is nullish', () => {
            const { service } = makeService();
            expect(
                service.getDefaultCadence({ allowedCadences: undefined } as any),
            ).toBe(WorkScheduleCadence.MONTHLY);
            expect(
                service.getDefaultCadence({ allowedCadences: null } as any),
            ).toBe(WorkScheduleCadence.MONTHLY);
        });
    });

    describe('requiresUsageBilling', () => {
        it('returns false when subscriptions are disabled (everything is "free" → no usage charge)', () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service } = makeService();
            expect(
                service.requiresUsageBilling(
                    WorkScheduleCadence.HOURLY,
                    PREMIUM_PLAN as any,
                    WorkScheduleBillingMode.SUBSCRIPTION,
                ),
            ).toBe(false);
        });

        it('returns false when the cadence IS in the plan (no usage billing required for in-plan cadences)', () => {
            const { service } = makeService();
            expect(
                service.requiresUsageBilling(
                    WorkScheduleCadence.MONTHLY,
                    STANDARD_PLAN as any,
                    WorkScheduleBillingMode.SUBSCRIPTION,
                ),
            ).toBe(false);
        });

        it('returns true when the cadence is OUT-OF-PLAN AND billingMode !== USAGE (caller must opt into usage)', () => {
            const { service } = makeService();
            expect(
                service.requiresUsageBilling(
                    WorkScheduleCadence.HOURLY,
                    STANDARD_PLAN as any,
                    WorkScheduleBillingMode.SUBSCRIPTION,
                ),
            ).toBe(true);
        });

        it('returns false when the cadence is OUT-OF-PLAN but billingMode === USAGE (already opted in)', () => {
            const { service } = makeService();
            expect(
                service.requiresUsageBilling(
                    WorkScheduleCadence.HOURLY,
                    STANDARD_PLAN as any,
                    WorkScheduleBillingMode.USAGE,
                ),
            ).toBe(false);
        });

        it('treats a plan with nullish allowedCadences as fully out-of-plan', () => {
            const { service } = makeService();
            const noCadencesPlan = { ...STANDARD_PLAN, allowedCadences: null };
            expect(
                service.requiresUsageBilling(
                    WorkScheduleCadence.MONTHLY,
                    noCadencesPlan as any,
                    WorkScheduleBillingMode.SUBSCRIPTION,
                ),
            ).toBe(true);
        });
    });

    describe('assignPlanToUser', () => {
        it('throws BadRequestException when subscriptions are disabled', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service } = makeService();
            await expect(
                service.assignPlanToUser(
                    { id: 'u1' } as any,
                    SubscriptionPlanCode.PREMIUM,
                ),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws NotFoundException when the requested plan code is not in the DB', async () => {
            const { service } = makeService({ findByCode: jest.fn().mockResolvedValue(null) });
            await expect(
                service.assignPlanToUser(
                    { id: 'u1' } as any,
                    SubscriptionPlanCode.PREMIUM,
                ),
            ).rejects.toThrow(NotFoundException);
        });

        it('lowercase-normalises input plan codes (so "PREMIUM" still resolves to "premium")', async () => {
            const { service, planRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(PREMIUM_PLAN),
            });
            await service.assignPlanToUser({ id: 'u1' } as any, 'PREMIUM' as any);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.PREMIUM);
        });

        it('falls back to FREE for unknown input codes', async () => {
            const { service, planRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(FREE_PLAN),
            });
            await service.assignPlanToUser({ id: 'u1' } as any, 'enterprise' as any);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.FREE);
        });

        it('on success: persists user.defaultPlanId via UserRepository.update + mutates the user object in-place', async () => {
            const user = { id: 'u1', defaultPlan: undefined, defaultPlanId: undefined } as any;
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(STANDARD_PLAN),
            });

            const plan = await service.assignPlanToUser(user, SubscriptionPlanCode.STANDARD);
            expect(plan).toBe(STANDARD_PLAN);
            expect(userRepository.update).toHaveBeenCalledWith('u1', {
                defaultPlanId: STANDARD_PLAN.id,
            });
            expect(user.defaultPlan).toBe(STANDARD_PLAN);
            expect(user.defaultPlanId).toBe(STANDARD_PLAN.id);
        });

        it('handles the no-string-passed branch (`value?.toLowerCase()` short-circuit) by falling back to FREE', async () => {
            const { service, planRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(FREE_PLAN),
            });
            await service.assignPlanToUser({ id: 'u1' } as any, undefined as any);
            expect(planRepository.findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.FREE);
        });
    });

    describe('summarizePlan', () => {
        it('returns { plan, allowances, enabled } populated from resolvePlanForUser + getCadenceAllowances', async () => {
            const subscription = { plan: STANDARD_PLAN };
            const { service } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue(subscription) },
            );

            const summary = await service.summarizePlan({ id: 'u1' } as any);
            expect(summary.plan).toBe(STANDARD_PLAN);
            expect(summary.enabled).toBe(true);
            expect(summary.allowances).toHaveLength(7);
            expect(summary.allowances.map((a) => a.cadence)).toEqual(
                ALL_CADENCES_IN_PUBLIC_ORDER,
            );
        });

        it('reflects the kill-switch in `enabled` and resolves the default plan', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service } = makeService({
                findByCode: jest.fn().mockResolvedValue(FREE_PLAN),
            });

            const summary = await service.summarizePlan({ id: 'u1' } as any);
            expect(summary.enabled).toBe(false);
            expect(summary.plan).toBe(FREE_PLAN);
            // When disabled, every cadence becomes allowed:true
            for (const a of summary.allowances) {
                expect(a.allowed).toBe(true);
            }
        });
    });
});
