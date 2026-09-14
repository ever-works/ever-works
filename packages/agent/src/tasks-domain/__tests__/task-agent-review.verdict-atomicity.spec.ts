import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/database.config';
import { TaskAgentReview } from '../../entities/task-agent-review.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskAgentReviewRepository } from '../../database/repositories/task-agent-review.repository';
import { TaskApproverRepository } from '../../database/repositories/task-side.repositories';
import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { agentReviewRunScope } from '../task-agent-review';

/**
 * Reviewer agent stage — A VERDICT IS PERSISTED ATOMICALLY
 * (Greptile P1-B on PR #2419).
 *
 * The finding: `submitVerdict` settled the review ledger row (CAS →
 * terminal) and only THEN wrote the approver row, as two independent
 * statements. If the approver write threw, the review was already terminal
 * and no retry could ever record the verdict; if the approver write matched
 * no row, its result was ignored and the tool reported `recorded` while the
 * approver stayed `pending`.
 *
 * Pinned against a REAL better-sqlite3 schema and the REAL repositories:
 * the approver write is made to throw by a database trigger (a genuine
 * statement failure inside the transaction, not a mocked rejection), and
 * made to match no row by removing / re-typing the row between the
 * service's read and its write. Physical approver writes are counted by a
 * second trigger, so "written exactly once" is measured, not inferred.
 */

const TASK_ID = '5f0e8a1b-3c2d-4e6f-8a9b-0c1d2e3f4a50';
const REVIEWER = '1a2b3c4d-5e6f-4a0b-9c8d-7e6f5a4b3c21';
const OTHER_AGENT = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d62';
const IMPLEMENTER = '2b3c4d5e-6f7a-4b1c-8d9e-0f1a2b3c4d53';
const REVIEW_RUN = '3c4d5e6f-7a8b-4c2d-9e0f-1a2b3c4d5e64';
const HEAD = 'a'.repeat(40);

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeTask(): Task {
    return {
        id: TASK_ID,
        slug: 'T-7',
        title: 'Review me',
        userId: 'user-1',
        status: TaskStatus.IN_REVIEW,
        workId: 'work-1',
        prNumber: 42,
        prHeadSha: HEAD,
        agentId: null,
    } as unknown as Task;
}

interface World {
    dataSource: DataSource;
    reviews: TaskAgentReviewRepository;
    approvers: TaskApproverRepository;
    service: TaskAgentReviewService;
    approverRowId: string;
    reviewId: string;
}

async function world(): Promise<World> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
    });
    await dataSource.initialize();
    await dataSource.query('PRAGMA foreign_keys = OFF');
    const reviews = new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview));
    const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));

    const approverRow = await approvers.add(TASK_ID, 'agent', REVIEWER);
    // An OPEN review, written the way the dispatch writes one, bound to its
    // run before anything could answer it.
    const review = await dataSource.getRepository(TaskAgentReview).save({
        taskId: TASK_ID,
        reviewerAgentId: REVIEWER,
        approverId: approverRow.id,
        claimKey: `agent-review:${REVIEWER}:${HEAD}`,
        headSha: HEAD,
        slot: 0,
        state: 'dispatched',
    } as any);
    await reviews.bindRun(review.id, REVIEW_RUN);

    const runRows = [
        {
            id: REVIEW_RUN,
            agentId: REVIEWER,
            taskId: TASK_ID,
            delegationScope: agentReviewRunScope(),
        },
        { id: 'run-impl', agentId: IMPLEMENTER, taskId: TASK_ID, delegationScope: null },
    ];
    const service = new TaskAgentReviewService(
        { findById: jest.fn(async () => makeTask()) } as any,
        reviews,
        approvers,
        {
            findById: jest.fn(async () => ({
                id: 'work-1',
                gitProvider: 'github',
                getRepoOwner: () => 'ever-works',
                getDataRepo: () => 'ever-works',
            })),
        } as any,
        { findAgentAssignees: jest.fn(async () => []) } as any,
        {
            findById: jest.fn(async (id: string) => runRows.find((row) => row.id === id) ?? null),
            findByIds: jest.fn(async (ids: string[]) =>
                runRows.filter((row) => ids.includes(row.id)),
            ),
            findAuthorAgentIdsForTask: jest.fn(async (_taskId: string, exclude: string[] = []) => [
                ...new Set(
                    runRows.filter((row) => !exclude.includes(row.id)).map((row) => row.agentId),
                ),
            ]),
        } as any,
        { findById: jest.fn(async (id: string) => ({ id, userId: 'user-1', slug: id })) } as any,
        {
            getPullRequestStatus: jest.fn(async () => ({
                number: 42,
                state: 'open',
                merged: false,
                headSha: HEAD,
                ciState: 'passing',
                checks: [],
            })),
        } as any,
    );
    return {
        dataSource,
        reviews,
        approvers,
        service,
        approverRowId: approverRow.id,
        reviewId: review.id,
    };
}

const approve = {
    runId: REVIEW_RUN,
    taskId: TASK_ID,
    reviewerAgentId: REVIEWER,
    verdict: 'approve',
};

async function reviewRow(w: World) {
    return w.dataSource.getRepository(TaskAgentReview).findOneOrFail({ where: { id: w.reviewId } });
}

async function approverRow(w: World) {
    return w.dataSource.getRepository(TaskApprover).findOne({ where: { id: w.approverRowId } });
}

describe('a verdict and its approver row commit together — real schema (Greptile P1-B)', () => {
    let w: World;

    beforeEach(async () => {
        w = await world();
    });

    afterEach(async () => {
        if (w?.dataSource.isInitialized) await w.dataSource.destroy();
    });

    it('an approver write that THROWS leaves the review OPEN — and the verdict is recorded on retry', async () => {
        await w.dataSource.query(
            `CREATE TRIGGER approver_store_down BEFORE UPDATE ON task_approvers
             BEGIN SELECT RAISE(ABORT, 'approver store down'); END`,
        );

        const failed = await w.service.submitVerdict(approve);
        expect(failed.reason).not.toBe('recorded');
        expect(failed).toEqual({ reason: 'error' });
        // Rolled back as a whole: the review never left `dispatched`, so the
        // run that holds it can still answer it, and nothing was approved.
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched', decidedAt: null });
        expect(await w.reviews.findOpenForRun(REVIEW_RUN)).not.toBeNull();
        expect(await approverRow(w)).toMatchObject({ approvalState: 'pending', decidedVia: null });

        // The store recovers; the reviewer calls the tool again.
        await w.dataSource.query('DROP TRIGGER approver_store_down');
        expect(await w.service.submitVerdict(approve)).toEqual({
            reason: 'recorded',
            verdict: 'approve',
            approverId: w.approverRowId,
            headSha: HEAD,
        });
        expect(await reviewRow(w)).toMatchObject({ state: 'approved' });
        expect(await approverRow(w)).toMatchObject({
            approvalState: 'approved',
            decidedVia: 'agent-review',
            decidedByRunId: REVIEW_RUN,
            decidedHeadSha: HEAD,
        });
    });

    it('an approver row REMOVED between the read and the write is not reported recorded, and the review stays open', async () => {
        const read = w.approvers.findByTaskId.bind(w.approvers);
        w.approvers.findByTaskId = async (taskId: string) => {
            const rows = await read(taskId);
            // The reviewer is detached right after the service looked.
            await w.dataSource.getRepository(TaskApprover).delete({ id: w.approverRowId });
            return rows;
        };

        const result = await w.service.submitVerdict(approve);
        expect(result.reason).not.toBe('recorded');
        expect(result).toEqual({ reason: 'approver-not-written', headSha: HEAD });
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched' });
        expect(await w.reviews.findOpenForRun(REVIEW_RUN)).not.toBeNull();

        // A retry re-reads, finds the approver gone, and closes the review
        // with the ordinary refusal — recoverable, and still nothing approved.
        w.approvers.findByTaskId = read;
        expect(await w.service.submitVerdict(approve)).toEqual({ reason: 'approver-missing' });
        expect(await reviewRow(w)).toMatchObject({
            state: 'refused',
            refusalCode: 'approver-missing',
        });
    });

    it('an approver row RE-ASSIGNED to another agent between the read and the write is not written', async () => {
        const read = w.approvers.findByTaskId.bind(w.approvers);
        w.approvers.findByTaskId = async (taskId: string) => {
            const rows = await read(taskId);
            await w.dataSource
                .getRepository(TaskApprover)
                .update({ id: w.approverRowId }, { approverId: OTHER_AGENT });
            return rows;
        };

        expect(await w.service.submitVerdict(approve)).toEqual({
            reason: 'approver-not-written',
            headSha: HEAD,
        });
        // The other agent's row is untouched, and the review is still open.
        expect(await approverRow(w)).toMatchObject({
            approverId: OTHER_AGENT,
            approvalState: 'pending',
            decidedVia: null,
        });
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched' });
    });

    it('an approver row decided by someone else AFTER the in-transaction read makes the write affect 0 rows — not recorded, nothing written, the review open for a retry', async () => {
        // The window step 4's compare-and-set exists for. The two tests above
        // change the row BEFORE the transaction opens, so the transaction's
        // own read (step 2) already refuses and the `affected !== 1` check is
        // never reached. On Postgres a concurrent writer can commit between
        // that read and the approver UPDATE; the UPDATE then matches no row,
        // and without the check the verdict would be reported `recorded`
        // with no approver written.
        //
        // Reproduced with the real SQL: the transaction's own approver
        // repository is wrapped so that, when the verdict issues its UPDATE,
        // a human's decision is written to the row first (a genuine
        // statement on the transaction's connection), and then the verdict's
        // real UPDATE runs unchanged and genuinely affects 0 rows.
        const before = await approverRow(w);
        expect(before).toMatchObject({
            approverId: REVIEWER,
            approvalState: 'pending',
            decidedVia: null,
        });

        const manager = w.dataSource.manager as any;
        const transaction = manager.transaction.bind(manager);
        const seen = { readInTransaction: undefined as unknown, writes: [] as number[] };
        manager.transaction = (work: (inner: any) => Promise<unknown>) =>
            transaction(async (inner: any) => {
                const approvers = inner.getRepository(TaskApprover);
                const findOne = approvers.findOne.bind(approvers);
                const update = approvers.update.bind(approvers);
                approvers.findOne = async (options: unknown) => {
                    const row = await findOne(options);
                    seen.readInTransaction = row;
                    return row;
                };
                approvers.update = async (criteria: unknown, patch: unknown) => {
                    // A person rejects the Task between the read and the write.
                    await inner
                        .createQueryBuilder()
                        .update(TaskApprover)
                        .set({
                            approvalState: 'rejected',
                            approvedAt: new Date(),
                            decidedVia: 'user',
                        })
                        .where({ id: w.approverRowId })
                        .execute();
                    const result = await update(criteria, patch);
                    seen.writes.push(result.affected);
                    return result;
                };
                return work(inner);
            });

        const result = await w.service.submitVerdict(approve).finally(() => {
            manager.transaction = transaction;
        });

        // The in-transaction read succeeded, and the verdict's real UPDATE ran
        // exactly once and matched no row.
        expect(seen.readInTransaction).toMatchObject({
            id: w.approverRowId,
            approverId: REVIEWER,
            approvalState: 'pending',
        });
        expect(seen.writes).toEqual([0]);

        expect(result.reason).not.toBe('recorded');
        expect(result).toEqual({ reason: 'approver-not-written', headSha: HEAD });
        // Nothing of the verdict reached the approver row. (On better-sqlite3
        // the interleaved decision ran on the transaction's one connection,
        // so the rollback erases it too and the row is exactly as it was.)
        expect(await approverRow(w)).toEqual(before);
        // The review never left `dispatched`, so the run can answer it again.
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched', decidedAt: null });
        expect(await w.reviews.findOpenForRun(REVIEW_RUN)).not.toBeNull();

        // Nobody interleaves this time: the retry records the verdict.
        expect(await w.service.submitVerdict(approve)).toEqual({
            reason: 'recorded',
            verdict: 'approve',
            approverId: w.approverRowId,
            headSha: HEAD,
        });
        expect(await reviewRow(w)).toMatchObject({ state: 'approved' });
        expect(await approverRow(w)).toMatchObject({
            approvalState: 'approved',
            decidedVia: 'agent-review',
            decidedByRunId: REVIEW_RUN,
            decidedHeadSha: HEAD,
        });
    });

    it('a DOUBLE tool call writes the approver row exactly once — sequential and concurrent', async () => {
        await w.dataSource.query('CREATE TABLE approver_writes (n INTEGER)');
        await w.dataSource.query(
            `CREATE TRIGGER count_approver_write AFTER UPDATE ON task_approvers
             BEGIN INSERT INTO approver_writes (n) VALUES (1); END`,
        );
        const writes = async () =>
            Number((await w.dataSource.query('SELECT COUNT(*) AS c FROM approver_writes'))[0].c);

        const results = await Promise.all([
            w.service.submitVerdict(approve),
            w.service.submitVerdict(approve),
        ]);
        expect(results.map((result) => result.reason).sort()).toEqual([
            'no-open-review',
            'recorded',
        ]);
        expect(await writes()).toBe(1);

        expect(await w.service.submitVerdict(approve)).toEqual({ reason: 'no-open-review' });
        expect(await writes()).toBe(1);
        expect(await approverRow(w)).toMatchObject({ approvalState: 'approved' });
    });
});

describe('TaskAgentReviewRepository.recordVerdict — the transaction itself, real schema', () => {
    let w: World;

    beforeEach(async () => {
        w = await world();
    });

    afterEach(async () => {
        if (w?.dataSource.isInitialized) await w.dataSource.destroy();
    });

    const write = (over: Record<string, unknown> = {}) => ({
        reviewId: '',
        state: 'changes-requested' as const,
        summary: 'the null check is inverted',
        approver: {
            id: '',
            taskId: TASK_ID,
            reviewerAgentId: REVIEWER,
            approvalState: 'rejected' as const,
            decidedByRunId: REVIEW_RUN,
            decidedHeadSha: HEAD,
        },
        ...over,
    });

    it('records both halves, stamped agent-review', async () => {
        const input = write();
        input.reviewId = w.reviewId;
        input.approver.id = w.approverRowId;
        expect(await w.reviews.recordVerdict(input)).toBe('recorded');
        expect(await reviewRow(w)).toMatchObject({
            state: 'changes-requested',
            summary: 'the null check is inverted',
        });
        expect(await approverRow(w)).toMatchObject({
            approvalState: 'rejected',
            decidedVia: 'agent-review',
            decidedHeadSha: HEAD,
        });
        // A second write for the same review is refused and changes nothing.
        expect(await w.reviews.recordVerdict({ ...input, state: 'approved' })).toBe(
            'review-not-open',
        );
        expect(await reviewRow(w)).toMatchObject({ state: 'changes-requested' });
    });

    it('rolls the review transition back when the approver write throws', async () => {
        await w.dataSource.query(
            `CREATE TRIGGER approver_store_down BEFORE UPDATE ON task_approvers
             BEGIN SELECT RAISE(ABORT, 'approver store down'); END`,
        );
        const input = write();
        input.reviewId = w.reviewId;
        input.approver.id = w.approverRowId;
        await expect(w.reviews.recordVerdict(input)).rejects.toThrow('approver store down');
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched', summary: null });
    });

    it('rolls the review transition back when the approver write matches no row', async () => {
        for (const approver of [
            { id: '00000000-0000-4000-8000-00000000dead' },
            { reviewerAgentId: OTHER_AGENT },
            { taskId: 'another-task' },
        ]) {
            const input = write();
            input.reviewId = w.reviewId;
            input.approver = { ...input.approver, id: w.approverRowId, ...approver };
            expect(await w.reviews.recordVerdict(input)).toBe('approver-not-written');
            expect(await reviewRow(w)).toMatchObject({ state: 'dispatched', summary: null });
            expect(await approverRow(w)).toMatchObject({ approvalState: 'pending' });
        }
    });
});

describe('an OLDER verdict never overwrites a NEWER one — real schema (review of P1-B)', () => {
    let w: World;
    const HEAD_B = 'b'.repeat(40);
    const REVIEW_RUN_B = '4d5e6f7a-8b9c-4d3e-8f0a-2b3c4d5e6f75';

    beforeEach(async () => {
        w = await world();
    });

    afterEach(async () => {
        if (w?.dataSource.isInitialized) await w.dataSource.destroy();
    });

    /** A second open review of the same approver, claimed AFTER the first. */
    async function newerReview(): Promise<string> {
        const review = await w.dataSource.getRepository(TaskAgentReview).save({
            taskId: TASK_ID,
            reviewerAgentId: REVIEWER,
            approverId: w.approverRowId,
            claimKey: `agent-review:${REVIEWER}:${HEAD_B}`,
            headSha: HEAD_B,
            slot: 1,
            state: 'dispatched',
        } as any);
        await w.reviews.bindRun(review.id, REVIEW_RUN_B);
        return review.id;
    }

    const verdictFor = (reviewId: string, head: string, runId: string) => ({
        reviewId,
        state: 'approved' as const,
        summary: null,
        approver: {
            id: w.approverRowId,
            taskId: TASK_ID,
            reviewerAgentId: REVIEWER,
            approvalState: 'approved' as const,
            decidedByRunId: runId,
            decidedHeadSha: head,
        },
    });

    it('the newer review answered first: the older verdict is `superseded`, writes nothing, and leaves its review open', async () => {
        const newer = await newerReview();
        expect(await w.reviews.recordVerdict(verdictFor(newer, HEAD_B, REVIEW_RUN_B))).toBe(
            'recorded',
        );

        expect(await w.reviews.recordVerdict(verdictFor(w.reviewId, HEAD, REVIEW_RUN))).toBe(
            'superseded',
        );
        expect(await approverRow(w)).toMatchObject({
            approvalState: 'approved',
            decidedHeadSha: HEAD_B,
            decidedByRunId: REVIEW_RUN_B,
        });
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched' });
    });

    it('control: the older review answered first — the newer verdict still replaces it', async () => {
        const newer = await newerReview();
        expect(await w.reviews.recordVerdict(verdictFor(w.reviewId, HEAD, REVIEW_RUN))).toBe(
            'recorded',
        );
        expect(await w.reviews.recordVerdict(verdictFor(newer, HEAD_B, REVIEW_RUN_B))).toBe(
            'recorded',
        );
        expect(await approverRow(w)).toMatchObject({ decidedHeadSha: HEAD_B });
    });

    it('through the service: a lagging live read lets the older verdict reach the write, which refuses it as stale', async () => {
        const newer = await newerReview();
        await w.reviews.recordVerdict(verdictFor(newer, HEAD_B, REVIEW_RUN_B));

        // The provider replica this read hits still reports A.
        expect(await w.service.submitVerdict(approve)).toEqual({
            reason: 'stale-head',
            headSha: HEAD,
        });
        expect(await approverRow(w)).toMatchObject({
            approvalState: 'approved',
            decidedHeadSha: HEAD_B,
        });
        expect(await reviewRow(w)).toMatchObject({ state: 'refused', refusalCode: 'superseded' });
    });
});

describe('the review stage’s writes never join an open verdict transaction — better-sqlite3 (review of P1-B)', () => {
    let w: World;

    beforeEach(async () => {
        w = await world();
    });

    afterEach(async () => {
        if (w?.dataSource.isInitialized) await w.dataSource.destroy();
    });

    it('a claim issued while a verdict transaction is open — and then rolls back — is still persisted', async () => {
        // TypeORM's better-sqlite3 driver shares ONE query runner across the
        // DataSource: an autocommit INSERT issued while a transaction is open
        // runs INSIDE it. The claim used to report `claimed` (its own re-read
        // saw the uncommitted row) and then vanish with the verdict's
        // rollback, leaving the planner dispatching a review with no ledger
        // row and freeing its budget slot for another planner.
        const manager = w.dataSource.manager as any;
        const transaction = manager.transaction.bind(manager);
        let opened!: () => void;
        const isOpen = new Promise<void>((resolve) => {
            opened = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        manager.transaction = (work: (inner: unknown) => Promise<unknown>) =>
            transaction(async (inner: unknown) => {
                opened();
                await gate;
                return work(inner);
            });

        // A verdict that will roll back: the approver row names another agent.
        const verdict = w.reviews.recordVerdict({
            reviewId: w.reviewId,
            state: 'approved',
            summary: null,
            approver: {
                id: w.approverRowId,
                taskId: TASK_ID,
                reviewerAgentId: OTHER_AGENT,
                approvalState: 'approved',
                decidedByRunId: REVIEW_RUN,
                decidedHeadSha: HEAD,
            },
        });
        await isOpen;

        const claimKey = `agent-review:${OTHER_AGENT}:${'c'.repeat(40)}`;
        const claim = w.reviews.claim({
            taskId: TASK_ID,
            reviewerAgentId: OTHER_AGENT,
            approverId: 'app-other',
            claimKey,
            headSha: 'c'.repeat(40),
            maxRuns: 4,
        });
        // Give the claim every chance to run while the transaction is open.
        await new Promise((resolve) => setTimeout(resolve, 50));
        release();

        expect(await verdict).toBe('approver-not-written');
        expect(await claim).toMatchObject({ outcome: 'claimed', review: { slot: 1 } });
        manager.transaction = transaction;
        expect(await w.reviews.findByClaimKey(TASK_ID, claimKey)).toMatchObject({
            state: 'dispatched',
            slot: 1,
        });
        // …and the verdict's own rollback still happened.
        expect(await reviewRow(w)).toMatchObject({ state: 'dispatched' });
    });
});
