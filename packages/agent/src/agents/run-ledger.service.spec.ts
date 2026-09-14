import type { AgentRun } from '../entities/agent-run.entity';
import { ledgerCursorOf, parseLedgerCursor, RunLedgerService } from './run-ledger.service';

/**
 * Runs ledger (AW-09) — the service between the API and the repository.
 *
 * The repository's SQL is pinned by its integration spec; this spec pins
 * what the service adds: the window it resolves, the filters and scope it
 * forwards untouched, the page/cursor arithmetic, one label lookup per
 * page (never per row), read-time redaction of error text, and the
 * calendar's timezone bucketing.
 */
describe('RunLedgerService', () => {
    const USER = 'user-1';
    const NOW = new Date('2026-09-13T10:00:00.000Z');
    const SCOPE = { tenantId: 't1', organizationId: 'o1' };

    let repo: {
        listLedgerPage: jest.Mock;
        countLedger: jest.Mock;
        aggregateLedger: jest.Mock;
        countScheduledFailuresByAgent: jest.Mock;
        listLedgerInstants: jest.Mock;
        resolveLedgerLabels: jest.Mock;
        hasAnyRunForUser: jest.Mock;
    };
    let service: RunLedgerService;

    function run(over: Partial<AgentRun> = {}): AgentRun {
        return {
            id: 'r1',
            agentId: 'a1',
            userId: USER,
            triggerKind: 'task',
            status: 'completed',
            startedAt: new Date('2026-09-13T09:00:00.000Z'),
            createdAt: new Date('2026-09-13T08:59:00.000Z'),
            finishedAt: null,
            durationMs: 1200,
            costCents: 31,
            totalTokens: 900,
            summary: 'Reviewed 14 pull requests',
            errorMessage: null,
            currentActivity: null,
            taskId: null,
            workId: null,
            awaitingInput: false,
            queuedReason: null,
            attentionReason: null,
            ...over,
        } as AgentRun;
    }

    function emptyLabels() {
        return { agents: new Map(), tasks: new Map(), missions: new Map(), works: new Map() };
    }

    beforeEach(() => {
        repo = {
            listLedgerPage: jest.fn().mockResolvedValue([]),
            countLedger: jest.fn().mockResolvedValue(0),
            aggregateLedger: jest.fn().mockResolvedValue([]),
            countScheduledFailuresByAgent: jest.fn().mockResolvedValue([]),
            listLedgerInstants: jest.fn().mockResolvedValue([]),
            resolveLedgerLabels: jest.fn().mockResolvedValue(emptyLabels()),
            hasAnyRunForUser: jest.fn().mockResolvedValue(true),
        };
        service = new RunLedgerService(repo as never);
    });

    describe('cursor', () => {
        it('round-trips the ledger instant and id', () => {
            const cursor = ledgerCursorOf(run());
            expect(cursor).toBe(`${new Date('2026-09-13T09:00:00.000Z').getTime()}_r1`);
            expect(parseLedgerCursor(cursor)).toEqual({
                at: new Date('2026-09-13T09:00:00.000Z'),
                id: 'r1',
            });
        });

        it('uses creation time for a run that never started', () => {
            expect(ledgerCursorOf(run({ startedAt: null }))).toBe(
                `${new Date('2026-09-13T08:59:00.000Z').getTime()}_r1`,
            );
        });

        it('treats garbage as the first page', () => {
            expect(parseLedgerCursor('nope')).toBeUndefined();
            expect(parseLedgerCursor('abc_r1')).toBeUndefined();
            expect(parseLedgerCursor('_r1')).toBeUndefined();
            expect(parseLedgerCursor(undefined)).toBeUndefined();
        });
    });

    describe('listRuns', () => {
        it('resolves the window and forwards filters and scope to every read unchanged', async () => {
            const filters = {
                agentIds: ['a1', 'a2'],
                statuses: ['failed' as const],
                triggerKinds: ['heartbeat' as const],
                workId: 'w1',
                missionId: 'm1',
                search: 'deploy',
            };

            const result = await service.listRuns(
                USER,
                { granularity: 'week', date: '2026-09-10', timezone: 'UTC', filters, now: NOW },
                SCOPE,
            );

            const range = {
                from: new Date('2026-09-07T00:00:00.000Z'),
                to: new Date('2026-09-14T00:00:00.000Z'),
            };
            expect(result.window.from).toBe('2026-09-07T00:00:00.000Z');
            expect(repo.listLedgerPage).toHaveBeenCalledWith(
                USER,
                range,
                filters,
                51,
                undefined,
                SCOPE,
            );
            expect(repo.countLedger).toHaveBeenCalledWith(USER, range, filters, SCOPE);
        });

        it('defaults to 50 rows and caps a larger request at 200', async () => {
            await service.listRuns(USER, { now: NOW });
            expect(repo.listLedgerPage.mock.calls[0][3]).toBe(51);

            await service.listRuns(USER, { limit: 500, now: NOW });
            expect(repo.listLedgerPage.mock.calls[1][3]).toBe(201);

            const page = await service.listRuns(USER, { limit: 0, now: NOW });
            expect(page.limit).toBe(50);
        });

        it('returns a next cursor only when the repository had one row more than the page', async () => {
            const rows = [
                run({ id: 'r3', startedAt: new Date('2026-09-13T09:30:00.000Z') }),
                run({ id: 'r2', startedAt: new Date('2026-09-13T09:20:00.000Z') }),
                run({ id: 'r1', startedAt: new Date('2026-09-13T09:10:00.000Z') }),
            ];
            repo.listLedgerPage.mockResolvedValue(rows);
            repo.countLedger.mockResolvedValue(7);

            const page = await service.listRuns(USER, { limit: 2, now: NOW });

            expect(page.rows.map((row) => row.id)).toEqual(['r3', 'r2']);
            expect(page.nextCursor).toBe(ledgerCursorOf(rows[1]));
            expect(page.total).toBe(7);

            repo.listLedgerPage.mockResolvedValue(rows.slice(0, 2));
            const last = await service.listRuns(USER, { limit: 2, now: NOW });
            expect(last.nextCursor).toBeNull();
        });

        it('passes a parsed cursor to the repository', async () => {
            await service.listRuns(USER, { cursor: '1789290000000_r9', now: NOW });
            expect(repo.listLedgerPage.mock.calls[0][4]).toEqual({
                at: new Date(1789290000000),
                id: 'r9',
            });
        });

        it('resolves labels with ONE lookup for a full page', async () => {
            const rows = Array.from({ length: 50 }, (_, i) =>
                run({ id: `r${i}`, agentId: `a${i % 3}`, taskId: `t${i % 5}`, workId: 'w1' }),
            );
            repo.listLedgerPage.mockResolvedValue(rows);

            await service.listRuns(USER, { now: NOW });

            expect(repo.resolveLedgerLabels).toHaveBeenCalledTimes(1);
        });

        it('tells "nothing in this window" from "no runs yet" only for an empty unfiltered page', async () => {
            repo.hasAnyRunForUser.mockResolvedValue(false);
            const never = await service.listRuns(USER, { now: NOW }, SCOPE);
            expect(never.everRan).toBe(false);
            expect(repo.hasAnyRunForUser).toHaveBeenCalledWith(USER, SCOPE);

            repo.hasAnyRunForUser.mockClear();
            const filtered = await service.listRuns(USER, {
                filters: { statuses: ['failed'] },
                now: NOW,
            });
            expect(filtered.everRan).toBeNull();

            repo.countLedger.mockResolvedValue(3);
            repo.listLedgerPage.mockResolvedValue([run()]);
            const busy = await service.listRuns(USER, { now: NOW });
            expect(busy.everRan).toBeNull();
            expect(repo.hasAnyRunForUser).not.toHaveBeenCalled();
        });

        it('never calls the label lookup for an empty page', async () => {
            await service.listRuns(USER, { now: NOW });
            expect(repo.resolveLedgerLabels).not.toHaveBeenCalled();
        });
    });

    describe('toRows', () => {
        it('maps labels, the archived flag, the Mission through the Task and the schedule key', async () => {
            repo.resolveLedgerLabels.mockResolvedValue({
                agents: new Map([['a1', { name: 'Ops', archived: true }]]),
                tasks: new Map([['t1', { title: 'Review PRs', missionId: 'm1' }]]),
                missions: new Map([['m1', 'Ship the release']]),
                works: new Map([['w1', 'Docs site']]),
            });

            const [row] = await service.toRows([
                run({ triggerKind: 'heartbeat', taskId: 't1', workId: 'w1' }),
            ]);

            expect(row).toMatchObject({
                agentName: 'Ops',
                agentArchived: true,
                taskTitle: 'Review PRs',
                missionId: 'm1',
                missionTitle: 'Ship the release',
                workName: 'Docs site',
                scheduleKey: 'agent_heartbeat:a1',
            });
        });

        it('labels a run with no Task, Work or known Agent honestly — keys present, values null', async () => {
            const [row] = await service.toRows([run({ agentId: 'deleted' })]);

            expect(row.agentName).toBeNull();
            expect(row.agentArchived).toBe(false);
            expect(row).toHaveProperty('missionId', null);
            expect(row).toHaveProperty('missionTitle', null);
            expect(row).toHaveProperty('taskTitle', null);
            expect(row).toHaveProperty('workName', null);
            expect(row.scheduleKey).toBeNull();
        });

        it('re-redacts the error text so an echoed credential never leaves the platform', async () => {
            const [row] = await service.toRows([
                run({
                    status: 'failed',
                    errorMessage:
                        'Provider said: invalid key token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                }),
            ]);

            expect(row.errorMessage).not.toContain('token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            expect(row.errorMessage).toContain('Provider said');
        });

        it('leaves a missing cost and token total as null, not zero', async () => {
            const [row] = await service.toRows([run({ costCents: null, totalTokens: null })]);
            expect(row.costCents).toBeNull();
            expect(row.totalTokens).toBeNull();
        });
    });

    describe('getStats', () => {
        it('computes from the grouped rows and names the repeatedly failing schedules', async () => {
            repo.aggregateLedger.mockResolvedValue([
                {
                    status: 'failed',
                    triggerKind: 'heartbeat',
                    runs: 3,
                    durationMs: 0,
                    costCents: 0,
                    costedRuns: 0,
                    tokens: 0,
                    tokenRuns: 0,
                },
            ]);
            repo.countScheduledFailuresByAgent.mockResolvedValue([{ agentId: 'a1', failures: 3 }]);
            repo.resolveLedgerLabels.mockResolvedValue({
                ...emptyLabels(),
                agents: new Map([['a1', { name: 'Research', archived: false }]]),
            });

            const stats = await service.getStats(USER, { now: NOW }, SCOPE);

            expect(stats.errorCount).toBe(3);
            expect(stats.successRate).toBe(0);
            expect(stats.repeatFailures).toEqual([
                {
                    scheduleKey: 'agent_heartbeat:a1',
                    agentId: 'a1',
                    agentName: 'Research',
                    failures: 3,
                },
            ]);
            expect(repo.countScheduledFailuresByAgent.mock.calls[0][3]).toBe(2);
            expect(repo.countScheduledFailuresByAgent.mock.calls[0][4]).toBe(SCOPE);
        });

        it('skips the name lookup when no schedule repeats', async () => {
            await service.getStats(USER, { now: NOW });
            expect(repo.resolveLedgerLabels).not.toHaveBeenCalled();
        });
    });

    describe('getCalendar', () => {
        it('buckets runs into calendar days of the viewer timezone and counts failures', async () => {
            repo.listLedgerInstants.mockResolvedValue([
                // 20:30 UTC on the 7th is already the 8th in Tokyo.
                { at: new Date('2026-09-07T20:30:00.000Z'), status: 'failed' },
                { at: new Date('2026-09-08T01:00:00.000Z'), status: 'completed' },
                { at: new Date('2026-09-09T01:00:00.000Z'), status: 'completed' },
            ]);

            // A clock at which all of September is reachable, so the read
            // spans the whole month (partial months are pinned below).
            const month = await service.getCalendar(
                USER,
                {
                    month: '2026-09',
                    timezone: 'Asia/Tokyo',
                    now: new Date('2026-10-15T10:00:00.000Z'),
                },
                SCOPE,
            );

            expect(month.days).toEqual([
                { date: '2026-09-08', runs: 2, failures: 1 },
                { date: '2026-09-09', runs: 1, failures: 0 },
            ]);
            expect(month.truncated).toBe(false);
            const [, range, , , scope] = repo.listLedgerInstants.mock.calls[0];
            expect(range.from.toISOString()).toBe('2026-08-31T15:00:00.000Z');
            expect(range.to.toISOString()).toBe('2026-09-30T15:00:00.000Z');
            expect(scope).toBe(SCOPE);
        });

        /** A repository double that honours the half-open range it is given, like the SQL does. */
        function instantsInRange(all: Array<{ at: Date; status: string }>) {
            repo.listLedgerInstants.mockImplementation(
                async (_user: string, range: { from: Date; to: Date }) =>
                    all.filter(({ at }) => at >= range.from && at < range.to),
            );
        }

        it('clips the month 7 days ahead at the last reachable day, matching the day window there', async () => {
            // NOW is 13 Sep 2026, so the latest reachable day is 20 Sep.
            instantsInRange([
                { at: new Date('2026-09-20T12:00:00.000Z'), status: 'completed' },
                { at: new Date('2026-09-21T12:00:00.000Z'), status: 'failed' },
                { at: new Date('2026-09-29T12:00:00.000Z'), status: 'completed' },
            ]);

            const month = await service.getCalendar(USER, {
                month: '2026-09',
                timezone: 'UTC',
                now: NOW,
            });

            expect(month.days).toEqual([{ date: '2026-09-20', runs: 1, failures: 0 }]);
            const [, range] = repo.listLedgerInstants.mock.calls[0];
            expect(range.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
            expect(range.to.toISOString()).toBe('2026-09-21T00:00:00.000Z');

            // The list and the totals for the furthest day stop at the same instant.
            const lastDay = service.resolveWindow({
                date: '2026-09-21',
                timezone: 'UTC',
                now: NOW,
            });
            expect(lastDay.clamped).toBe(true);
            expect(lastDay.to).toBe(range.to.toISOString());
        });

        it('clips the month 12 months back at the earliest reachable day, matching the day window there', async () => {
            // NOW is 13 Sep 2026, so the earliest reachable day is 13 Sep 2025.
            instantsInRange([
                { at: new Date('2025-09-12T12:00:00.000Z'), status: 'failed' },
                { at: new Date('2025-09-13T12:00:00.000Z'), status: 'failed' },
            ]);

            const month = await service.getCalendar(USER, {
                month: '2025-09',
                timezone: 'UTC',
                now: NOW,
            });

            expect(month.days).toEqual([{ date: '2025-09-13', runs: 1, failures: 1 }]);
            const [, range] = repo.listLedgerInstants.mock.calls[0];
            expect(range.from.toISOString()).toBe('2025-09-13T00:00:00.000Z');
            expect(range.to.toISOString()).toBe('2025-10-01T00:00:00.000Z');

            const firstDay = service.resolveWindow({
                date: '2025-09-12',
                timezone: 'UTC',
                now: NOW,
            });
            expect(firstDay.clamped).toBe(true);
            expect(firstDay.from).toBe(range.from.toISOString());
        });

        it('clips a partial month on local-midnight boundaries of the viewer timezone', async () => {
            const month = await service.getCalendar(
                USER,
                { month: '2026-09', timezone: 'Asia/Tokyo', now: NOW },
                SCOPE,
            );

            expect(month.days).toEqual([]);
            const [, range] = repo.listLedgerInstants.mock.calls[0];
            // 1 Sep 00:00 and 21 Sep 00:00 in Tokyo (UTC+9).
            expect(range.from.toISOString()).toBe('2026-08-31T15:00:00.000Z');
            expect(range.to.toISOString()).toBe('2026-09-20T15:00:00.000Z');
        });

        it('reads nothing for a month wholly outside the 12-month reach', async () => {
            const month = await service.getCalendar(USER, { month: '2025-08', now: NOW });
            expect(month.days).toEqual([]);
            expect(repo.listLedgerInstants).not.toHaveBeenCalled();
        });

        it('reads nothing for an invalid month', async () => {
            const month = await service.getCalendar(USER, { month: '2026-13', now: NOW });
            expect(month.days).toEqual([]);
            expect(repo.listLedgerInstants).not.toHaveBeenCalled();
        });
    });
});
