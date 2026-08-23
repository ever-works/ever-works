import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

            // Six rows: three cloud tiers and three self-hosted editions.
            expect(planRepository.upsert).toHaveBeenCalledTimes(6);
            const codes = planRepository.upsert.mock.calls.map((call) => call[0].code).sort();
            expect(codes).toEqual(
                [
                    SubscriptionPlanCode.FREE,
                    SubscriptionPlanCode.STANDARD,
                    SubscriptionPlanCode.PREMIUM,
                    SubscriptionPlanCode.SELFHOSTED_COMMUNITY,
                    SubscriptionPlanCode.SELFHOSTED_PRO,
                    SubscriptionPlanCode.SELFHOSTED_ENTERPRISE,
                ].sort(),
            );
        });

        /**
         * 🛑 Every seeded code MUST be a member of `SubscriptionPlanCode`.
         *
         * `PlanSubscriptionService.findPlanByCode` rejects any code that is not in the enum
         * BEFORE it reaches the repository, and `activate()` treats "no plan" as
         * "activation skipped" — a warning log and a `false`. So a plan seeded with a code the
         * enum does not carry is fully purchasable and then silently grants nothing: the money
         * moves, the webhook returns `ignored`, and the buyer gets no tier. Nothing else in the
         * suite would catch it, because seeding and activation are tested apart.
         */
        it('seeds no plan code that SubscriptionPlanCode does not carry', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const seeded = planRepository.upsert.mock.calls.map((c) => c[0].code);
            const known = new Set<string>(Object.values(SubscriptionPlanCode));

            expect(seeded.length).toBeGreaterThan(0); // never pass vacuously
            expect(seeded.filter((c: string) => !known.has(c))).toEqual([]);
        });

        /**
         * 🛑 REGRESSION. `maxWorks` is a Postgres `integer` (ceiling 2147483647). Seeding
         * `Number.MAX_SAFE_INTEGER` (9007199254740991) as "unlimited" made Postgres reject the
         * INSERT with `integer out of range` — and because `seedPlans()` runs inside
         * `onModuleInit`, that does not degrade gracefully: module init aborts and the API never
         * finishes booting, on dev, stage AND production alike.
         *
         * Nothing else in this suite can catch it, because `planRepository` is a mock here and a
         * mock accepts any number. This test encodes the column's real ceiling so the value is
         * checked without a database.
         */
        const PG_INT4_MAX = 2_147_483_647;

        it('seeds no integer quota that Postgres int4 would reject', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const rows = planRepository.upsert.mock.calls.map((c) => c[0]);

            expect(rows.length).toBeGreaterThan(0); // never pass vacuously
            for (const row of rows) {
                expect({ code: row.code, maxWorks: row.maxWorks }).toEqual({
                    code: row.code,
                    maxWorks: expect.any(Number),
                });
                expect(row.maxWorks).toBeLessThanOrEqual(PG_INT4_MAX);
                expect(row.maxWorks).toBeGreaterThanOrEqual(0);
                expect(Number.isInteger(row.maxWorks)).toBe(true);
            }
        });

        it('seeds prices that fit decimal(10,2) and parse back to the same number', async () => {
            // The price columns are decimal(10,2) — max 99,999,999.99 — and TypeORM hands them back
            // as STRINGS. A value that does not round-trip would bill a different amount than the
            // one reviewed here.
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const rows = planRepository.upsert.mock.calls.map((c) => c[0]);

            for (const row of rows) {
                for (const field of ['monthlyPrice', 'annualPrice', 'lifetimePrice'] as const) {
                    const raw = row[field];
                    if (raw === null || raw === undefined) continue;
                    expect(typeof raw).toBe('string');
                    const n = Number(raw);
                    expect(Number.isFinite(n)).toBe(true);
                    expect(n).toBeLessThan(100_000_000);
                    expect(n).toBeGreaterThanOrEqual(0);
                    // Two decimal places at most, or the column silently rounds the charge.
                    expect(Math.round(n * 100)).toBe(n * 100);
                }
            }
        });

        it('tags every row with a hosting mode, three cloud and three self-hosted', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const rows = planRepository.upsert.mock.calls.map((c) => c[0]);
            expect(rows.filter((p: any) => p.hosting === 'cloud')).toHaveLength(3);
            expect(rows.filter((p: any) => p.hosting === 'selfhosted')).toHaveLength(3);
            // Nothing may seed without a hosting mode — the Stripe lookup_key is derived from it.
            expect(
                rows.every((p: any) => p.hosting === 'cloud' || p.hosting === 'selfhosted'),
            ).toBe(true);
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

        it('STANDARD seed row is the "Pro" tier: $25/mo, $204/yr, 10 seats at $5 + the 4 allowed cadences', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const std = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.STANDARD);
            expect(std).toMatchObject({
                code: SubscriptionPlanCode.STANDARD,
                // The CODE stays 'standard' — it is stored on every existing subscription. Only the
                // display name moved to the tier ever.works has always advertised.
                displayName: 'Pro',
                hosting: 'cloud',
                maxWorks: 5,
                // Ever Gauzy / Ever Teams cloud Small Business. annualPrice is the YEARLY charge,
                // not the "$17/mo" the marketing site displays.
                monthlyPrice: '25',
                annualPrice: '204',
                lifetimePrice: null,
                seatsIncluded: 10,
                seatMonthlyPrice: '5',
                monthlyCredits: 3000,
                overagePricePerRun: '8',
            });
            expect(std.allowedCadences).toEqual(STANDARD_ALLOWED_CADENCES);
        });

        it('PREMIUM seed row is the "Enterprise" tier: $199/mo, $1,668/yr, 10 seats at $10 + ALL cadences', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const premium = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.PREMIUM);
            expect(premium).toMatchObject({
                code: SubscriptionPlanCode.PREMIUM,
                displayName: 'Enterprise',
                hosting: 'cloud',
                maxWorks: 15,
                monthlyPrice: '199',
                annualPrice: '1668',
                lifetimePrice: null,
                seatsIncluded: 10,
                seatMonthlyPrice: '10',
                monthlyCredits: 25000,
                overagePricePerRun: '0',
            });
            // Premium has the same cadence set as the FREE "everything-allowed
            // for now" row, but listed in the explicit order from the seed —
            // confirm it contains exactly the seven values without ordering.
            expect(new Set(premium.allowedCadences)).toEqual(new Set(ALL_CADENCES_IN_PUBLIC_ORDER));
            expect(premium.allowedCadences).toHaveLength(7);
        });

        it('SELFHOSTED_PRO seed row carries the one-time licence: $49/mo, $408/yr, $99 lifetime', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const pro = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.SELFHOSTED_PRO);
            expect(pro).toMatchObject({
                displayName: 'Pro Edition',
                hosting: 'selfhosted',
                monthlyPrice: '49',
                annualPrice: '408',
                // The ONLY row sold as a perpetual commercial licence. Anything with a
                // lifetimePrice is bought in Stripe `mode: payment`, never `subscription`.
                lifetimePrice: '99',
                seatsIncluded: 10,
                seatMonthlyPrice: '5',
                monthlyCredits: 3000,
            });
        });

        it('SELFHOSTED_COMMUNITY is the free AGPLv3 download: unbounded seats, nothing to sell', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const community = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .find((p: any) => p.code === SubscriptionPlanCode.SELFHOSTED_COMMUNITY);
            expect(community).toMatchObject({
                displayName: 'Community Edition',
                hosting: 'selfhosted',
                monthlyPrice: '0',
                annualPrice: '0',
                lifetimePrice: null,
                // null means UNBOUNDED — it must never be read as "zero seats included".
                seatsIncluded: null,
                seatMonthlyPrice: null,
            });
        });

        it('only the self-hosted Pro Edition is sold as a one-time licence', async () => {
            const { service, planRepository } = makeService();
            await service.seedPlans();
            const withLifetime = planRepository.upsert.mock.calls
                .map((c) => c[0])
                .filter((p: any) => p.lifetimePrice !== null && p.lifetimePrice !== undefined)
                .map((p: any) => p.code);
            expect(withLifetime).toEqual([SubscriptionPlanCode.SELFHOSTED_PRO]);
        });

        it('all seeds run in parallel via Promise.all (no per-row sequencing)', async () => {
            // Resolve order doesn't matter — but Promise.all means a single
            // rejection causes the whole onModuleInit to reject. Pin that.
            const { service, planRepository } = makeService({
                upsert: jest
                    .fn()
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(new Error('db down'))
                    .mockResolvedValue(undefined),
            });

            await expect(service.onModuleInit()).rejects.toThrow('db down');
            expect(planRepository.upsert).toHaveBeenCalledTimes(6);
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

        /**
         * 🛑 REGRESSION — the defect a first attempt at this fix missed entirely.
         *
         * `resolvePlanForUser` is the single place that answers "what plan is this user on", and it
         * reads the ACTIVE subscription BEFORE `user.defaultPlan`. So guarding only the writer was
         * not enough: an active row pointing at a self-hosted plan still made a $99 one-off licence
         * the buyer's effective HOSTED tier — the very arbitrage the fix was for.
         *
         * Guarding here covers every route: the webhook, the return path, any future writer, and
         * any row that already exists in the database.
         */
        it('IGNORES an active self-hosted subscription — a licence is not a hosted tier', async () => {
            const selfHosted = {
                id: 'sub-licence',
                plan: { ...PREMIUM_PLAN, code: 'selfhosted_pro', hosting: 'selfhosted' },
            };
            const { service } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue(selfHosted) },
            );

            const plan = await service.resolvePlanForUser({
                id: 'u1',
                defaultPlan: FREE_PLAN,
            } as any);

            // Falls through to what they actually pay for on this deployment.
            expect(plan).toBe(FREE_PLAN);
            expect((plan as any).code).not.toBe('selfhosted_pro');
        });

        it('still returns an active CLOUD subscription — the guard must not break the paying path', async () => {
            const cloud = { id: 'sub-1', plan: { ...PREMIUM_PLAN, hosting: 'cloud' } };
            const { service } = makeService(
                {},
                { findActiveByUser: jest.fn().mockResolvedValue(cloud) },
            );

            const plan = await service.resolvePlanForUser({ id: 'u1' } as any);
            expect((plan as any).code).toBe(PREMIUM_PLAN.code);
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

        /**
         * 🛑 REGRESSION. `SUBSCRIPTIONS_DEFAULT_PLAN` is an operator-set env var and
         * `normalizePlanCode` accepts ANY member of the enum — which now includes
         * `selfhosted_community`, a row that is free AND effectively unlimited. One typo in a Helm
         * value would hand every user with no subscription an unlimited plan, fleet-wide, with no
         * purchase involved. Same class as the self-service escalation, reached through
         * CONFIGURATION rather than a request.
         */
        it('REFUSES a self-hosted default plan and falls back to FREE', async () => {
            process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'selfhosted_community';
            const community = {
                ...FREE_PLAN,
                code: 'selfhosted_community',
                displayName: 'Community Edition',
                hosting: 'selfhosted',
                maxWorks: 2_147_483_647,
            };
            const findByCode = jest
                .fn()
                .mockImplementation(async (code: string) =>
                    code === 'selfhosted_community' ? community : FREE_PLAN,
                );
            const { service } = makeService(
                { findByCode },
                { findActiveByUser: jest.fn().mockResolvedValue(null) },
            );

            const plan = await service.resolvePlanForUser({ id: 'u1' } as any);

            // The unlimited row must NOT become everyone's default.
            expect((plan as any).code).toBe(FREE_PLAN.code);
            expect((plan as any).maxWorks).toBe(1);
            // It fell back rather than silently accepting the misconfiguration.
            expect(findByCode).toHaveBeenCalledWith(SubscriptionPlanCode.FREE);
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
            expect(planRepository.findByCode).toHaveBeenNthCalledWith(2, SubscriptionPlanCode.FREE);
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
                    findActiveByUser: jest.fn().mockResolvedValue({ plan: STANDARD_PLAN }),
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

            // The three NOT-allowed cadences should recommend Enterprise (the catalog name of `premium`)
            for (const cadence of [
                WorkScheduleCadence.EVERY_8_HOURS,
                WorkScheduleCadence.EVERY_3_HOURS,
                WorkScheduleCadence.HOURLY,
            ]) {
                expect(byCadence[cadence].allowed).toBe(false);
                expect(byCadence[cadence].payPerUse).toBe(true);
                expect(byCadence[cadence].reason).toBe('Upgrade to Enterprise for this cadence');
            }
        });

        it('treats a plan with `allowedCadences=null` as zero-allowance (every cadence becomes pay-per-use)', async () => {
            const planWithoutCadences = { ...STANDARD_PLAN, allowedCadences: null };
            const { service } = makeService(
                {},
                {
                    findActiveByUser: jest.fn().mockResolvedValue({ plan: planWithoutCadences }),
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
            [WorkScheduleCadence.HOURLY, 'Enterprise'],
            [WorkScheduleCadence.EVERY_3_HOURS, 'Enterprise'],
            [WorkScheduleCadence.EVERY_8_HOURS, 'Enterprise'],
            [WorkScheduleCadence.EVERY_12_HOURS, 'Pro'],
            [WorkScheduleCadence.DAILY, 'Pro'],
            [WorkScheduleCadence.WEEKLY, 'Pro'],
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
            expect(service.getDefaultCadence({ allowedCadences: undefined } as any)).toBe(
                WorkScheduleCadence.MONTHLY,
            );
            expect(service.getDefaultCadence({ allowedCadences: null } as any)).toBe(
                WorkScheduleCadence.MONTHLY,
            );
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
                service.assignPlanToUser({ id: 'u1' } as any, SubscriptionPlanCode.PREMIUM),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws NotFoundException when the requested plan code is not in the DB', async () => {
            const { service } = makeService({ findByCode: jest.fn().mockResolvedValue(null) });
            await expect(
                service.assignPlanToUser({ id: 'u1' } as any, SubscriptionPlanCode.PREMIUM),
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

    describe('changePlanSelfService (EW-711 #23 — self-service may only set FREE)', () => {
        it('throws BadRequestException when subscriptions are disabled', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service } = makeService();
            await expect(
                service.changePlanSelfService({ id: 'u1' } as any, SubscriptionPlanCode.FREE),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws NotFoundException when the requested plan code is not in the DB', async () => {
            const { service } = makeService({ findByCode: jest.fn().mockResolvedValue(null) });
            await expect(
                service.changePlanSelfService({ id: 'u1' } as any, SubscriptionPlanCode.FREE),
            ).rejects.toThrow(NotFoundException);
        });

        /**
         * 🛑 REGRESSION (EW-711 #23, reopened and re-closed 2026-08-22).
         *
         * Adding the self-hosted editions introduced a row that is genuinely FREE
         * (`monthlyPrice: '0'`) and genuinely UNLIMITED (`maxWorks` at the int4 ceiling, every
         * cadence) — correct for someone self-hosting the AGPLv3 platform, where quotas are
         * advisory because they own the database. But `isPaidPlan()` gates purely on price, so on
         * the HOSTED service that row looked self-serviceable: any authenticated user could POST
         * `{planCode:'selfhosted_community'}` and receive unlimited scheduled works plus hourly
         * cadence for free. Those entitlements ARE enforced — `work-schedule.service.ts` reads
         * `plan.maxWorks` and `getCadenceAllowances` — so this was a live free→paid escalation,
         * exactly what #23 exists to prevent. The price check alone is not sufficient once a
         * hosting axis exists.
         */
        it.each([
            SubscriptionPlanCode.SELFHOSTED_COMMUNITY,
            SubscriptionPlanCode.SELFHOSTED_PRO,
            SubscriptionPlanCode.SELFHOSTED_ENTERPRISE,
        ])('refuses to self-assign %s even when it is free-priced', async (code) => {
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue({
                    id: 'plan-sh',
                    code,
                    displayName: 'Community Edition',
                    hosting: 'selfhosted',
                    // Deliberately free AND unlimited — the exact shape that slipped past the
                    // price-only gate.
                    monthlyPrice: '0',
                    maxWorks: 2_147_483_647,
                    allowedCadences: ALL_CADENCES_IN_PUBLIC_ORDER,
                    overagePricePerRun: '0',
                }),
            });

            await expect(service.changePlanSelfService({ id: 'u1' } as any, code)).rejects.toThrow(
                ForbiddenException,
            );
            // The escalation is only truly closed if NOTHING was written.
            expect(userRepository.update).not.toHaveBeenCalled();
        });

        it('still allows a FREE CLOUD plan — the guard must not break the legitimate path', async () => {
            const user = { id: 'u1' } as any;
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue({ ...FREE_PLAN, hosting: 'cloud' }),
            });

            await expect(
                service.changePlanSelfService(user, SubscriptionPlanCode.FREE),
            ).resolves.toBeDefined();
            expect(userRepository.update).toHaveBeenCalled();
        });

        it('assigns a FREE plan (monthlyPrice 0) and persists it', async () => {
            const user = { id: 'u1' } as any;
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(FREE_PLAN),
            });
            const plan = await service.changePlanSelfService(user, SubscriptionPlanCode.FREE);
            expect(plan).toBe(FREE_PLAN);
            expect(userRepository.update).toHaveBeenCalledWith('u1', {
                defaultPlanId: FREE_PLAN.id,
            });
            expect(user.defaultPlanId).toBe(FREE_PLAN.id);
        });

        // The escalation the fix closes: a user must NOT be able to self-assign
        // a paid tier (monthlyPrice > 0) — that requires a billing-verified
        // grant via the privileged `assignPlanToUser`.
        it.each([
            ['STANDARD', SubscriptionPlanCode.STANDARD, STANDARD_PLAN],
            ['PREMIUM', SubscriptionPlanCode.PREMIUM, PREMIUM_PLAN],
        ] as const)(
            'rejects self-assigning the paid %s plan with ForbiddenException and does NOT persist',
            async (_label, code, planFixture) => {
                const { service, userRepository } = makeService({
                    findByCode: jest.fn().mockResolvedValue(planFixture),
                });
                await expect(
                    service.changePlanSelfService({ id: 'u1' } as any, code),
                ).rejects.toThrow(ForbiddenException);
                // No grant happened — the user stays on their current plan.
                expect(userRepository.update).not.toHaveBeenCalled();
            },
        );

        // Fail-closed: a malformed plan row (missing/null/NaN monthlyPrice) must
        // be treated as PAID and rejected, never silently self-grantable.
        it.each([
            ['undefined', undefined],
            ['null', null],
        ] as const)(
            'rejects a plan whose monthlyPrice is %s (fail-closed) and does NOT persist',
            async (_label, badPrice) => {
                const malformed = { ...FREE_PLAN, monthlyPrice: badPrice as any };
                const { service, userRepository } = makeService({
                    findByCode: jest.fn().mockResolvedValue(malformed),
                });
                await expect(
                    service.changePlanSelfService({ id: 'u1' } as any, SubscriptionPlanCode.FREE),
                ).rejects.toThrow(ForbiddenException);
                expect(userRepository.update).not.toHaveBeenCalled();
            },
        );

        it('still lets the PRIVILEGED assignPlanToUser grant a paid plan (billing/admin seam unchanged)', async () => {
            const user = { id: 'u1' } as any;
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(PREMIUM_PLAN),
            });
            const plan = await service.assignPlanToUser(user, SubscriptionPlanCode.PREMIUM);
            expect(plan).toBe(PREMIUM_PLAN);
            expect(userRepository.update).toHaveBeenCalledWith('u1', {
                defaultPlanId: PREMIUM_PLAN.id,
            });
        });

        // E2E/test escape hatch (config.subscriptions.allowSelfServePaidPlans):
        // SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID=true permits a paid self-assign so
        // the tier-gating / billing-grace e2e specs can reach STANDARD/PREMIUM
        // without a real billing integration. The beforeEach above resets
        // process.env every test (NODE_ENV stays jest's 'test', i.e. non-prod).
        it('e2e escape hatch: allows a paid self-assign when SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID=true (non-production)', async () => {
            process.env.SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID = 'true';
            const user = { id: 'u1' } as any;
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(PREMIUM_PLAN),
            });
            const plan = await service.changePlanSelfService(user, SubscriptionPlanCode.PREMIUM);
            expect(plan).toBe(PREMIUM_PLAN);
            expect(userRepository.update).toHaveBeenCalledWith('u1', {
                defaultPlanId: PREMIUM_PLAN.id,
            });
        });

        // Production hard-gate: even with the flag set, NODE_ENV=production
        // IGNORES it, so the EW-711 #23 free→paid escalation guard can never be
        // re-opened by an accidental prod env value.
        it('e2e escape hatch is HARD-GATED off in production (flag set but NODE_ENV=production → still rejected)', async () => {
            process.env.SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID = 'true';
            process.env.NODE_ENV = 'production';
            const { service, userRepository } = makeService({
                findByCode: jest.fn().mockResolvedValue(PREMIUM_PLAN),
            });
            await expect(
                service.changePlanSelfService({ id: 'u1' } as any, SubscriptionPlanCode.PREMIUM),
            ).rejects.toThrow(ForbiddenException);
            expect(userRepository.update).not.toHaveBeenCalled();
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
            expect(summary.allowances.map((a) => a.cadence)).toEqual(ALL_CADENCES_IN_PUBLIC_ORDER);
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

// H7: #2160 added three SELF-HOSTED editions to the seed. `listPlans()` returned
// `findAllActive()` unfiltered, so the hosted Billing page's plan switcher rendered six
// cards instead of three — including a "Community Edition" whose only possible outcome
// was an error, because `changePlanSelfService` (correctly) refuses self-hosted here.
// Found by an adversarial audit of the SHIPPED system, not by this suite.
describe('listPlans — the switcher only offers what this deployment can actually grant', () => {
    const cloudPlan = (code: string, name: string) =>
        ({ code, displayName: name, hosting: 'cloud' }) as any;
    const selfHostedPlan = (code: string, name: string) =>
        ({ code, displayName: name, hosting: 'selfhosted' }) as any;

    const ALL_SIX = [
        cloudPlan('free', 'Free'),
        cloudPlan('standard', 'Pro'),
        cloudPlan('premium', 'Enterprise'),
        selfHostedPlan('selfhosted_community', 'Community Edition'),
        selfHostedPlan('selfhosted_pro', 'Pro Edition'),
        selfHostedPlan('selfhosted_enterprise', 'Enterprise Edition'),
    ];

    it('excludes every self-hosted edition', async () => {
        const { service } = makeService({
            findAllActive: jest.fn().mockResolvedValue(ALL_SIX),
        });

        const plans = await service.listPlans();

        // Guard against a vacuous pass: the repository really did offer all six.
        expect(ALL_SIX).toHaveLength(6);
        expect(plans.map((p) => p.code)).toEqual(['free', 'standard', 'premium']);
        expect(plans.every((p) => p.hosting !== 'selfhosted')).toBe(true);
    });

    it('agrees with the self-hosted guard about what is selectable here', async () => {
        // The invariant is about HOSTING specifically: the switcher must not advertise a
        // plan the guard rejects for being self-hosted. (Self-service separately allows
        // only FREE — EW-711 #23 — which is why this asserts the hosting rule, not that
        // every offered plan is freely assignable.)
        const { service } = makeService({
            findAllActive: jest.fn().mockResolvedValue(ALL_SIX),
            findByCode: jest.fn(async (code: string) => ALL_SIX.find((p) => p.code === code)),
        });

        const offered = await service.listPlans();
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.every((p) => p.hosting === 'cloud')).toBe(true);

        // ...and the guard really does refuse the ones now withheld — so the two agree
        // rather than merely happening not to collide.
        for (const code of ['selfhosted_community', 'selfhosted_pro', 'selfhosted_enterprise']) {
            expect(offered.some((p) => p.code === code)).toBe(false);
            await expect(
                service.changePlanSelfService({ id: 'u1' } as any, code as any),
            ).rejects.toThrow();
        }
    });

    it('passes through when the catalog has no self-hosted rows at all', async () => {
        const cloudOnly = ALL_SIX.filter((p) => p.hosting === 'cloud');
        const { service } = makeService({
            findAllActive: jest.fn().mockResolvedValue(cloudOnly),
        });

        expect((await service.listPlans()).map((p) => p.code)).toEqual([
            'free',
            'standard',
            'premium',
        ]);
    });
});
