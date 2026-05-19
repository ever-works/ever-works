jest.mock('@ever-works/agent/subscriptions', () => ({}));
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
import type { SubscriptionService } from '@ever-works/agent/subscriptions';
import type { AuthService } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('SubscriptionsController', () => {
    let subscriptionService: jest.Mocked<
        Pick<SubscriptionService, 'summarizePlan' | 'isEnabled' | 'assignPlanToUser'>
    >;
    let authService: jest.Mocked<Pick<AuthService, 'getUser'>>;
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
            assignPlanToUser: jest.fn(),
        } as any;
        authService = {
            getUser: jest.fn().mockResolvedValue(user),
        } as any;
        controller = new SubscriptionsController(
            subscriptionService as unknown as SubscriptionService,
            authService as unknown as AuthService,
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

    describe('updatePlan', () => {
        it('throws BadRequestException when subscriptions are disabled (and never calls getUser/assignPlanToUser)', async () => {
            subscriptionService.isEnabled.mockReturnValue(false);

            await expect(
                controller.updatePlan(auth, { planCode: 'pro' as any }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(controller.updatePlan(auth, { planCode: 'pro' as any })).rejects.toThrow(
                'Subscriptions are disabled',
            );
            expect(authService.getUser).not.toHaveBeenCalled();
            expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
        });

        it('assigns plan and returns mapped envelope when enabled', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.assignPlanToUser.mockResolvedValue({
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
            expect(subscriptionService.assignPlanToUser).toHaveBeenCalledWith(user, 'starter');
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

        it('uses the assignPlanToUser response (not summarizePlan) for code/name', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.assignPlanToUser.mockResolvedValue({
                code: 'pro',
                displayName: 'Pro Plan',
            } as any);
            subscriptionService.summarizePlan.mockResolvedValue({
                enabled: true,
                // a different plan in the summary — controller must trust assignPlanToUser
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

        it('propagates assignPlanToUser errors', async () => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.assignPlanToUser.mockRejectedValue(new Error('plan not found'));

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
            expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
        });
    });
});
