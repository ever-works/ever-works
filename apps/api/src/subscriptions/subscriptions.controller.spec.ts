jest.mock('@ever-works/agent/subscriptions', () => ({
    // Wave 13 — the controller value-imports ENTITLEMENT_KEYS for the
    // plans endpoint's daily-free-credits lookup.
    ENTITLEMENT_KEYS: {
        DAILY_FREE_CREDITS: 'daily-free-credits',
        MAX_CONCURRENT_RUNS: 'max-concurrent-runs',
        WORKS_LIMIT: 'works-limit',
    },
}));
jest.mock('@ever-works/agent/entities', () => ({
    SubscriptionPlanCode: {
        FREE: 'free',
        STARTER: 'starter',
        PRO: 'pro',
        ENTERPRISE: 'enterprise',
    },
}));
// Stub the auth barrel — we never exercise the guard / decorator at the
// unit-test layer (the controller is constructed manually below) and we want
// to avoid pulling in @ever-works/agent/database transitively.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    AuthService: class AuthService {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import type {
    EntitlementsService,
    PlanSubscriptionService,
    SubscriptionService,
} from '@ever-works/agent/subscriptions';
import type { AuthService } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('SubscriptionsController', () => {
    let subscriptionService: jest.Mocked<
        Pick<
            SubscriptionService,
            | 'summarizePlan'
            | 'isEnabled'
            | 'changePlanSelfService'
            | 'listPlans'
            | 'listSelfHostedPlans'
        >
    >;
    let authService: jest.Mocked<Pick<AuthService, 'getUser'>>;
    let entitlementsService: jest.Mocked<Pick<EntitlementsService, 'getNumber'>>;
    let planSubscriptionService: jest.Mocked<
        Pick<PlanSubscriptionService, 'listOwnedLicenceCodes'>
    >;
    let controller: SubscriptionsController;

    const auth: AuthenticatedUser = {
        userId: 'user-1',
        email: 'u@e.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    };

    const user = { id: 'user-1', email: 'u@e.test' } as any;

    beforeEach(() => {
        subscriptionService = {
            summarizePlan: jest.fn(),
            isEnabled: jest.fn(),
            changePlanSelfService: jest.fn(),
            listPlans: jest.fn(),
            listSelfHostedPlans: jest.fn(),
        } as any;
        authService = {
            getUser: jest.fn().mockResolvedValue(user),
        } as any;
        entitlementsService = {
            getNumber: jest.fn().mockResolvedValue(0),
        } as any;
        planSubscriptionService = {
            listOwnedLicenceCodes: jest.fn().mockResolvedValue([]),
        } as any;
        controller = new SubscriptionsController(
            subscriptionService as unknown as SubscriptionService,
            authService as unknown as AuthService,
            entitlementsService as unknown as EntitlementsService,
            planSubscriptionService as unknown as PlanSubscriptionService,
        );
    });

    describe('getPlan', () => {
        it('returns enabled=false envelope with the free plan as fallback when disabled', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: false,
                plan: null,
                allowances: [],
            } as any);

            const result = await controller.getPlan(auth);

            expect(authService.getUser).toHaveBeenCalledWith('user-1');
            expect(subscriptionService.summarizePlan).toHaveBeenCalledWith(user);
            // Disabled module returns plan: { code: 'free' } instead of null
            // so the web client (and the e2e tier-gating contract) can read
            // `plan.code` without special-casing the disabled state.
            expect(result).toEqual({
                status: 'success',
                enabled: false,
                plan: { code: 'free', name: 'Free' },
            });
        });

        it('returns plan envelope mapping code/displayName/allowances when enabled', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                plan: { code: 'pro', displayName: 'Pro' },
                allowances: ['daily', 'weekly'],
            } as any);

            const result = await controller.getPlan(auth);

            expect(result).toEqual({
                status: 'success',
                enabled: true,
                plan: {
                    code: 'pro',
                    name: 'Pro',
                    allowedCadences: ['daily', 'weekly'],
                },
            });
        });

        it('propagates AuthService errors (user not found)', async () => {
            authService.getUser.mockRejectedValue(new Error('User not found'));

            await expect(controller.getPlan(auth)).rejects.toThrow('User not found');
            expect(subscriptionService.summarizePlan).not.toHaveBeenCalled();
        });

        it('propagates SubscriptionService.summarizePlan errors', async () => {
            subscriptionService.summarizePlan.mockRejectedValue(new Error('boom'));

            await expect(controller.getPlan(auth)).rejects.toThrow('boom');
        });
    });

    describe('listPlans (Wave 13 — Billing page plan switcher)', () => {
        beforeEach(() => {
            // Most cases care only about the hosted switcher; the licence list
            // is asserted separately below.
            subscriptionService.listSelfHostedPlans.mockResolvedValue([]);
        });

        const seededPlans = [
            {
                code: 'free',
                displayName: 'Free',
                maxWorks: 1,
                allowedCadences: ['monthly'],
                monthlyPrice: '0',
                overagePricePerRun: '10',
                currency: 'usd',
            },
            {
                code: 'premium',
                displayName: 'Premium',
                maxWorks: 15,
                allowedCadences: ['monthly', 'weekly'],
                monthlyPrice: '99',
                overagePricePerRun: '0',
                currency: 'usd',
            },
        ] as any[];

        it('marks the current plan and maps the credits-forward projection when enabled', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                plan: { code: 'premium', displayName: 'Premium' },
                allowances: [],
            } as any);
            subscriptionService.listPlans.mockResolvedValue(seededPlans);
            entitlementsService.getNumber.mockResolvedValue(50);

            const result = await controller.listPlans(auth);

            expect(authService.getUser).toHaveBeenCalledWith('user-1');
            expect(result.status).toBe('success');
            expect(result.enabled).toBe(true);
            expect(result.currentPlanCode).toBe('premium');
            expect(result.plans).toHaveLength(2);
            expect(result.plans[0]).toEqual({
                code: 'free',
                name: 'Free',
                hosting: undefined,
                maxWorks: 1,
                allowedCadences: ['monthly'],
                monthlyPrice: '0',
                annualPrice: undefined,
                lifetimePrice: undefined,
                seatsIncluded: undefined,
                seatMonthlyPrice: undefined,
                monthlyCredits: undefined,
                overagePricePerRun: '10',
                currency: 'usd',
                isCurrent: false,
                dailyFreeCredits: 50,
            });
            expect(result.plans[1].isCurrent).toBe(true);
        });

        /**
         * H1 — self-hosted editions ship in their OWN array.
         *
         * They are purchasable (the $99 perpetual licence is the only lifetime
         * SKU in the catalog) but never self-assignable: `changePlanSelfService`
         * refuses them, so a card in the switcher would be a button whose only
         * possible outcome is a 403. The switcher must keep exactly the plans a
         * user can switch between.
         */
        it('returns self-hosted editions separately from the switchable plans', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                plan: { code: 'free', displayName: 'Free' },
                allowances: [],
            } as any);
            subscriptionService.listPlans.mockResolvedValue(seededPlans);
            subscriptionService.listSelfHostedPlans.mockResolvedValue([
                {
                    code: 'selfhosted_pro',
                    displayName: 'Pro Edition',
                    hosting: 'selfhosted',
                    maxWorks: 5,
                    allowedCadences: ['monthly'],
                    monthlyPrice: '49',
                    annualPrice: '408',
                    lifetimePrice: '99',
                    seatsIncluded: 10,
                    seatMonthlyPrice: '5',
                    monthlyCredits: 3000,
                    overagePricePerRun: '0',
                    currency: 'usd',
                },
            ] as any[]);
            entitlementsService.getNumber.mockResolvedValue(50);

            const result = await controller.listPlans(auth);

            // The switcher is untouched — no self-hosted card leaks into it.
            expect(result.plans.map((plan) => plan.code)).toEqual(['free', 'premium']);
            expect(result.licences).toHaveLength(1);
            expect(result.licences[0].code).toBe('selfhosted_pro');
            expect(result.licences[0].lifetimePrice).toBe('99');
            // A licence never becomes "your current plan" on this deployment.
            expect(result.licences[0].isCurrent).toBe(false);
            expect(result.licences[0].owned).toBe(false);
        });

        it('marks a durable self-hosted licence as owned for this user', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                plan: { code: 'free', displayName: 'Free' },
                allowances: [],
            } as any);
            subscriptionService.listPlans.mockResolvedValue(seededPlans);
            subscriptionService.listSelfHostedPlans.mockResolvedValue([
                {
                    code: 'selfhosted_pro',
                    displayName: 'Pro Edition',
                    hosting: 'selfhosted',
                    monthlyPrice: '49',
                    lifetimePrice: '99',
                    currency: 'usd',
                },
            ] as any[]);
            planSubscriptionService.listOwnedLicenceCodes.mockResolvedValue(['selfhosted_pro']);

            const result = await controller.listPlans(auth);

            expect(planSubscriptionService.listOwnedLicenceCodes).toHaveBeenCalledWith('user-1');
            expect(result.licences[0].owned).toBe(true);
        });

        it('falls back to free as the current plan when subscriptions are disabled', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: false,
                plan: null,
                allowances: [],
            } as any);
            subscriptionService.listPlans.mockResolvedValue(seededPlans);

            const result = await controller.listPlans(auth);

            expect(result.enabled).toBe(false);
            expect(result.currentPlanCode).toBe('free');
            expect(result.plans[0].isCurrent).toBe(true);
            expect(result.plans[1].isCurrent).toBe(false);
        });

        it('reads the daily-free-credits entitlement per plan code (fallback 0)', async () => {
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                plan: { code: 'free', displayName: 'Free' },
                allowances: [],
            } as any);
            subscriptionService.listPlans.mockResolvedValue(seededPlans);

            await controller.listPlans(auth);

            expect(entitlementsService.getNumber).toHaveBeenCalledWith(
                'free',
                'daily-free-credits',
                0,
            );
            expect(entitlementsService.getNumber).toHaveBeenCalledWith(
                'premium',
                'daily-free-credits',
                0,
            );
        });
    });

    describe('updatePlan', () => {
        it('throws BadRequestException when subscriptions are disabled (and never calls getUser/changePlanSelfService)', async () => {
            subscriptionService.isEnabled.mockReturnValue(false);

            await expect(
                controller.updatePlan(auth, { planCode: 'pro' as any }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(controller.updatePlan(auth, { planCode: 'pro' as any })).rejects.toThrow(
                'Subscriptions are disabled',
            );
            expect(authService.getUser).not.toHaveBeenCalled();
            expect(subscriptionService.changePlanSelfService).not.toHaveBeenCalled();
        });

        it('assigns plan and returns mapped envelope when enabled', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.changePlanSelfService.mockResolvedValue({
                code: 'starter',
                displayName: 'Starter',
            } as any);
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                plan: { code: 'starter', displayName: 'Starter' },
                allowances: ['daily'],
            } as any);

            const result = await controller.updatePlan(auth, { planCode: 'starter' as any });

            expect(authService.getUser).toHaveBeenCalledWith('user-1');
            expect(subscriptionService.changePlanSelfService).toHaveBeenCalledWith(user, 'starter');
            expect(subscriptionService.summarizePlan).toHaveBeenCalledWith(user);
            expect(result).toEqual({
                status: 'success',
                enabled: true,
                plan: {
                    code: 'starter',
                    name: 'Starter',
                    allowedCadences: ['daily'],
                },
            });
        });

        it('uses the changePlanSelfService response (not summarizePlan) for code/name', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.changePlanSelfService.mockResolvedValue({
                code: 'pro',
                displayName: 'Pro Plan',
            } as any);
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                // a different plan in the summary — controller must trust changePlanSelfService
                plan: { code: 'free', displayName: 'Free' },
                allowances: ['weekly'],
            } as any);

            const result = await controller.updatePlan(auth, { planCode: 'pro' as any });

            expect(result.plan).toEqual({
                code: 'pro',
                name: 'Pro Plan',
                allowedCadences: ['weekly'],
            });
        });

        it('propagates changePlanSelfService errors', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.changePlanSelfService.mockRejectedValue(
                new Error('plan not found'),
            );

            await expect(
                controller.updatePlan(auth, { planCode: 'unknown' as any }),
            ).rejects.toThrow('plan not found');
            expect(subscriptionService.summarizePlan).not.toHaveBeenCalled();
        });

        it('propagates AuthService errors (user resolution before assignment)', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            authService.getUser.mockRejectedValue(new Error('User not found'));

            await expect(controller.updatePlan(auth, { planCode: 'pro' as any })).rejects.toThrow(
                'User not found',
            );
            expect(subscriptionService.changePlanSelfService).not.toHaveBeenCalled();
        });
    });
});
