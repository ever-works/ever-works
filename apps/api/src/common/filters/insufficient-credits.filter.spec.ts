// Mock the agent subscriptions barrel so importing the filter doesn't pull
// the real credits runtime (TypeORM repositories / NestJS wiring / the
// whole billing money path). The filter only references
// `InsufficientCreditsError` for its `@Catch()` decorator and reads
// duck-typed fields off the thrown error, so a stand-in that reproduces
// the real constructor's shape (stable `name`, the three public fields and
// the interpolated message) is enough — and it is what lets us assert the
// no-leak contract against the exact payload the real class carries.
// Mirrors facade-exception.filter.spec.ts.
jest.mock('@ever-works/agent/subscriptions', () => ({
    InsufficientCreditsError: class InsufficientCreditsError extends Error {
        constructor(
            public readonly userId: string,
            public readonly requestedCredits: number,
            public readonly balanceCredits: number,
        ) {
            super(
                `Insufficient credits: balance ${balanceCredits}, requested debit ${requestedCredits}`,
            );
            this.name = 'InsufficientCreditsError';
        }
    },
}));

import { HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { InsufficientCreditsError } from '@ever-works/agent/subscriptions';
import {
    INSUFFICIENT_CREDITS_ERROR_CODE,
    INSUFFICIENT_CREDITS_MESSAGE,
    InsufficientCreditsExceptionFilter,
} from './insufficient-credits.filter';

/** The exact payload CreditLedgerService.record() throws on exhaustion. */
const SECRET_USER_ID = '11111111-2222-3333-4444-555555555555';

function exhausted(requested = 37, balance = 3) {
    return new InsufficientCreditsError(SECRET_USER_ID, requested, balance);
}

describe('InsufficientCreditsExceptionFilter', () => {
    let filter: InsufficientCreditsExceptionFilter;
    let reply: jest.Mock;
    let host: ArgumentsHost;

    beforeEach(() => {
        reply = jest.fn();
        const httpAdapterHost = {
            httpAdapter: {
                reply,
                getRequestMethod: () => 'POST',
                getRequestUrl: () => '/internal/trigger/remote/call',
            },
        } as unknown as HttpAdapterHost;
        filter = new InsufficientCreditsExceptionFilter(httpAdapterHost);

        host = {
            switchToHttp: () => ({
                getRequest: () => ({}),
                getResponse: () => ({ res: true }),
            }),
        } as unknown as ArgumentsHost;

        // Silence the error-level log the 500 fall-through emits.
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    const lastBody = () => reply.mock.calls[0][1];
    const lastStatus = () => reply.mock.calls[0][2];

    it('maps credit exhaustion to 402 Payment Required (never an unmapped 500)', () => {
        filter.catch(exhausted(), host);

        expect(lastStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
        expect(lastStatus()).toBe(402);
    });

    it('returns the stable, caller-facing body shape', () => {
        filter.catch(exhausted(), host);

        expect(lastBody()).toEqual({
            statusCode: 402,
            message: INSUFFICIENT_CREDITS_MESSAGE,
            error: INSUFFICIENT_CREDITS_ERROR_CODE,
        });
        // Pin the machine-readable code: clients branch on it, and it
        // matches the un-suffixed shape the sibling 402 (`BudgetExceeded`)
        // already uses.
        expect(INSUFFICIENT_CREDITS_ERROR_CODE).toBe('InsufficientCredits');
    });

    it('leaks NO internal detail — no userId, no balance, no raw message, no stack', () => {
        const exception = exhausted(37, 3);
        filter.catch(exception, host);

        const serialized = JSON.stringify(lastBody());

        // The owner's id is the sharpest leak: this filter also serves the
        // signature-authenticated worker RPC route, where the HTTP caller
        // is provably NOT the balance owner.
        expect(serialized).not.toContain(SECRET_USER_ID);
        // Balance / requested figures are account state — the owner reads
        // them from the owner-scoped GET /api/credits/balance instead.
        expect(serialized).not.toContain('37');
        expect(serialized).not.toContain('"balanceCredits"');
        expect(serialized).not.toContain('"requestedCredits"');
        // The error's own interpolated message must not be echoed.
        expect(serialized).not.toContain(exception.message);
        expect(serialized).not.toContain('requested debit');
        // No stack, and no extra keys beyond the pinned three.
        expect(serialized).not.toContain('at ');
        expect(Object.keys(lastBody()).sort()).toEqual(['error', 'message', 'statusCode']);
    });

    it('the constant body text names no identifier and no numeric state', () => {
        // Guards the message itself against a future edit that helpfully
        // interpolates the balance back in.
        expect(INSUFFICIENT_CREDITS_MESSAGE).not.toMatch(/\d/);
        expect(INSUFFICIENT_CREDITS_MESSAGE).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    });

    it('does NOT log the mapped 402 (it is expected and caller-actionable)', () => {
        const spy = jest.spyOn(Logger.prototype, 'error');
        filter.catch(exhausted(), host);
        expect(spy).not.toHaveBeenCalled();
    });

    it('falls through to a generic 500 for an unlisted subclass name', () => {
        // Conservative default, identical to FacadeExceptionFilter: an
        // error whose `.name` is not in the table is not silently promoted
        // to a 4xx, and its message is hidden.
        const rogue = exhausted();
        rogue.name = 'SomeBrandNewCreditsError';
        (rogue as Error).message = 'connection string postgres://user:pw@host/db';

        filter.catch(rogue, host);

        expect(lastStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(lastBody()).toEqual({
            statusCode: 500,
            message: 'Internal server error',
            error: 'Internal Server Error',
        });
        expect(JSON.stringify(lastBody())).not.toContain('postgres://');
    });

    it('logs the unmapped fall-through with request context (no message echo)', () => {
        const spy = jest.spyOn(Logger.prototype, 'error');
        const rogue = exhausted();
        rogue.name = 'SomeBrandNewCreditsError';
        (rogue as Error).message = 'leak me';

        filter.catch(rogue, host);

        expect(spy).toHaveBeenCalledTimes(1);
        const logged = String(spy.mock.calls[0][0]);
        expect(logged).toContain('SomeBrandNewCreditsError');
        expect(logged).toContain('/internal/trigger/remote/call');
        expect(logged).not.toContain('leak me');
    });
});
