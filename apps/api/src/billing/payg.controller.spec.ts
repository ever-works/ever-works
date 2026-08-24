/**
 * Pay-as-you-go API surface (billing spec §3.5 / FR-31).
 *
 * Same harness as the sibling billing controller specs: the agent
 * package is mocked wholesale (the service logic has its own spec in
 * `packages/agent`), so what is pinned HERE is the boundary — the DTO
 * contract (no amount-shaped fields ever accepted), the routing of the
 * three intents (enable / disable / re-cap), and the domain-error → HTTP
 * mapping (409 no card, 400 bad cap, 503 no provider; never an unmapped
 * 500).
 */
class FakeBillingProviderNotConfiguredError extends Error {
    constructor() {
        super('Payment provider is not configured on this deployment');
        this.name = 'BillingProviderNotConfiguredError';
    }
}
class FakeBillingProviderError extends Error {
    constructor(message = 'provider refused') {
        super(message);
        this.name = 'BillingProviderError';
    }
}
class FakePaygPaymentMethodRequiredError extends Error {
    constructor() {
        super('Add a payment method before enabling pay-as-you-go');
        this.name = 'PaygPaymentMethodRequiredError';
    }
}
class FakePaygCapOutOfRangeError extends Error {
    constructor() {
        super('Monthly cap must be between 500 and 100000 credits (got 1)');
        this.name = 'PaygCapOutOfRangeError';
    }
}

jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingProviderNotConfiguredError: FakeBillingProviderNotConfiguredError,
    BillingProviderError: FakeBillingProviderError,
    PaygPaymentMethodRequiredError: FakePaygPaymentMethodRequiredError,
    PaygCapOutOfRangeError: FakePaygCapOutOfRangeError,
    PaygService: class PaygService {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaygController } from './payg.controller';
import { UpdatePaygDto } from './dto/payg.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = { userId: 'user-1' } as AuthenticatedUser;

const STATE = {
    available: true,
    enabled: true,
    subscriptionStatus: 'active',
    pastDue: false,
    monthlyCapCredits: 10000,
    defaultMonthlyCapCredits: 10000,
    maxMonthlyCapCredits: 100000,
    minMonthlyCapCredits: 500,
    cycleUsedCredits: 380,
    cycleEstimateCents: 380,
    periodStart: null,
    periodEnd: null,
    tiers: [{ upTo: 5000, centsPerCredit: '1' }],
    invoiceThresholdCents: 5000,
};

function makeService(overrides: Record<string, jest.Mock> = {}) {
    return {
        getState: jest.fn().mockResolvedValue(STATE),
        enable: jest.fn().mockResolvedValue(STATE),
        updateCap: jest.fn().mockResolvedValue(STATE),
        disable: jest.fn().mockResolvedValue({ ...STATE, enabled: false }),
        ...overrides,
    } as any;
}

describe('PaygController', () => {
    it('GET returns the owner-scoped state under the success envelope', async () => {
        const service = makeService();
        const controller = new PaygController(service);

        const result = await controller.getState(auth);

        expect(service.getState).toHaveBeenCalledWith('user-1');
        expect(result).toMatchObject({ status: 'success', enabled: true, cycleUsedCredits: 380 });
    });

    it('PUT {enabled:true} enables with the optional cap; {enabled:false} disables; cap-only re-caps', async () => {
        const service = makeService();
        const controller = new PaygController(service);

        await controller.update(auth, { enabled: true, monthlyCapCredits: 2500 });
        expect(service.enable).toHaveBeenCalledWith('user-1', { monthlyCapCredits: 2500 });

        await controller.update(auth, { enabled: false });
        expect(service.disable).toHaveBeenCalledWith('user-1');

        await controller.update(auth, { monthlyCapCredits: 7000 });
        expect(service.updateCap).toHaveBeenCalledWith('user-1', 7000);
    });

    it('rejects an empty PUT instead of treating an omitted intent as disable', async () => {
        const service = makeService();
        const controller = new PaygController(service);

        await expect(controller.update(auth, {})).rejects.toBeInstanceOf(BadRequestException);
        expect(service.disable).not.toHaveBeenCalled();
    });

    it('rejects a disable request that also carries a cap instead of silently ignoring it', async () => {
        const service = makeService();
        const controller = new PaygController(service);

        await expect(
            controller.update(auth, { enabled: false, monthlyCapCredits: 2500 }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(service.disable).not.toHaveBeenCalled();
        expect(service.updateCap).not.toHaveBeenCalled();
    });

    it('maps the domain errors: 409 no card / provider refusal, 400 bad cap, 503 unconfigured', async () => {
        const cases: Array<[Error, unknown]> = [
            [new FakePaygPaymentMethodRequiredError(), ConflictException],
            [new FakeBillingProviderError(), ConflictException],
            [new FakePaygCapOutOfRangeError(), BadRequestException],
            [new FakeBillingProviderNotConfiguredError(), ServiceUnavailableException],
        ];
        for (const [error, expected] of cases) {
            const service = makeService({ enable: jest.fn().mockRejectedValue(error) });
            const controller = new PaygController(service);
            await expect(controller.update(auth, { enabled: true })).rejects.toBeInstanceOf(
                expected as any,
            );
        }
    });

    describe('UpdatePaygDto — no amount-shaped field ever crosses the wire', () => {
        it('accepts the three legitimate shapes', async () => {
            for (const body of [
                { enabled: true },
                { enabled: false },
                { enabled: true, monthlyCapCredits: 10000 },
                { monthlyCapCredits: 5000 },
            ]) {
                const dto = plainToInstance(UpdatePaygDto, body);
                expect(
                    await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
                ).toEqual([]);
            }
        });

        it('rejects price/rate-shaped fields and nonsense caps', async () => {
            const smuggled = plainToInstance(UpdatePaygDto, {
                enabled: true,
                centsPerCredit: '0.0001',
            });
            const smuggledErrors = await validate(smuggled, {
                whitelist: true,
                forbidNonWhitelisted: true,
            });
            expect(smuggledErrors.length).toBeGreaterThan(0);

            for (const bad of [
                { monthlyCapCredits: 0 },
                { monthlyCapCredits: -5 },
                { monthlyCapCredits: 1.5 },
                { monthlyCapCredits: 999_999_999 },
                { enabled: 'yes' },
            ]) {
                const dto = plainToInstance(UpdatePaygDto, bad);
                const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
                expect(errors.length).toBeGreaterThan(0);
            }
        });
    });
});
