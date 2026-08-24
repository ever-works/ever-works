/**
 * Seats API surface (billing spec §3.6 / FR-31).
 *
 * Boundary-only, like the sibling billing controller specs (the service has
 * its own spec in `packages/agent`): the owner is resolved from the
 * AUTHENTICATED user and never from the body, the DTO takes a TOTAL and
 * refuses anything price-shaped, and the domain errors map to 400/409/503
 * instead of an unmapped 500.
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
class FakeSeatsNotPurchasableError extends Error {
    constructor() {
        super('This account has no manageable subscription');
        this.name = 'SeatsNotPurchasableError';
    }
}
class FakeSeatsBelowUsageError extends Error {
    constructor() {
        super('Cannot set 4 seats: 9 are already in use.');
        this.name = 'SeatsBelowUsageError';
    }
}

jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingProviderNotConfiguredError: FakeBillingProviderNotConfiguredError,
    BillingProviderError: FakeBillingProviderError,
    SeatsNotPurchasableError: FakeSeatsNotPurchasableError,
    SeatsBelowUsageError: FakeSeatsBelowUsageError,
    SeatsService: class SeatsService {},
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
import { SeatsController } from './seats.controller';
import { UpdateSeatsDto } from './dto/seats.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = { userId: 'member-9' } as AuthenticatedUser;

const SEATS = {
    included: 10,
    purchased: 5,
    allowance: 15,
    members: 3,
    agents: 2,
    used: 5,
    available: 10,
    seatPriceCents: 500,
    purchasable: true,
};

function makeService(overrides: Record<string, jest.Mock> = {}) {
    return {
        resolveBillingOwner: jest.fn().mockResolvedValue('owner-1'),
        getSeats: jest.fn().mockResolvedValue(SEATS),
        setSeats: jest.fn().mockResolvedValue(SEATS),
        ...overrides,
    } as any;
}

describe('SeatsController', () => {
    it('GET resolves the billing OWNER from the authenticated user, never the caller directly', async () => {
        const service = makeService();
        const controller = new SeatsController(service);

        const result = await controller.getSeats(auth);

        expect(service.resolveBillingOwner).toHaveBeenCalledWith('member-9');
        // The seat read is for the OWNER the actor bills to, not the actor.
        expect(service.getSeats).toHaveBeenCalledWith('owner-1');
        expect(result).toMatchObject({ status: 'success', allowance: 15, used: 5 });
    });

    it('POST sets the TOTAL for the resolved owner', async () => {
        const service = makeService();
        const controller = new SeatsController(service);

        await controller.setSeats(auth, { seats: 20 });

        expect(service.setSeats).toHaveBeenCalledWith('owner-1', 20);
    });

    it('maps the domain errors: 400 below usage, 409 not purchasable / refused, 503 unconfigured', async () => {
        const cases: Array<[Error, unknown]> = [
            [new FakeSeatsBelowUsageError(), BadRequestException],
            [new FakeSeatsNotPurchasableError(), ConflictException],
            [new FakeBillingProviderError(), ConflictException],
            [new FakeBillingProviderNotConfiguredError(), ServiceUnavailableException],
        ];
        for (const [error, expected] of cases) {
            const service = makeService({ setSeats: jest.fn().mockRejectedValue(error) });
            const controller = new SeatsController(service);
            await expect(controller.setSeats(auth, { seats: 12 })).rejects.toBeInstanceOf(
                expected as any,
            );
        }
    });

    describe('UpdateSeatsDto', () => {
        it('accepts a whole non-negative total', async () => {
            for (const seats of [0, 1, 10, 250]) {
                const dto = plainToInstance(UpdateSeatsDto, { seats });
                expect(
                    await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
                ).toEqual([]);
            }
        });

        it('rejects fractions, negatives, absurd totals and any price-shaped field', async () => {
            for (const body of [
                { seats: -1 },
                { seats: 1.5 },
                { seats: 99_999_999 },
                {},
                { seats: 12, seatPriceCents: 1 },
                { seats: 12, priceCents: 1 },
            ]) {
                const dto = plainToInstance(UpdateSeatsDto, body);
                const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
                expect(errors.length).toBeGreaterThan(0);
            }
        });
    });
});
