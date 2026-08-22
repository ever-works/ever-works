// THROWAWAY verifier spec — deleted after the run. Uses the REAL agent
// error classes (the shipped plan-checkout.controller.spec.ts substitutes
// Fake* classes, so it can never observe the real prototype chain).
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
    BillingProviderError,
    CheckoutSessionNotFoundError,
} from '@ever-works/agent/subscriptions';
import { StripeBillingProvider } from '@ever-works/agent/subscriptions';
import { mapPlanBillingError } from './plan-checkout.controller';

describe('return-route existence oracle', () => {
    it('CheckoutSessionNotFoundError is NOT a BillingProviderError', () => {
        const notFound = new CheckoutSessionNotFoundError();
        expect(notFound instanceof BillingProviderError).toBe(false);
        // control: it IS an Error, so the instanceof machinery works here
        expect(notFound instanceof Error).toBe(true);
    });

    it('foreign session -> 404, unreadable session -> 409', () => {
        const foreign = mapPlanBillingError(new CheckoutSessionNotFoundError());
        const unreadable = mapPlanBillingError(
            new BillingProviderError('Checkout session could not be read'),
        );
        expect(foreign).toBeInstanceOf(NotFoundException);
        expect((foreign as NotFoundException).getStatus()).toBe(404);
        expect(unreadable).toBeInstanceOf(ConflictException);
        expect((unreadable as ConflictException).getStatus()).toBe(409);
    });

    it('the REAL provider turns a nonexistent id into the 409 branch', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_not_a_real_key';
        const client: any = {
            checkout: {
                sessions: {
                    retrieve: jest.fn().mockRejectedValue(
                        Object.assign(new Error('No such checkout.session: cs_live_zzz'), {
                            code: 'resource_missing',
                            statusCode: 404,
                        }),
                    ),
                },
            },
        };
        const provider = new StripeBillingProvider(() => client);
        const err = await provider
            .retrieveCheckoutSession('cs_live_zzz')
            .then(() => null)
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BillingProviderError);
        expect(err).not.toBeInstanceOf(CheckoutSessionNotFoundError);
        const mapped = mapPlanBillingError(err);
        expect(mapped).toBeInstanceOf(ConflictException);
        expect((mapped as ConflictException).getStatus()).toBe(409);
        delete process.env.STRIPE_SECRET_KEY;
    });
});
