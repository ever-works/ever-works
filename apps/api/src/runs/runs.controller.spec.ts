// Runs ledger (AW-09) — unit spec for `GET /api/runs`, `/stats`, `/calendar`.
//
// Focus: route declaration order (literal segments before `:runId`), the
// DTO bounds that keep a request inside the reachable window and page size,
// and scoping — every read keyed on the AUTHENTICATED user and the request
// scope, with no query field able to name anyone else.
//
// The agent barrel is stubbed so the spec never drags the entity graph in.
jest.mock('@ever-works/agent/agents', () => ({
    RunLedgerService: class RunLedgerService {},
    RunReceiptService: class RunReceiptService {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../scope', () => ({ ScopeContextService: class ScopeContextService {} }));

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ListRunsQueryDto, RunCalendarQueryDto, RunStatsQueryDto } from './dto/run-ledger.dto';
import { RunsController } from './runs.controller';

const AUTH = { userId: 'user-1' } as AuthenticatedUser;
const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };
const AGENT = '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f';

async function validateDto<T extends object>(
    Dto: new () => T,
    payload: Record<string, unknown>,
): Promise<{ properties: string[]; instance: T; errors: ValidationError[] }> {
    const instance = plainToInstance(Dto, payload);
    // Same options as the global ValidationPipe in main.ts.
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    return { properties: errors.map((error) => error.property), instance, errors };
}

describe('RunsController', () => {
    let ledger: { listRuns: jest.Mock; getStats: jest.Mock; getCalendar: jest.Mock };
    let receipts: { getReceipt: jest.Mock };
    let controller: RunsController;

    beforeEach(() => {
        ledger = {
            listRuns: jest.fn().mockResolvedValue({ rows: [] }),
            getStats: jest.fn().mockResolvedValue({ total: 0 }),
            getCalendar: jest.fn().mockResolvedValue({ days: [] }),
        };
        receipts = { getReceipt: jest.fn() };
        controller = new RunsController(
            ledger as never,
            receipts as never,
            {
                getScope: () => SCOPE,
            } as never,
        );
    });

    describe('route declaration', () => {
        const handlers = Object.getOwnPropertyNames(RunsController.prototype).filter(
            (name) => name !== 'constructor',
        );
        const path = (name: string) =>
            Reflect.getMetadata(
                PATH_METADATA,
                (RunsController.prototype as unknown as Record<string, object>)[name],
            ) as string;

        it('mounts under api/runs with every handler a GET', () => {
            expect(Reflect.getMetadata(PATH_METADATA, RunsController)).toBe('api/runs');
            for (const name of handlers) {
                expect(
                    Reflect.getMetadata(
                        METHOD_METADATA,
                        (RunsController.prototype as unknown as Record<string, object>)[name],
                    ),
                ).toBe(RequestMethod.GET);
            }
        });

        it('declares the literal stats and calendar segments before the :runId route', () => {
            const order = handlers.map(path);
            const receiptIndex = order.indexOf(':runId/receipt');
            expect(receiptIndex).toBeGreaterThan(-1);
            expect(order.indexOf('stats')).toBeLessThan(receiptIndex);
            expect(order.indexOf('calendar')).toBeLessThan(receiptIndex);
        });
    });

    describe('scoping', () => {
        it('keys the ledger page on the authenticated user and the request scope', async () => {
            await controller.list(AUTH, {
                granularity: 'week',
                date: '2026-09-08',
                timezone: 'Asia/Tokyo',
                agentId: [AGENT],
                kind: ['heartbeat'],
                status: ['failed'],
                q: 'deploy',
                limit: 25,
                cursor: `1789290000000_${AGENT}`,
            });

            expect(ledger.listRuns).toHaveBeenCalledWith(
                'user-1',
                {
                    granularity: 'week',
                    date: '2026-09-08',
                    timezone: 'Asia/Tokyo',
                    filters: {
                        agentIds: [AGENT],
                        triggerKinds: ['heartbeat'],
                        statuses: ['failed'],
                        workId: undefined,
                        missionId: undefined,
                        search: 'deploy',
                    },
                    limit: 25,
                    cursor: `1789290000000_${AGENT}`,
                },
                SCOPE,
            );
        });

        it('keys the stats and calendar on the authenticated user and the request scope', async () => {
            await controller.stats(AUTH, { granularity: 'month' });
            await controller.calendar(AUTH, { month: '2026-09', timezone: 'UTC' });

            expect(ledger.getStats.mock.calls[0][0]).toBe('user-1');
            expect(ledger.getStats.mock.calls[0][2]).toBe(SCOPE);
            expect(ledger.getCalendar).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ month: '2026-09', timezone: 'UTC' }),
                SCOPE,
            );
        });

        it('rejects any attempt to name a user, Organization or tenant in the query', async () => {
            for (const field of ['userId', 'organizationId', 'tenantId', 'ownerId']) {
                const { properties } = await validateDto(ListRunsQueryDto, { [field]: AGENT });
                expect(properties).toContain(field);
            }
        });
    });

    describe('ListRunsQueryDto', () => {
        it('accepts an empty query (Day / today / UTC / 50 rows are server defaults)', async () => {
            const { properties } = await validateDto(ListRunsQueryDto, {});
            expect(properties).toEqual([]);
        });

        it('caps the page size at 200 and rejects zero', async () => {
            expect((await validateDto(ListRunsQueryDto, { limit: '500' })).properties).toContain(
                'limit',
            );
            expect((await validateDto(ListRunsQueryDto, { limit: '0' })).properties).toContain(
                'limit',
            );
            const ok = await validateDto(ListRunsQueryDto, { limit: '200' });
            expect(ok.properties).toEqual([]);
            expect(ok.instance.limit).toBe(200);
        });

        it('rejects a one-character search and accepts two characters', async () => {
            expect((await validateDto(ListRunsQueryDto, { q: 'a' })).properties).toContain('q');
            expect((await validateDto(ListRunsQueryDto, { q: 'ab' })).properties).toEqual([]);
            expect(
                (await validateDto(ListRunsQueryDto, { q: 'x'.repeat(201) })).properties,
            ).toContain('q');
        });

        it('rejects an unknown timezone and accepts UTC and IANA zones', async () => {
            expect(
                (await validateDto(ListRunsQueryDto, { timezone: 'Mars/Olympus' })).properties,
            ).toContain('timezone');
            expect((await validateDto(ListRunsQueryDto, { timezone: 'UTC' })).properties).toEqual(
                [],
            );
            expect(
                (await validateDto(ListRunsQueryDto, { timezone: 'Asia/Tokyo' })).properties,
            ).toEqual([]);
        });

        it('rejects a granularity outside Day / Week / Month and a malformed date', async () => {
            expect(
                (await validateDto(ListRunsQueryDto, { granularity: 'year' })).properties,
            ).toContain('granularity');
            expect(
                (await validateDto(ListRunsQueryDto, { date: '8/9/2026' })).properties,
            ).toContain('date');
        });

        it('rejects a well-shaped date that is not a real calendar day', async () => {
            // Without this the resolver would read "no anchor" and answer
            // with today's runs, as though the request had been valid.
            for (const date of [
                '2026-02-31',
                '2026-02-29',
                '2026-13-01',
                '2026-04-31',
                '2026-09-00',
            ]) {
                const { properties, errors } = await validateDto(ListRunsQueryDto, { date });
                expect(properties).toContain('date');
                expect(
                    errors.find((error) => error.property === 'date')?.constraints,
                ).toHaveProperty('isCalendarDate');
            }
            for (const dto of [ListRunsQueryDto, RunStatsQueryDto]) {
                expect((await validateDto(dto, { date: '2026-02-31' })).properties).toContain(
                    'date',
                );
            }
            expect(
                (await validateDto(RunCalendarQueryDto, { month: '2026-02', date: '2026-02-30' }))
                    .properties,
            ).toContain('date');
            // Leap day in a leap year, and month ends, stay valid.
            for (const date of ['2028-02-29', '2026-01-31', '2026-04-30', '2026-12-31']) {
                expect((await validateDto(ListRunsQueryDto, { date })).properties).toEqual([]);
            }
        });

        it('normalises repeated and comma-separated multi-value filters', async () => {
            const repeated = await validateDto(ListRunsQueryDto, {
                status: ['failed', 'cancelled'],
                kind: 'heartbeat,chat',
            });
            expect(repeated.properties).toEqual([]);
            expect(repeated.instance.status).toEqual(['failed', 'cancelled']);
            expect(repeated.instance.kind).toEqual(['heartbeat', 'chat']);
        });

        it('rejects unknown statuses and trigger kinds inside a list', async () => {
            expect(
                (await validateDto(ListRunsQueryDto, { status: ['failed', 'exploded'] }))
                    .properties,
            ).toContain('status');
            expect((await validateDto(ListRunsQueryDto, { kind: 'cron' })).properties).toContain(
                'kind',
            );
        });

        it('rejects more than 20 agents and a non-uuid agent', async () => {
            const many = Array.from(
                { length: 21 },
                (_, i) => `0b7e7c1e-6f6a-4c55-9a4c-${String(i).padStart(12, '0')}`,
            );
            expect((await validateDto(ListRunsQueryDto, { agentId: many })).properties).toContain(
                'agentId',
            );
            expect(
                (await validateDto(ListRunsQueryDto, { agentId: 'not-a-uuid' })).properties,
            ).toContain('agentId');
        });

        it('rejects a malformed cursor', async () => {
            expect(
                (await validateDto(ListRunsQueryDto, { cursor: "1_'; DROP TABLE" })).properties,
            ).toContain('cursor');
            expect(
                (await validateDto(ListRunsQueryDto, { cursor: `1789290000000_${AGENT}` }))
                    .properties,
            ).toEqual([]);
        });
    });

    describe('RunStatsQueryDto / RunCalendarQueryDto', () => {
        it('does not accept paging fields on the stats query', async () => {
            const { properties } = await validateDto(RunStatsQueryDto, { limit: '10' });
            expect(properties).toContain('limit');
        });

        it('requires a real YYYY-MM month on the calendar query', async () => {
            expect((await validateDto(RunCalendarQueryDto, {})).properties).toContain('month');
            expect(
                (await validateDto(RunCalendarQueryDto, { month: '2026-13' })).properties,
            ).toContain('month');
            expect(
                (await validateDto(RunCalendarQueryDto, { month: '2026-09' })).properties,
            ).toEqual([]);
        });
    });
});
