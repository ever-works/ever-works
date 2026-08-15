import { AgentRunLogRepository } from './agent-run-log.repository';

/**
 * Session detail (Feature K) — the two timeline reads behind
 * `GET /api/agents/runs/:runId/detail`.
 *
 * Both are query-builder based (the step-name `IN` list and the keyset
 * cursor have no `find()` equivalent), so the contracts worth pinning are
 * the ones a refactor would silently break: the run is ALWAYS scoped, the
 * cursor predicate is a real (createdAt, id) keyset — not `createdAt >`
 * alone, which drops rows appended inside the same millisecond — and an
 * empty step list short-circuits instead of emitting `IN ()`.
 */
describe('AgentRunLogRepository — session-detail timeline reads', () => {
    let qb: Record<string, jest.Mock>;
    let repository: { createQueryBuilder: jest.Mock };
    let logs: AgentRunLogRepository;

    /** Every `where`/`andWhere` call as [sql, params]. */
    let predicates: Array<[string, Record<string, unknown> | undefined]>;

    beforeEach(() => {
        predicates = [];
        const record = (sql: unknown, params?: Record<string, unknown>) => {
            predicates.push([String(sql), params]);
            return qb;
        };
        qb = {
            where: jest.fn(record),
            andWhere: jest.fn(record),
            orderBy: jest.fn(() => qb),
            addOrderBy: jest.fn(() => qb),
            take: jest.fn(() => qb),
            getCount: jest.fn().mockResolvedValue(7),
            getMany: jest.fn().mockResolvedValue([]),
        };
        repository = { createQueryBuilder: jest.fn(() => qb) };
        logs = new AgentRunLogRepository(repository as never);
    });

    afterEach(() => jest.restoreAllMocks());

    function sqlOf(): string {
        return predicates.map(([sql]) => sql).join(' AND ');
    }

    describe('countByRunSteps', () => {
        it('counts the requested step subset within one run', async () => {
            await expect(
                logs.countByRunSteps('r1', ['assistant-message', 'user-message']),
            ).resolves.toBe(7);
            expect(sqlOf()).toContain('log.runId = :runId');
            expect(predicates[0][1]).toEqual({ runId: 'r1' });
            expect(predicates[1][1]).toEqual({
                steps: ['assistant-message', 'user-message'],
            });
        });

        it('short-circuits an empty step list (never emits `IN ()`)', async () => {
            await expect(logs.countByRunSteps('r1', [])).resolves.toBe(0);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });
    });

    describe('findTimelineByRun', () => {
        it('reads the first page oldest-first with the caller-supplied limit', async () => {
            await logs.findTimelineByRun('r1', ['tool-invocation'], 100);
            expect(qb.orderBy).toHaveBeenCalledWith('log.createdAt', 'ASC');
            expect(qb.addOrderBy).toHaveBeenCalledWith('log.id', 'ASC');
            expect(qb.take).toHaveBeenCalledWith(100);
            // No cursor ⇒ exactly the run + step predicates.
            expect(predicates).toHaveLength(2);
        });

        it('⭐ pages with a (createdAt, id) keyset so same-millisecond rows are not skipped', async () => {
            const createdAt = new Date('2026-08-14T10:00:00.000Z');
            await logs.findTimelineByRun('r1', ['tool-invocation'], 100, {
                createdAt,
                id: 'log-42',
            });
            const cursorPredicate = predicates[2];
            expect(cursorPredicate[0]).toContain('log.createdAt > :afterCreatedAt');
            expect(cursorPredicate[0]).toContain('log.createdAt = :afterCreatedAt');
            expect(cursorPredicate[0]).toContain('log.id > :afterId');
            expect(cursorPredicate[1]).toEqual({ afterCreatedAt: createdAt, afterId: 'log-42' });
        });

        it('short-circuits an empty step list', async () => {
            await expect(logs.findTimelineByRun('r1', [], 100)).resolves.toEqual([]);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });
    });
});
