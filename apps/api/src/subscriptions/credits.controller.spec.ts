// Wave 13 (Billing / Usage & Credits pages) — unit spec for the
// read-only credits surface, focused on the new `usage-summary`
// endpoint: owner-scoping (every service call keyed on the AUTHENTICATED
// user, never caller-supplied), groupBy dispatch, and the 4xx mapping.
//
// Mirrors subscriptions.controller.spec.ts: the agent barrels are
// stubbed so the spec never drags in @ever-works/agent/database.
jest.mock('@ever-works/agent/subscriptions', () => ({
    InvalidUsagePeriodError: class InvalidUsagePeriodError extends Error {
        constructor(period: string) {
            super(`Invalid period (expected YYYY-MM, 7d, or 30d): ${period}`);
            this.name = 'InvalidUsagePeriodError';
        }
    },
    USAGE_SUMMARY_GROUP_BYS: ['day', 'model', 'agent', 'work'],
    // Billing spec FR-13 — `GET /api/credits/pricing` is a pure projection
    // of this view; the controller adds only the `status` envelope.
    creditsPricingView: jest.fn(() => ({
        creditsPerDollar: 100,
        marginPercent: 35,
        dailyFreeCredits: 50,
        packs: [
            {
                id: 'credits-1000',
                priceCents: 1000,
                credits: 1000,
                currency: 'usd',
                label: '1,000 credits',
            },
        ],
        payg: {
            tiers: [
                { upTo: 5000, centsPerCredit: '1' },
                { upTo: null, centsPerCredit: '0.8' },
            ],
            invoiceThresholdCents: 5000,
            defaultMonthlyCapCredits: 10000,
            maxMonthlyCapCredits: 100000,
        },
    })),
    USAGE_EXPORT_COLUMNS: [
        'occurredAt',
        'pluginId',
        'capability',
        'units',
        'costCents',
        'currency',
        'modelId',
        'workId',
        'agentId',
        'taskId',
        'runId',
        'requestId',
    ],
}));
jest.mock('@ever-works/agent/entities', () => ({
    CreditLedgerKind: {
        PURCHASE: 'purchase',
        GRANT: 'grant',
        DAILY_FREE: 'daily-free',
        CONSUMPTION: 'consumption',
        ADJUSTMENT: 'adjustment',
        EXPIRY: 'expiry',
    },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InvalidUsagePeriodError } from '@ever-works/agent/subscriptions';
import type { CreditLedgerService, UsageSummaryService } from '@ever-works/agent/subscriptions';
import type { ScopeContextService } from '../scope';
import {
    CreditsController,
    CreditsUsageExportQueryDto,
    CreditsUsageSummaryQueryDto,
} from './credits.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/** Collects everything the controller streams onto the response. */
function makeCsvResponse() {
    const headers: Record<string, string> = {};
    const written: string[] = [];
    let ended = false;
    return {
        headers,
        written,
        get body() {
            return written.join('');
        },
        get ended() {
            return ended;
        },
        setHeader(name: string, value: string) {
            headers[name] = value;
        },
        write(chunk: string) {
            written.push(chunk);
            return true;
        },
        end() {
            ended = true;
            return true;
        },
    };
}

/** Wraps pre-built pages in the lazy async-iterable shape the service returns. */
function chunksOf(pages: Record<string, unknown>[][]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const page of pages) {
                yield page as never;
            }
        },
    };
}

describe('CreditsController', () => {
    let creditLedgerService: jest.Mocked<Pick<CreditLedgerService, 'getBalance' | 'getLedger'>>;
    let usageSummaryService: jest.Mocked<
        Pick<UsageSummaryService, 'getTotals' | 'getGrouped' | 'createExport'>
    >;
    let scopeContext: jest.Mocked<Pick<ScopeContextService, 'getOrganizationId'>>;
    let controller: CreditsController;

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
    } as AuthenticatedUser;

    const totals = {
        period: '2026-07',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        balanceCredits: 120,
        creditsConsumed: 30,
        creditsAdded: 150,
        spendCents: 25,
        tasksCompleted: 4,
        worksActive: 2,
        agentRuns: 9,
    };

    beforeEach(() => {
        creditLedgerService = {
            getBalance: jest.fn().mockResolvedValue(120),
            getLedger: jest.fn().mockResolvedValue({
                entries: [],
                total: 0,
                page: 1,
                pageSize: 25,
            }),
        } as any;
        usageSummaryService = {
            getTotals: jest.fn().mockResolvedValue(totals),
            getGrouped: jest.fn().mockResolvedValue({
                period: '2026-07',
                from: '2026-07-01T00:00:00.000Z',
                to: '2026-08-01T00:00:00.000Z',
                groupBy: 'day',
                rows: [],
            }),
            createExport: jest.fn().mockReturnValue({
                window: {
                    period: '2026-07',
                    from: new Date('2026-07-01T00:00:00.000Z'),
                    to: new Date('2026-08-01T00:00:00.000Z'),
                },
                organizationId: null,
                chunks: chunksOf([]),
            }),
        } as any;
        scopeContext = { getOrganizationId: jest.fn().mockReturnValue(null) } as any;
        controller = new CreditsController(
            creditLedgerService as unknown as CreditLedgerService,
            usageSummaryService as unknown as UsageSummaryService,
            scopeContext as unknown as ScopeContextService,
        );
    });

    describe('getUsageSummary — totals (no groupBy)', () => {
        it('returns the stat-tile totals scoped to the AUTHENTICATED user', async () => {
            const result = await controller.getUsageSummary(auth, {});

            expect(usageSummaryService.getTotals).toHaveBeenCalledWith('user-1', undefined);
            expect(usageSummaryService.getGrouped).not.toHaveBeenCalled();
            expect(result).toEqual({ status: 'success', ...totals });
        });

        it('passes the period through to the service (owner id still from auth)', async () => {
            await controller.getUsageSummary(auth, { period: '2026-06' });

            expect(usageSummaryService.getTotals).toHaveBeenCalledWith('user-1', '2026-06');
        });
    });

    describe('getUsageSummary — grouped', () => {
        it.each(['day', 'model', 'agent', 'work'] as const)(
            'dispatches groupBy=%s to getGrouped, owner-scoped to the authenticated user',
            async (groupBy) => {
                const result = await controller.getUsageSummary(auth, { groupBy, period: '7d' });

                expect(usageSummaryService.getGrouped).toHaveBeenCalledWith(
                    'user-1',
                    groupBy,
                    '7d',
                );
                expect(usageSummaryService.getTotals).not.toHaveBeenCalled();
                expect(result.status).toBe('success');
            },
        );

        it('maps InvalidUsagePeriodError to a 400 BadRequestException (never an unmapped 500)', async () => {
            usageSummaryService.getGrouped.mockRejectedValue(new InvalidUsagePeriodError('bogus'));

            await expect(
                controller.getUsageSummary(auth, { groupBy: 'day', period: '7d' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('propagates unexpected service errors untouched', async () => {
            usageSummaryService.getTotals.mockRejectedValue(new Error('db down'));

            await expect(controller.getUsageSummary(auth, {})).rejects.toThrow('db down');
        });
    });

    describe('CreditsUsageSummaryQueryDto validation (grouping + period contract)', () => {
        async function validateQuery(query: Record<string, unknown>) {
            return validate(plainToInstance(CreditsUsageSummaryQueryDto, query));
        }

        it('accepts every documented groupBy and rejects anything else', async () => {
            for (const groupBy of ['day', 'model', 'agent', 'work']) {
                expect(await validateQuery({ groupBy })).toHaveLength(0);
            }
            expect((await validateQuery({ groupBy: 'user' })).length).toBeGreaterThan(0);
            expect((await validateQuery({ groupBy: 'plugin' })).length).toBeGreaterThan(0);
        });

        it('accepts YYYY-MM / 7d / 30d periods and rejects malformed ones', async () => {
            for (const period of ['2026-07', '7d', '30d']) {
                expect(await validateQuery({ period })).toHaveLength(0);
            }
            for (const period of ['2026-13', '90d', 'last-week', '2026-7']) {
                expect((await validateQuery({ period })).length).toBeGreaterThan(0);
            }
        });
    });

    describe('exportUsageCsv (B29 — account-wide CSV export)', () => {
        const row = {
            occurredAt: '2026-07-04T10:00:00.000Z',
            pluginId: 'openrouter',
            capability: 'ai',
            units: 2,
            costCents: 31,
            currency: 'usd',
            modelId: 'model-a',
            workId: 'work-1',
            agentId: null,
            taskId: null,
            runId: null,
            requestId: null,
        };

        function primeExport(
            pages: Record<string, unknown>[][],
            window = {
                period: '2026-07',
                from: new Date('2026-07-01T00:00:00.000Z'),
                to: new Date('2026-08-01T00:00:00.000Z'),
            },
        ) {
            usageSummaryService.createExport.mockReturnValue({
                window,
                organizationId: null,
                chunks: chunksOf(pages),
            } as any);
        }

        it('scopes the export to the ACTIVE ORGANIZATION from the request scope context', async () => {
            scopeContext.getOrganizationId.mockReturnValue('org-a');
            primeExport([[row]]);
            const res = makeCsvResponse();

            await controller.exportUsageCsv(auth, res, {});

            expect(usageSummaryService.createExport).toHaveBeenCalledWith('user-1', {
                period: undefined,
                organizationId: 'org-a',
            });
        });

        it('never lets a caller-supplied query override the org scope', async () => {
            scopeContext.getOrganizationId.mockReturnValue('org-a');
            primeExport([[row]]);
            const res = makeCsvResponse();

            // A hostile client adds organizationId/orgId/userId. The
            // global ValidationPipe (whitelist + forbidNonWhitelisted)
            // 400s them before the handler; even if one slipped through,
            // the handler reads scope + auth and ignores the payload.
            await controller.exportUsageCsv(auth, res, {
                organizationId: 'org-b',
                orgId: 'org-b',
                userId: 'someone-else',
            } as never);

            expect(usageSummaryService.createExport).toHaveBeenCalledWith('user-1', {
                period: undefined,
                organizationId: 'org-a',
            });
        });

        it('omits the org filter (null) when the request has no active Organization', async () => {
            scopeContext.getOrganizationId.mockReturnValue(null);
            primeExport([[row]]);

            await controller.exportUsageCsv(auth, makeCsvResponse(), { period: '30d' });

            expect(usageSummaryService.createExport).toHaveBeenCalledWith('user-1', {
                period: '30d',
                organizationId: null,
            });
        });

        it('forwards a YYYY-MM period and names the file after the resolved month', async () => {
            primeExport([[row]], {
                period: '2026-06',
                from: new Date('2026-06-01T00:00:00.000Z'),
                to: new Date('2026-07-01T00:00:00.000Z'),
            });
            const res = makeCsvResponse();

            await controller.exportUsageCsv(auth, res, { period: '2026-06' });

            expect(usageSummaryService.createExport).toHaveBeenCalledWith('user-1', {
                period: '2026-06',
                organizationId: null,
            });
            expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
            expect(res.headers['Content-Disposition']).toBe(
                'attachment; filename="usage-2026-06.csv"',
            );
        });

        it('writes the pinned header then one line per row, and ends the response', async () => {
            primeExport([[row]]);
            const res = makeCsvResponse();

            await controller.exportUsageCsv(auth, res, {});

            const lines = res.body.trimEnd().split('\n');
            expect(lines[0]).toBe(
                'occurredAt,pluginId,capability,units,costCents,currency,modelId,workId,agentId,taskId,runId,requestId',
            );
            expect(lines[1]).toBe(
                '2026-07-04T10:00:00.000Z,openrouter,ai,2,31,usd,model-a,work-1,,,,',
            );
            expect(res.ended).toBe(true);
        });

        it('streams chunk-by-chunk instead of buffering the whole period', async () => {
            primeExport([[row], [{ ...row, pluginId: 'tavily' }]]);
            const res = makeCsvResponse();

            await controller.exportUsageCsv(auth, res, {});

            // header write + one write per repository page
            expect(res.written).toHaveLength(3);
            expect(res.body).toContain('tavily');
        });

        it('RFC 4180-escapes values containing commas or quotes', async () => {
            primeExport([[{ ...row, modelId: 'a,b', requestId: 'say "hi"' }]]);
            const res = makeCsvResponse();

            await controller.exportUsageCsv(auth, res, {});

            expect(res.body).toContain('"a,b"');
            expect(res.body).toContain('"say ""hi"""');
        });

        it('maps InvalidUsagePeriodError to a 400 (never an unmapped 500)', async () => {
            usageSummaryService.createExport.mockImplementation(() => {
                throw new InvalidUsagePeriodError('bogus');
            });

            await expect(
                controller.exportUsageCsv(auth, makeCsvResponse(), {}),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('propagates unexpected errors untouched', async () => {
            usageSummaryService.createExport.mockImplementation(() => {
                throw new Error('db down');
            });

            await expect(controller.exportUsageCsv(auth, makeCsvResponse(), {})).rejects.toThrow(
                'db down',
            );
        });

        it('throws (rather than half-writing a 200) when the FIRST page fails', async () => {
            usageSummaryService.createExport.mockReturnValue({
                window: {
                    period: '2026-07',
                    from: new Date('2026-07-01T00:00:00.000Z'),
                    to: new Date('2026-08-01T00:00:00.000Z'),
                },
                organizationId: null,
                chunks: {
                    // eslint-disable-next-line require-yield
                    async *[Symbol.asyncIterator]() {
                        throw new Error('query failed');
                    },
                },
            } as any);
            const res = makeCsvResponse();

            await expect(controller.exportUsageCsv(auth, res, {})).rejects.toThrow('query failed');
            expect(res.written).toHaveLength(0);
            expect(res.headers['Content-Disposition']).toBeUndefined();
        });

        it('an empty period still returns a header-only CSV', async () => {
            primeExport([]);
            const res = makeCsvResponse();

            await controller.exportUsageCsv(auth, res, {});

            expect(res.body).toBe(
                'occurredAt,pluginId,capability,units,costCents,currency,modelId,workId,agentId,taskId,runId,requestId\n',
            );
            expect(res.ended).toBe(true);
        });
    });

    describe('CreditsUsageExportQueryDto validation', () => {
        async function validateQuery(query: Record<string, unknown>) {
            return validate(plainToInstance(CreditsUsageExportQueryDto, query));
        }

        it('accepts YYYY-MM / 7d / 30d periods (B20 — the month option is reachable)', async () => {
            for (const period of ['2026-07', '2025-12', '7d', '30d']) {
                expect(await validateQuery({ period })).toHaveLength(0);
            }
        });

        it('rejects malformed periods and non-csv formats', async () => {
            for (const period of ['2026-13', '90d', 'last-month', '2026-7']) {
                expect((await validateQuery({ period })).length).toBeGreaterThan(0);
            }
            expect(await validateQuery({ format: 'csv' })).toHaveLength(0);
            expect((await validateQuery({ format: 'xlsx' })).length).toBeGreaterThan(0);
        });
    });

    describe('getPricing (billing spec FR-13)', () => {
        it('returns the server-authored pricing view under the success envelope', () => {
            const result = controller.getPricing();

            expect(result).toMatchObject({
                status: 'success',
                creditsPerDollar: 100,
                marginPercent: 35,
                dailyFreeCredits: 50,
                payg: expect.objectContaining({ defaultMonthlyCapCredits: 10000 }),
            });
            expect(result.packs).toHaveLength(1);
        });
    });

    describe('getBalance / getLedger (existing surface — owner-scope regression)', () => {
        it('getBalance reads the AUTHENTICATED user balance', async () => {
            const result = await controller.getBalance(auth);

            expect(creditLedgerService.getBalance).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ status: 'success', balanceCredits: 120 });
        });

        it('getLedger forwards parsed filters, owner-scoped to the authenticated user', async () => {
            await controller.getLedger(auth, {
                period: '2026-07',
                kinds: 'purchase,consumption',
                page: 2,
                pageSize: 10,
            });

            expect(creditLedgerService.getLedger).toHaveBeenCalledWith('user-1', {
                period: '2026-07',
                kinds: ['purchase', 'consumption'],
                page: 2,
                pageSize: 10,
            });
        });

        it('getLedger rejects an unknown ledger kind with a 400', async () => {
            await expect(
                controller.getLedger(auth, { kinds: 'purchase,bogus' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(creditLedgerService.getLedger).not.toHaveBeenCalled();
        });
    });
});
