import { TaskStatus } from '../../entities/task.entity';

import { TaskWorkspaceService } from '../task-workspace.service';
import type {
    AppWorkChangeGate,
    AppWorkChangeGateInput,
    AppWorkChangeGateVerdict,
    AppWorkChangePathsInput,
} from '../app-work-change-gate.port';

/**
 * APW-08 — `tasks.branchGuardRefusal`, the persisted marker for a refusal on
 * the Task's PRIMARY branch.
 *
 * Before it, a refusal only posted a thread message and blocked the Task, and
 * `branchState` deliberately stays as it was (the branch really is pushed). So
 * the branch panel kept showing the primary pull request as an ordinary open
 * one — a `pr-open` pill and a plain link — for a pull request that now
 * carries a change the Work's rules refuse. Nothing on the row told a guard
 * refusal apart from any other reason a Task is blocked.
 *
 * The rules pinned here:
 *
 *  - a refusal of a change that REACHED the remote (the post-push judgement,
 *    and a node reporting a branch that is not the Task's) records the reason
 *    on the row, before the Task is blocked;
 *  - a refusal made BEFORE anything was pushed (the cloud path) changes
 *    nothing on the branch, so it neither writes the marker nor clears one an
 *    earlier refused push left: that change is still on the branch;
 *  - a later judgement of the whole branch that ALLOWS it clears the marker,
 *    and so does discarding the branch;
 *  - no other Work kind, and no App Work without a marker, pays a write.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const HEAD_SHA = 'h'.repeat(40);
const CLOUD_PUSH_ENV = 'APP_WORKS_CLOUD_PUSH_ENABLED';

type Mocks = ReturnType<typeof mocks>;

function mocks() {
    return {
        updateById: jest.fn(async (_id: string, _fields: Record<string, unknown>) => undefined),
        findByIdTask: jest.fn(async () => ({ id: TASK_ID, status: 'in_progress' })),
        findByIdAndUser: jest.fn(async (): Promise<Record<string, unknown> | null> => null),
        transition: jest.fn(async (_task: unknown, _to: unknown, _opts: unknown) => undefined),
        post: jest.fn(async (_userId: string, _message: { body: string }) => undefined),
        getRepository: jest.fn(async () => ({ defaultBranch: 'production' })),
        deleteBranch: jest.fn(async () => undefined),
        simulateMerge: jest.fn(async () => ({ clean: true, conflictPaths: [] })),
        finalize: jest.fn(
            async (
                _handle: unknown,
                opts: { commitMessage: string; push: boolean; publishSha?: string },
            ) => ({
                empty: false,
                changedFiles: 1,
                pushed: opts.push,
                headSha: opts.publishSha ?? HEAD_SHA,
            }),
        ),
        branchChanges: jest.fn(async () => ({ paths: ['src/app.ts'], contents: {} })),
        createPullRequest: jest.fn(async () => ({ number: 7, url: 'https://example.test/pr/7' })),
        evaluate: jest.fn(
            async (_input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict> => ({
                allowed: true,
                note: null,
            }),
        ),
        checkPaths: jest.fn(
            async (_input: AppWorkChangePathsInput): Promise<AppWorkChangeGateVerdict> => ({
                allowed: true,
                note: null,
            }),
        ),
    };
}

function refused(paths: string[] = ['infra/main.tf']): AppWorkChangeGateVerdict {
    return {
        allowed: false,
        message: 'This change edits paths this Work protects, which an agent may not change.',
        paths,
    };
}

function work(kind = 'app') {
    return {
        id: WORK_ID,
        kind,
        gitProvider: 'github',
        taskIsolationBaseBranch: 'production',
        getRepoOwner: (role?: string) => (role === 'website' ? 'acme' : 'acme-data'),
        getDataRepo: () => 'their-app-data',
        getWebsiteRepo: () => 'their-app',
    };
}

function task(overrides: Record<string, unknown> = {}) {
    return {
        id: TASK_ID,
        userId: 'u-1',
        workId: WORK_ID,
        slug: 'add-a-thing',
        labels: [] as string[],
        branchRef: 'ever-works/task/add-a-thing',
        ...overrides,
    };
}

function service(m: Mocks, opts: { bound?: boolean; kind?: string } = {}) {
    const gate: AppWorkChangeGate = { evaluate: m.evaluate, checkPaths: m.checkPaths };
    return new TaskWorkspaceService(
        { findById: jest.fn(async () => work(opts.kind ?? 'app')) } as never, // works
        {
            updateById: m.updateById,
            findById: m.findByIdTask,
            findByIdAndUser: m.findByIdAndUser,
        } as never, // tasks
        {} as never, // runs
        {
            finalize: m.finalize,
            simulateMerge: m.simulateMerge,
            branchChanges: m.branchChanges,
        } as never, // workspaceFacade
        {
            getRepository: m.getRepository,
            createPullRequest: m.createPullRequest,
            deleteBranch: m.deleteBranch,
        } as never, // gitFacade
        { transition: m.transition } as never, // transitions
        { post: m.post } as never, // taskChat
        undefined as never, // mergePolicy
        undefined as never, // activityLog
        undefined as never, // agentRepoAttachments
        undefined as never, // repoConnections
        opts.bound === false ? (undefined as never) : gate,
    );
}

function pushInput(
    taskOverrides: Record<string, unknown> = {},
    branch = 'ever-works/task/add-a-thing',
) {
    return {
        task: task(taskOverrides),
        userId: 'u-1',
        agentId: 'a-1',
        agentCanOpenPullRequests: true,
        branch,
        headSha: 'c'.repeat(40),
        baseSha: 'f'.repeat(40),
    } as never;
}

function runInput(taskOverrides: Record<string, unknown> = {}) {
    return {
        task: task(taskOverrides),
        userId: 'u-1',
        agentId: 'a-1',
        agentCanOpenPullRequests: true,
        workspace: {
            cwd: '/tmp/ws',
            baseSha: 'b'.repeat(40),
            reused: false,
            branch: 'ever-works/task/add-a-thing',
        },
    } as never;
}

function withCloudPush(value: string | undefined): void {
    let saved: string | undefined;
    beforeEach(() => {
        saved = process.env[CLOUD_PUSH_ENV];
        if (value === undefined) delete process.env[CLOUD_PUSH_ENV];
        else process.env[CLOUD_PUSH_ENV] = value;
    });
    afterEach(() => {
        if (saved === undefined) delete process.env[CLOUD_PUSH_ENV];
        else process.env[CLOUD_PUSH_ENV] = saved;
    });
}

const OPEN_PR = { prNumber: 12, prUrl: 'https://example.test/pr/12' };
const EARLIER = 'An earlier refusal: `.github/workflows/ci.yml` is protected.';

/** Every `branchGuardRefusal` value written, in order — only the writes that carry the field. */
const markerWrites = (m: Mocks) =>
    m.updateById.mock.calls
        .filter((call) => Object.prototype.hasOwnProperty.call(call[1], 'branchGuardRefusal'))
        .map((call) => (call[1] as { branchGuardRefusal: string | null }).branchGuardRefusal);
const markerWriteOrder = (m: Mocks) =>
    m.updateById.mock.invocationCallOrder[
        m.updateById.mock.calls.findIndex((call) =>
            Object.prototype.hasOwnProperty.call(call[1], 'branchGuardRefusal'),
        )
    ];
const bodyOf = (m: Mocks, n = 0) => String(m.post.mock.calls[n]?.[1]?.body ?? '');
const blockedAt = (m: Mocks) =>
    m.transition.mock.invocationCallOrder[
        m.transition.mock.calls.findIndex((call) => call[1] === TaskStatus.BLOCKED)
    ];

describe('a refused change that reached the remote is recorded on the Task', () => {
    it('records the reason the thread gives, before the Task is blocked', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(markerWrites(m)).toEqual([bodyOf(m)]);
        expect(bodyOf(m)).toContain('infra/main.tf');
        // `transitionTask` re-reads the row: the marker must already be on it.
        expect(markerWriteOrder(m)).toBeLessThan(blockedAt(m));
    });

    it('says the OPEN pull request carries the refused change', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        await service(m).finalizeRemotePush(pushInput(OPEN_PR));

        expect(markerWrites(m)).toHaveLength(1);
        expect(markerWrites(m)[0]).toContain('pull request #12 now contains this change');
    });

    it('records a node that reports a branch which is not the Task’s own', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(pushInput(OPEN_PR, 'innocuous'));

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard', prNumber: 12 });
        expect(markerWrites(m)).toEqual([bodyOf(m)]);
        expect(markerWrites(m)[0]).toContain('`innocuous`');
    });

    it('records the mismatch — not a judgement of the other branch — on those paths with no pull request open', async () => {
        const m = mocks();
        // Would refuse whatever it were asked about: the reported branch must
        // not be judged in the Task's name at all.
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).judgeAppWorkBranch({
            task: task() as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: 'innocuous',
        });

        expect(outcome).toEqual({ outcome: 'blocked-by-guard' });
        expect(m.evaluate).not.toHaveBeenCalled();
        expect(markerWrites(m)).toEqual([bodyOf(m)]);
        expect(markerWrites(m)[0]).toContain('`innocuous`');
        expect(markerWrites(m)[0]).toContain('`ever-works/task/add-a-thing`');
    });

    it('records a refused head on the question and failure paths', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).judgeAppWorkBranch({
            task: task(OPEN_PR) as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: null,
        });

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard', prNumber: 12 });
        expect(markerWrites(m)).toEqual([bodyOf(m)]);
    });

    describe('on the cloud path, cloud pushes enabled', () => {
        withCloudPush('true');

        it('records the post-push refusal too', async () => {
            const m = mocks();
            m.evaluate.mockResolvedValue(refused());

            const outcome = await service(m).finalizeRun(runInput());

            expect(outcome.outcome).toBe('blocked-by-guard');
            expect(markerWrites(m)).toEqual([bodyOf(m)]);
            expect(markerWrites(m)[0]).toContain('The branch was pushed');
        });
    });

    it('caps what it stores — the thread keeps the whole message', async () => {
        const m = mocks();
        const many = Array.from({ length: 400 }, (_v, i) => `packages/module-${i}/infra/main.tf`);
        m.evaluate.mockResolvedValue(refused(many));

        await service(m).finalizeRemotePush(pushInput());

        const [stored] = markerWrites(m) as string[];
        expect(bodyOf(m).length).toBeGreaterThan(4000);
        expect(stored.length).toBeLessThanOrEqual(4000);
        expect(stored.endsWith('…')).toBe(true);
        expect(bodyOf(m).startsWith(stored.slice(0, -1))).toBe(true);
    });

    it('never cuts a character in half when it caps', async () => {
        const m = mocks();
        // The surrogate pair straddles the cut: 3,998 characters, then 😀.
        m.evaluate.mockResolvedValue({
            allowed: false,
            message: `${'x'.repeat(3998)}😀${'y'.repeat(100)}`,
            paths: [],
        });

        await service(m).finalizeRemotePush(pushInput());

        expect(markerWrites(m)).toEqual([`${'x'.repeat(3998)}…`]);
    });

    it('still posts and blocks when the marker cannot be written', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());
        m.updateById.mockImplementation(async (_id, fields) => {
            if ('branchGuardRefusal' in fields) throw new Error('db down');
            return undefined;
        });

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(bodyOf(m)).toContain('infra/main.tf');
        expect(blockedAt(m)).toBeDefined();
    });
});

describe('a refusal made before anything was pushed changes nothing on the branch', () => {
    describe('cloud App Work pushes off', () => {
        withCloudPush(undefined);

        it('writes no marker', async () => {
            const m = mocks();

            const outcome = await service(m).finalizeRun(runInput());

            expect(outcome.outcome).toBe('blocked-by-guard');
            expect(markerWrites(m)).toEqual([]);
        });

        it('keeps the marker an earlier refused push left — that change is still on the branch', async () => {
            const m = mocks();

            await service(m).finalizeRun(runInput({ ...OPEN_PR, branchGuardRefusal: EARLIER }));

            expect(bodyOf(m)).toContain('pull request #12 does not contain');
            expect(markerWrites(m)).toEqual([]);
        });
    });

    describe('cloud App Work pushes on, refused before the push', () => {
        withCloudPush('true');

        it('writes no marker and clears none', async () => {
            const m = mocks();
            m.checkPaths.mockResolvedValue(refused(['.github/workflows/ci.yml']));

            const outcome = await service(m).finalizeRun(
                runInput({ ...OPEN_PR, branchGuardRefusal: EARLIER }),
            );

            expect(outcome.outcome).toBe('blocked-by-guard');
            expect(bodyOf(m)).toContain('Nothing was pushed');
            expect(markerWrites(m)).toEqual([]);
        });
    });
});

describe('a later judgement that allows the whole branch clears the marker', () => {
    it('on the idempotent push onto the open pull request', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(
            pushInput({ ...OPEN_PR, branchGuardRefusal: EARLIER }),
        );

        expect(outcome).toEqual({
            outcome: 'pr-opened',
            prNumber: 12,
            prUrl: 'https://example.test/pr/12',
        });
        expect(markerWrites(m)).toEqual([null]);
    });

    it('before the pull request is opened', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(
            pushInput({ branchGuardRefusal: EARLIER }),
        );

        expect(outcome.outcome).toBe('pr-opened');
        expect(markerWrites(m)).toEqual([null]);
        expect(markerWriteOrder(m)).toBeLessThan(m.createPullRequest.mock.invocationCallOrder[0]);
    });

    it('on the question and failure paths', async () => {
        const m = mocks();

        const outcome = await service(m).judgeAppWorkBranch({
            task: task({ ...OPEN_PR, branchGuardRefusal: EARLIER }) as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: null,
        });

        expect(outcome).toBeNull();
        expect(markerWrites(m)).toEqual([null]);
    });

    describe('on the cloud path', () => {
        withCloudPush('true');

        it('after the post-push judgement allows it', async () => {
            const m = mocks();

            const outcome = await service(m).finalizeRun(runInput({ branchGuardRefusal: EARLIER }));

            expect(outcome.outcome).toBe('pr-opened');
            expect(markerWrites(m)).toEqual([null]);
        });
    });

    it('replaces, never clears, when the allowed head is followed by a mismatched report', async () => {
        const m = mocks();

        await service(m).judgeAppWorkBranch({
            task: task({ ...OPEN_PR, branchGuardRefusal: EARLIER }) as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: 'innocuous',
        });

        const writes = markerWrites(m);
        expect(writes[writes.length - 1]).toContain('`innocuous`');
    });
});

describe('nobody else pays for it', () => {
    it('writes nothing when an App Work Task carries no marker and the change is allowed', async () => {
        const m = mocks();

        await service(m).finalizeRemotePush(pushInput(OPEN_PR));
        await service(m).finalizeRemotePush(pushInput());

        expect(markerWrites(m)).toEqual([]);
    });

    it('never writes the marker for another Work kind', async () => {
        const m = mocks();

        await service(m, { kind: 'directory' }).finalizeRemotePush(
            pushInput({ ...OPEN_PR, branchGuardRefusal: EARLIER }),
        );
        await service(m, { kind: 'directory' }).finalizeRemotePush(pushInput({}, 'another-branch'));

        expect(markerWrites(m)).toEqual([]);
    });

    it('never writes it for an App Work with no gate bound', async () => {
        const m = mocks();

        await service(m, { bound: false }).finalizeRemotePush(
            pushInput({ branchGuardRefusal: EARLIER }),
        );

        expect(markerWrites(m)).toEqual([]);
    });
});

describe('discarding the branch clears the marker with it', () => {
    it('clears it in the same patch as the primary reset', async () => {
        const m = mocks();
        m.findByIdAndUser.mockResolvedValue(task({ ...OPEN_PR, branchGuardRefusal: EARLIER }));

        await service(m).discardBranch('u-1', TASK_ID);

        expect(m.updateById).toHaveBeenCalledWith(
            TASK_ID,
            expect.objectContaining({
                branchRef: null,
                branchState: 'discarded',
                branchGuardRefusal: null,
            }),
        );
    });

    it('adds nothing to the patch when there is no marker', async () => {
        const m = mocks();
        m.findByIdAndUser.mockResolvedValue(task(OPEN_PR));

        await service(m).discardBranch('u-1', TASK_ID);

        expect(m.updateById).toHaveBeenCalledWith(
            TASK_ID,
            expect.objectContaining({ branchState: 'discarded' }),
        );
        expect(markerWrites(m)).toEqual([]);
    });
});
