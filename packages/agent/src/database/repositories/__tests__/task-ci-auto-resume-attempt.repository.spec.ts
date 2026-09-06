import { DataSource, Repository } from 'typeorm';
import {
    TaskCiAutoResumeAttempt,
    type TaskAutoResumeTrigger,
} from '../../../entities/task-ci-auto-resume-attempt.entity';
import { TaskCiAutoResumeAttemptRepository } from '../task-ci-auto-resume-attempt.repository';

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — the attempt
 * ledger against a REAL better-sqlite3 schema carrying the REAL unique
 * index, because that index is the only thing standing between one red
 * pull request and a resume storm.
 *
 * Only this one entity is registered: the ledger has no foreign keys (it
 * is the spend record and must outlive a deleted Task), so it needs no
 * other table, and keeping the DataSource this small keeps the suite off
 * the agent-plugins import chain.
 */
describe('TaskCiAutoResumeAttemptRepository (better-sqlite3, real unique index)', () => {
    const TASK = '11111111-1111-4111-8111-111111111111';
    let dataSource: DataSource;
    let rows: Repository<TaskCiAutoResumeAttempt>;
    let attempts: TaskCiAutoResumeAttemptRepository;

    const claim = (claimKey: string, extra: Partial<{ failureKey: string }> = {}) =>
        attempts.claim({
            taskId: TASK,
            trigger: 'ci' as TaskAutoResumeTrigger,
            claimKey,
            headSha: 'a'.repeat(40),
            ...extra,
        });

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [TaskCiAutoResumeAttempt],
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(TaskCiAutoResumeAttempt);
        attempts = new TaskCiAutoResumeAttemptRepository(rows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        jest.restoreAllMocks();
        await rows.clear();
    });

    it('claims a coordinate once and refuses the redelivery', async () => {
        expect(await claim('ci:abc')).not.toBeNull();
        expect(await claim('ci:abc')).toBeNull();
        expect(await attempts.countForTask(TASK)).toBe(1);
    });

    /**
     * THE regression.
     *
     * `claim()` is check-then-insert, so the pre-read absorbs the ordinary
     * redelivery and the UNIQUE INDEX is the real guard — the one that has
     * to hold when two API replicas handle the same delivery in the same
     * instant. That path was never exercised by any test (every existing
     * case short-circuits on the pre-read), and it was broken: the
     * violation matcher compared the driver code to the exact string
     * `SQLITE_CONSTRAINT`, while better-sqlite3 — the driver CI, the e2e
     * stack and every spec in this repo run on — reports the EXTENDED code
     * `SQLITE_CONSTRAINT_UNIQUE`. `claim()` therefore THREW instead of
     * returning null, which `TaskCiAutoResumeService` reports as `error`.
     *
     * Stubbing the pre-read to miss is exactly what losing the race looks
     * like from inside the loser: the row was not there when it looked.
     */
    it('returns null (never throws) when the UNIQUE INDEX is what stops it', async () => {
        expect(await claim('ci:race')).not.toBeNull();
        // The loser of the race: its pre-read ran before the winner's
        // insert committed, so it goes straight at the index.
        jest.spyOn(rows, 'findOne').mockResolvedValueOnce(null);

        await expect(claim('ci:race')).resolves.toBeNull();
        expect(await attempts.countForTask(TASK)).toBe(1);
    });

    it('rethrows anything that is NOT a unique violation — a broken ledger must not read as a lost race', async () => {
        jest.spyOn(rows, 'findOne').mockResolvedValueOnce(null);
        jest.spyOn(rows, 'save').mockRejectedValueOnce(
            Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
        );
        await expect(claim('ci:busy')).rejects.toThrow('database is locked');
    });

    it('counts attempts per Task, and answers the no-progress question', async () => {
        await claim('ci:one', { failureKey: 'f1' });
        await claim('ci:two', { failureKey: 'f2' });
        expect(await attempts.countForTask(TASK)).toBe(2);
        expect(await attempts.hasFailureKey(TASK, 'f1')).toBe(true);
        expect(await attempts.hasFailureKey(TASK, 'nope')).toBe(false);
        // An empty fingerprint is never "already tried".
        expect(await attempts.hasFailureKey(TASK, '')).toBe(false);
    });

    it('caps an oversized claim key at the column width instead of failing the insert', async () => {
        const claimed = await claim(`ci:${'z'.repeat(500)}`);
        expect(claimed!.claimKey).toHaveLength(200);
    });
});
