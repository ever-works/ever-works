import {
    ATTENTION_REASON_QUEUED_TOO_LONG,
    ATTENTION_REASON_STALE_PARKED,
    AgentRunRepository,
    STALE_PARK_SUMMARY_PREFIX,
} from '../agent-run.repository';

/**
 * `agent_runs` — the M6 attention columns and the M7 spend rollup.
 *
 * A chainable query-builder stub (the `activity-log.repository.spec`
 * idiom): every builder method returns the stub, and the terminal call
 * (`execute` / `getRawOne` / `getMany`) resolves whatever the test fixed.
 * That lets these tests assert the SHAPE of what the repository asks the
 * database for, which is the part unit tests can meaningfully own.
 */
function makeQueryBuilder(terminal: Record<string, unknown> = {}) {
    const qb: Record<string, unknown> = {};
    for (const method of [
        'select',
        'addSelect',
        'update',
        'set',
        'where',
        'andWhere',
        'orderBy',
        'limit',
        'take',
        'skip',
        'setParameters',
    ]) {
        qb[method] = jest.fn(() => qb);
    }
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    qb.getRawOne = jest.fn().mockResolvedValue({});
    qb.getMany = jest.fn().mockResolvedValue([]);
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    Object.assign(qb, terminal);
    return qb as never;
}

describe('AgentRunRepository — attention + spend (M6/M7)', () => {
    let repository: any;
    let settler: any;

    function makeRepo(): AgentRunRepository {
        return new AgentRunRepository(repository, settler);
    }

    beforeEach(() => {
        repository = {
            createQueryBuilder: jest.fn(() => makeQueryBuilder()),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            findOne: jest.fn().mockResolvedValue(null),
        };
        settler = { settleRun: jest.fn().mockResolvedValue(undefined) };
    });

    afterEach(() => jest.restoreAllMocks());

    describe('parkStaleRunning (M6)', () => {
        it('⭐ writes the resume token, and guards on `running` only', async () => {
            // THE PARK TEST. `terminalEndedReason='parked'` IS the resume
            // affordance — `RunSteeringService.isResumable` reads exactly
            // that literal. Without it the run is terminal and unrevivable,
            // which is the pre-M6 hard fail wearing a nicer status.
            const qb = makeQueryBuilder();
            repository.createQueryBuilder.mockReturnValue(qb);

            await makeRepo().parkStaleRunning(['r1'], `${STALE_PARK_SUMMARY_PREFIX}: …`);

            const patch = (qb as never as { set: jest.Mock }).set.mock.calls[0][0];
            expect(patch.terminalEndedReason).toBe('parked');
            expect(patch.terminalState).toBe('ended');
            expect(patch.status).toBe('completed');
            expect(patch.attentionReason).toBe(ATTENTION_REASON_STALE_PARKED);
            // `queued` rows never started — nothing to checkpoint.
            const guards = (qb as never as { andWhere: jest.Mock }).andWhere.mock.calls.flat();
            expect(JSON.stringify(guards)).toContain('running');
        });

        it('is a no-op on an empty id list (TypeORM renders invalid SQL for IN ())', async () => {
            await expect(makeRepo().parkStaleRunning([], 'x')).resolves.toBe(0);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('returns what the CAS actually transitioned, not the input size', async () => {
            repository.createQueryBuilder.mockReturnValue(
                makeQueryBuilder({ execute: jest.fn().mockResolvedValue({ affected: 1 }) }),
            );
            await expect(makeRepo().parkStaleRunning(['r1', 'r2', 'r3'], 'x')).resolves.toBe(1);
        });
    });

    describe('setAttention (M6)', () => {
        it('⭐ CAS-guards a raise so the paired notification fires exactly once', async () => {
            // Two overlapping sweeper ticks must not both notify. The guard
            // is what makes the flag write the dedup point.
            const qb = makeQueryBuilder();
            repository.createQueryBuilder.mockReturnValue(qb);

            await makeRepo().setAttention('r1', ATTENTION_REASON_QUEUED_TOO_LONG);

            const guards = (qb as never as { andWhere: jest.Mock }).andWhere.mock.calls.flat();
            expect(JSON.stringify(guards)).toContain('attentionReason IS NULL');
        });

        it('reports false when another writer already raised the flag', async () => {
            repository.createQueryBuilder.mockReturnValue(
                makeQueryBuilder({ execute: jest.fn().mockResolvedValue({ affected: 0 }) }),
            );
            await expect(
                makeRepo().setAttention('r1', ATTENTION_REASON_QUEUED_TOO_LONG),
            ).resolves.toBe(false);
        });

        it('clears the flag unguarded — a resolved run must always be clearable', async () => {
            await expect(makeRepo().setAttention('r1', null)).resolves.toBe(true);
            expect(repository.update).toHaveBeenCalledWith('r1', {
                attentionReason: null,
                attentionAt: null,
            });
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });
    });

    describe('findQueuedTooLong (M6)', () => {
        it('scans only queued, unflagged rows older than the cutoff', async () => {
            const qb = makeQueryBuilder();
            repository.createQueryBuilder.mockReturnValue(qb);
            const cutoff = new Date('2026-07-25T00:00:00.000Z');

            await makeRepo().findQueuedTooLong(cutoff, 50);

            const where = JSON.stringify(
                (qb as never as { where: jest.Mock }).where.mock.calls.flat(),
            );
            const andWhere = JSON.stringify(
                (qb as never as { andWhere: jest.Mock }).andWhere.mock.calls.flat(),
            );
            expect(where).toContain('queued');
            // "not already flagged" is what keeps the notification one per run.
            expect(andWhere).toContain('attentionReason IS NULL');
            expect(andWhere).toContain('cutoff');
        });
    });

    describe('listSessionsForUser attention filter (M6)', () => {
        it('⭐ unions "the agent asked" with "the platform flagged"', async () => {
            // One filter, both sources: the UI must not have to know the
            // difference to answer "what is waiting on me?".
            const qb = makeQueryBuilder();
            repository.createQueryBuilder.mockReturnValue(qb);

            await makeRepo().listSessionsForUser('u1', { attention: true });

            const andWhere = JSON.stringify(
                (qb as never as { andWhere: jest.Mock }).andWhere.mock.calls.flat(),
            );
            expect(andWhere).toContain('awaitingInput');
            expect(andWhere).toContain('attentionReason IS NOT NULL');
        });

        it('does not narrow at all when the filter is absent', async () => {
            const qb = makeQueryBuilder();
            repository.createQueryBuilder.mockReturnValue(qb);

            await makeRepo().listSessionsForUser('u1', {});

            expect((qb as never as { andWhere: jest.Mock }).andWhere).not.toHaveBeenCalled();
        });
    });

    describe('summarizeForWork spend rollup (M7)', () => {
        it('returns the four original counts alongside the new spend fields', async () => {
            repository.createQueryBuilder.mockReturnValue(
                makeQueryBuilder({
                    getRawOne: jest.fn().mockResolvedValue({
                        running: '2',
                        queued: '1',
                        awaiting: '1',
                        failedLast24h: '3',
                        needsAttention: '2',
                        costCentsTotal: '4200',
                        costCentsLast24h: '900',
                        totalTokens: '150000',
                        totalTokensLast24h: '25000',
                    }),
                }),
            );

            await expect(makeRepo().summarizeForWork('work-1')).resolves.toEqual({
                running: 2,
                queued: 1,
                awaiting: 1,
                failedLast24h: 3,
                needsAttention: 2,
                costCentsTotal: 4200,
                costCentsLast24h: 900,
                totalTokens: 150000,
                totalTokensLast24h: 25000,
            });
        });

        it('⭐ reports 0 (never NaN/null) when a Work has no runs at all', async () => {
            // Postgres SUM over an empty set returns NULL, and a NaN in a
            // spend figure is worse than useless — it is alarming.
            repository.createQueryBuilder.mockReturnValue(
                makeQueryBuilder({ getRawOne: jest.fn().mockResolvedValue(undefined) }),
            );

            const summary = await makeRepo().summarizeForWork('work-1');

            expect(Object.values(summary).every((v) => v === 0)).toBe(true);
        });

        it('coerces a non-numeric driver value to 0 rather than propagating NaN', async () => {
            repository.createQueryBuilder.mockReturnValue(
                makeQueryBuilder({
                    getRawOne: jest.fn().mockResolvedValue({ costCentsTotal: 'not-a-number' }),
                }),
            );
            const summary = await makeRepo().summarizeForWork('work-1');
            expect(summary.costCentsTotal).toBe(0);
        });
    });
});
