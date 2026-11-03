// Costs dashboard — unit spec for `GET /api/usage/costs/*`.
//
// Focus: owner-scoping (every service call keyed on the AUTHENTICATED
// user, never a caller-supplied id), the DTO allow-list that keeps the
// window vocabulary closed, and the 4xx mapping for the service's
// stable-named error.
//
// Mirrors credits.controller.spec.ts: the agent barrels are stubbed so
// the spec never drags in @ever-works/agent/database.
jest.mock('@ever-works/agent/subscriptions', () => ({
    InvalidCostsWindowError: class InvalidCostsWindowError extends Error {
        constructor(windowDays: unknown) {
            super(`Invalid windowDays (expected one of 7, 30, 90): ${windowDays}`);
            this.name = 'InvalidCostsWindowError';
        }
    },
    COSTS_WINDOW_DAYS: [7, 30, 90],
    COSTS_TOP_RUNS_MAX_LIMIT: 50,
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InvalidCostsWindowError } from '@ever-works/agent/subscriptions';
import type { CostsSummaryService } from '@ever-works/agent/subscriptions';
import { CostsController, CostsTopRunsQueryDto, CostsWindowQueryDto } from './costs.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const AUTH = { userId: 'user-1' } as AuthenticatedUser;
const OTHER = { userId: 'user-2' } as AuthenticatedUser;

function makeService(): jest.Mocked<CostsSummaryService> {
    return {
        getSummary: jest
            .fn()
            .mockResolvedValue({ windowDays: 30, from: 'F', to: 'T', totalCostCents: 0 }),
        getDaily: jest
            .fn()
            .mockResolvedValue({ windowDays: 30, from: 'F', to: 'T', series: [], days: [] }),
        getByAgent: jest.fn().mockResolvedValue({ windowDays: 30, from: 'F', to: 'T', rows: [] }),
        getByModel: jest
            .fn()
            .mockResolvedValue({ windowDays: 30, from: 'F', to: 'T', totalCostCents: 0, rows: [] }),
        getTopRuns: jest.fn().mockResolvedValue({ windowDays: 30, from: 'F', to: 'T', rows: [] }),
    } as unknown as jest.Mocked<CostsSummaryService>;
}

async function validateDto<T extends object>(
    Dto: new () => T,
    payload: Record<string, unknown>,
): Promise<string[]> {
    const instance = plainToInstance(Dto, payload, { enableImplicitConversion: false });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    return errors.map((error) => error.property);
}

describe('CostsController', () => {
    let service: jest.Mocked<CostsSummaryService>;
    let controller: CostsController;

    beforeEach(() => {
        service = makeService();
        controller = new CostsController(service);
    });

    describe('owner scoping', () => {
        it('keys every endpoint on the authenticated user', async () => {
            await controller.summary(AUTH, { windowDays: 7 });
            await controller.daily(AUTH, { windowDays: 7 });
            await controller.byAgent(AUTH, { windowDays: 7 });
            await controller.byModel(AUTH, { windowDays: 7 });
            await controller.topRuns(AUTH, { windowDays: 7 });

            expect(service.getSummary).toHaveBeenCalledWith('user-1', 7);
            expect(service.getDaily).toHaveBeenCalledWith('user-1', 7);
            expect(service.getByAgent).toHaveBeenCalledWith('user-1', 7);
            expect(service.getByModel).toHaveBeenCalledWith('user-1', 7);
            expect(service.getTopRuns).toHaveBeenCalledWith('user-1', 7, undefined);
        });

        it('cannot be pointed at another account — the id comes only from the token', async () => {
            await controller.summary(OTHER, {});

            expect(service.getSummary).toHaveBeenCalledWith('user-2', undefined);
        });
    });

    describe('response shape', () => {
        it('wraps the service payload with the house `status` envelope', async () => {
            service.getSummary.mockResolvedValue({
                windowDays: 30,
                from: 'F',
                to: 'T',
                totalCostCents: 1200,
                runsCount: 4,
                avgPerRunCents: 300,
            } as never);

            await expect(controller.summary(AUTH, {})).resolves.toEqual({
                status: 'success',
                windowDays: 30,
                from: 'F',
                to: 'T',
                totalCostCents: 1200,
                runsCount: 4,
                avgPerRunCents: 300,
            });
        });

        it('forwards the top-runs limit through to the service', async () => {
            await controller.topRuns(AUTH, { windowDays: 90, limit: 5 });

            expect(service.getTopRuns).toHaveBeenCalledWith('user-1', 90, 5);
        });
    });

    describe('error mapping', () => {
        it('maps InvalidCostsWindowError to 400, never an unmapped 500', async () => {
            service.getDaily.mockRejectedValue(new InvalidCostsWindowError(45));

            await expect(controller.daily(AUTH, { windowDays: 45 })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('lets an unexpected failure surface for the global filters', async () => {
            const boom = new Error('database exploded');
            service.getByModel.mockRejectedValue(boom);

            await expect(controller.byModel(AUTH, {})).rejects.toBe(boom);
        });
    });

    describe('CostsWindowQueryDto', () => {
        it('accepts the 7/30/90 vocabulary as query strings', async () => {
            for (const windowDays of ['7', '30', '90']) {
                await expect(validateDto(CostsWindowQueryDto, { windowDays })).resolves.toEqual([]);
            }
        });

        it('coerces the query string to a number before the allow-list check', async () => {
            const dto = plainToInstance(CostsWindowQueryDto, { windowDays: '90' });
            expect(dto.windowDays).toBe(90);
        });

        it('rejects any window outside the vocabulary', async () => {
            for (const windowDays of ['1', '14', '31', '365', '-7', 'all', '7.5']) {
                await expect(validateDto(CostsWindowQueryDto, { windowDays })).resolves.toEqual([
                    'windowDays',
                ]);
            }
        });

        it('treats an omitted window as valid (the service picks the default)', async () => {
            await expect(validateDto(CostsWindowQueryDto, {})).resolves.toEqual([]);
        });

        it('rejects unknown fields — forbidNonWhitelisted is on globally', async () => {
            await expect(
                validateDto(CostsWindowQueryDto, { windowDays: '7', userId: 'someone-else' }),
            ).resolves.toEqual(['userId']);
        });
    });

    describe('CostsTopRunsQueryDto', () => {
        it('inherits the window rules and adds a bounded limit', async () => {
            await expect(
                validateDto(CostsTopRunsQueryDto, { windowDays: '30', limit: '20' }),
            ).resolves.toEqual([]);
            await expect(validateDto(CostsTopRunsQueryDto, { limit: '0' })).resolves.toEqual([
                'limit',
            ]);
            await expect(validateDto(CostsTopRunsQueryDto, { limit: '51' })).resolves.toEqual([
                'limit',
            ]);
            await expect(validateDto(CostsTopRunsQueryDto, { windowDays: '5' })).resolves.toEqual([
                'windowDays',
            ]);
        });
    });
});
