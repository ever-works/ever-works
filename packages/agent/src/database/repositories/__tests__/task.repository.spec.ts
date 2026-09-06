import { TaskRepository } from '../task.repository';

describe('TaskRepository ownership scope', () => {
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    it('loads a known Task UUID with an exact user + tenant + Organization predicate', async () => {
        const findOne = jest.fn().mockResolvedValue(null);
        const tasks = new TaskRepository({ findOne } as never);

        await (tasks.findByIdAndUser as any)('task-ever', 'user-1', everScope);

        expect(findOne).toHaveBeenCalledWith({
            where: [{ id: 'task-ever', userId: 'user-1', ...everScope }],
        });
    });

    it('adds the active Organization predicate to list SQL before pagination', async () => {
        const qb: any = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            getCount: jest.fn().mockResolvedValue(0),
            getMany: jest.fn().mockResolvedValue([]),
        };
        const tasks = new TaskRepository({ createQueryBuilder: jest.fn(() => qb) } as never);

        await (tasks.findByUserIdFiltered as any)('user-1', {}, everScope);

        expect(qb.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('task.organizationId = :taskScopeOrganizationId'),
            expect.objectContaining({ taskScopeOrganizationId: everScope.organizationId }),
        );
    });
});

describe('TaskRepository.findFanoutCandidates', () => {
    function makeQb() {
        const qb: any = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            addOrderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
        };
        return qb;
    }

    it('excludes every Task family another driver already dispatches', async () => {
        const qb = makeQb();
        const tasks = new TaskRepository({ createQueryBuilder: jest.fn(() => qb) } as never);

        await tasks.findFanoutCandidates(50);

        const clauses = qb.andWhere.mock.calls.map((call: unknown[]) => call[0]);
        // A Goal's iteration Tasks are the GOAL LOOP's to drive (it creates
        // them `todo`, dispatches them itself and bounds them with
        // maxConcurrentIterations); a recurrence INSTANCE is the recurrence
        // scan's. Both stay `todo` after their run, so without these the
        // fan-out would re-run them and drive a serial Goal past its ceiling.
        expect(clauses).toContain('task.goalId IS NULL');
        expect(clauses).toContain('task.parentRecurringTaskId IS NULL');
    });

    it('only considers Tasks that have never been run', async () => {
        const qb = makeQb();
        const tasks = new TaskRepository({ createQueryBuilder: jest.fn(() => qb) } as never);

        await tasks.findFanoutCandidates(50);

        const clauses = qb.andWhere.mock.calls.map((call: unknown[]) => call[0]);
        // Board "Run" dispatches a run and leaves the Task in `todo`, so
        // "still todo" is not "never started".
        expect(clauses).toContain('task.startedAt IS NULL');
        expect(clauses).toContain('task.latestRunId IS NULL');
    });

    it('keeps the scan deterministic and bounded', async () => {
        const qb = makeQb();
        const tasks = new TaskRepository({ createQueryBuilder: jest.fn(() => qb) } as never);

        await tasks.findFanoutCandidates(7);

        expect(qb.orderBy).toHaveBeenCalledWith('task.priority', 'ASC');
        expect(qb.addOrderBy).toHaveBeenCalledWith('task.createdAt', 'ASC');
        expect(qb.addOrderBy).toHaveBeenCalledWith('task.id', 'ASC');
        expect(qb.take).toHaveBeenCalledWith(7);
    });
});

describe('TaskRepository.wouldCreateCycle', () => {
    function makeSvc(parentChain: Record<string, string | null>) {
        const repo = {
            findOne: jest.fn(async (args: any) => {
                const id = args?.where?.id;
                if (!(id in parentChain)) return null;
                return { id, parentTaskId: parentChain[id] } as any;
            }),
        };
        return new TaskRepository(repo as any);
    }

    it('self-loop is a cycle', async () => {
        const svc = makeSvc({});
        expect(await svc.wouldCreateCycle('a', 'a')).toBe(true);
    });

    it('two independent tasks are not a cycle', async () => {
        const svc = makeSvc({ b: null });
        expect(await svc.wouldCreateCycle('a', 'b')).toBe(false);
    });

    it('detects a two-hop cycle (a → b → a)', async () => {
        // Walk from proposedParent=b → b.parent=a → reach candidateChild=a
        const svc = makeSvc({ b: 'a', a: null });
        expect(await svc.wouldCreateCycle('a', 'b')).toBe(true);
    });

    it('detects a three-hop cycle', async () => {
        const svc = makeSvc({ c: 'b', b: 'a', a: null });
        expect(await svc.wouldCreateCycle('a', 'c')).toBe(true);
    });

    it('does NOT flag a long sibling chain as a cycle', async () => {
        const svc = makeSvc({ b: 'root', c: 'root', root: null });
        expect(await svc.wouldCreateCycle('b', 'c')).toBe(false);
    });

    it('bails out gracefully on pre-existing cyclic data', async () => {
        // b → a → b (impossible-but-defensive)
        const svc = makeSvc({ a: 'b', b: 'a' });
        expect(await svc.wouldCreateCycle('z', 'a')).toBe(true);
    });
});

describe('TaskRepository.casClaimRecurrence', () => {
    it('returns true when the UPDATE affected exactly one row', async () => {
        const exec = jest.fn().mockResolvedValue({ affected: 1 });
        const qb: any = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: exec,
        };
        const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        const svc = new TaskRepository(repo);
        const ok = await svc.casClaimRecurrence(
            't1',
            new Date('2026-05-26T00:00:00Z'),
            new Date('2026-05-27T00:00:00Z'),
        );
        expect(ok).toBe(true);
        expect(qb.update).toHaveBeenCalled();
    });

    it('returns false when the CAS guard prevented the UPDATE', async () => {
        const exec = jest.fn().mockResolvedValue({ affected: 0 });
        const qb: any = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: exec,
        };
        const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        const svc = new TaskRepository(repo);
        expect(await svc.casClaimRecurrence('t1', new Date(), null)).toBe(false);
    });
});

/**
 * Git activity ingestion (audit item j) — a push names a branch, and the
 * worktree-per-Task path stamps that branch onto `tasks.branchRef`.
 */
describe('TaskRepository.findByWorkAndBranchRef', () => {
    it('keys on (workId, branchRef) and prefers the most recently updated row', async () => {
        const findOne = jest.fn().mockResolvedValue({ id: 't1' });
        const svc = new TaskRepository({ findOne } as any);

        await expect(svc.findByWorkAndBranchRef('w1', 'ever/task-t-42')).resolves.toEqual({
            id: 't1',
        });
        expect(findOne).toHaveBeenCalledWith({
            where: { workId: 'w1', branchRef: 'ever/task-t-42' },
            order: { updatedAt: 'DESC' },
        });
    });

    it('short-circuits an empty branch instead of matching every branchless Task', async () => {
        const findOne = jest.fn();
        const svc = new TaskRepository({ findOne } as any);

        await expect(svc.findByWorkAndBranchRef('w1', '')).resolves.toBeNull();
        expect(findOne).not.toHaveBeenCalled();
    });
});

/**
 * Board visibility (Task Triggers) — Tasks a trigger chose to keep off
 * the Kanban carry `hiddenFromBoard`, and every list read must exclude
 * them unless the caller opts in. Asserted on the emitted predicate
 * because that is the whole mechanism.
 */
describe('TaskRepository.findByUserIdFiltered board visibility', () => {
    function makeListSvc() {
        const qb: any = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            getCount: jest.fn().mockResolvedValue(0),
            getMany: jest.fn().mockResolvedValue([]),
        };
        const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        return { svc: new TaskRepository(repo), qb };
    }

    const hiddenClauses = (qb: any) =>
        qb.andWhere.mock.calls.filter((call: unknown[]) =>
            String(call[0]).includes('hiddenFromBoard'),
        );

    it('excludes hidden Tasks by default', async () => {
        const { svc, qb } = makeListSvc();
        await svc.findByUserIdFiltered('u1', {});
        expect(hiddenClauses(qb)).toEqual([
            ['task.hiddenFromBoard = :hiddenFromBoard', { hiddenFromBoard: false }],
        ]);
    });

    it('includes them when the caller opts in', async () => {
        const { svc, qb } = makeListSvc();
        await svc.findByUserIdFiltered('u1', { includeHidden: true });
        expect(hiddenClauses(qb)).toHaveLength(0);
    });
});
