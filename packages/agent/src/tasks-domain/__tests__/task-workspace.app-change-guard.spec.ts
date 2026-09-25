import { TaskStatus } from '../../entities/task.entity';

import { TaskWorkspaceService } from '../task-workspace.service';
import type {
    AppWorkChangeGate,
    AppWorkChangeGateInput,
    AppWorkChangeGateVerdict,
    AppWorkChangePathsInput,
} from '../app-work-change-gate.port';

/**
 * APW-08 T17 — the change gate, wired into the two finalize paths.
 *
 * `finalizeRun` and `finalizeRemotePush` are the finalize tail for EVERY Work,
 * so most of what matters is what the gate does NOT do: run for a directory
 * Work, run when nothing is bound, or throw.
 *
 * What the gate DECIDES is `app-work-change-gate.service.spec.ts`'s business;
 * this file drives a double through the port and checks what the finalize path
 * does with each answer. The first version of this file hand-built the three
 * App classes instead and stayed green while the real module graph could not
 * construct them — that gap is `tasks-domain.di-contract.spec.ts`'s now.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

type Mocks = ReturnType<typeof mocks>;

function mocks() {
    return {
        updateById: jest.fn(async (_id: string, _fields: Record<string, unknown>) => undefined),
        // `transitionTask` re-reads the Task before transitioning and swallows
        // anything that throws, so a double without `findById` makes the
        // transition silently not happen.
        findByIdTask: jest.fn(async () => ({ id: TASK_ID, status: 'in_progress' })),
        transition: jest.fn(async (_task: unknown, _to: unknown, _opts: unknown) => undefined),
        post: jest.fn(async (_userId: string, _message: { body: string }) => undefined),
        getRepository: jest.fn(async () => ({ defaultBranch: 'production' })),
        simulateMerge: jest.fn(async () => ({ clean: true, conflictPaths: [] })),
        // Echoes what a real provider answers: `pushed` follows `push`, and a
        // publish of an already-committed sha reports that sha as the head.
        finalize: jest.fn(
            async (
                _handle: unknown,
                opts: { commitMessage: string; push: boolean; publishSha?: string },
            ): Promise<{
                empty: boolean;
                changedFiles?: number;
                pushed: boolean;
                headSha: string | null;
                publishWithheld?: string;
            }> => ({
                empty: false,
                changedFiles: 1,
                pushed: opts.push,
                headSha: opts.publishSha ?? HEAD_SHA,
            }),
        ),
        branchChanges: jest.fn(
            async (
                _handle: unknown,
                _opts: { headSha: string; readPaths?: readonly string[] },
                _facadeOptions: unknown,
            ): Promise<{ paths: string[]; contents: Record<string, string | null> }> => ({
                paths: ['src/app.ts'],
                contents: {},
            }),
        ),
        createPullRequest: jest.fn(async () => ({ number: 7, url: 'https://example.test/pr/7' })),
        evaluate: jest.fn(
            async (_input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict> => ({
                allowed: true,
                note: null,
            }),
        ),
        // The fleet paths never ask the pre-write question, and a double that
        // throws makes sure they never start to. Only the cloud path's
        // judge-before-push (`finalizeRun` with cloud pushes enabled) asks it,
        // and those cases answer it explicitly.
        checkPaths: jest.fn(
            async (_input: AppWorkChangePathsInput): Promise<AppWorkChangeGateVerdict> => {
                throw new Error('only the cloud judge-before-push may call checkPaths');
            },
        ),
    };
}

/** The commit the cloud run made locally — what the judge-before-push reads. */
const HEAD_SHA = 'h'.repeat(40);

/**
 * The owner's switch for cloud App Work pushes (default OFF until APW-08 FR-12's
 * admission, T12, lands). Set per describe and always restored.
 */
const CLOUD_PUSH_ENV = 'APP_WORKS_CLOUD_PUSH_ENABLED';
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
        workId: WORK_ID,
        slug: 'add-a-thing',
        labels: [] as string[],
        ...overrides,
    };
}

/**
 * Positional, and the gate is LAST — the file's own arity rule. `bound: false`
 * passes `undefined` there, which is exactly what the eighteen existing
 * construction sites do.
 */
function service(m: Mocks, opts: { bound?: boolean; kind?: string } = {}) {
    const gate: AppWorkChangeGate = {
        evaluate: m.evaluate,
        // Throws by default — see `mocks()`.
        checkPaths: m.checkPaths,
    };

    return new TaskWorkspaceService(
        { findById: jest.fn(async () => work(opts.kind ?? 'app')) } as never, // works
        { updateById: m.updateById, findById: m.findByIdTask } as never, // tasks
        {} as never, // runs
        {
            finalize: m.finalize,
            simulateMerge: m.simulateMerge,
            branchChanges: m.branchChanges,
        } as never, // workspaceFacade
        { getRepository: m.getRepository, createPullRequest: m.createPullRequest } as never, // gitFacade
        { transition: m.transition } as never, // transitions
        { post: m.post } as never, // taskChat
        undefined as never, // mergePolicy
        undefined as never, // activityLog
        undefined as never, // agentRepoAttachments
        undefined as never, // repoConnections
        opts.bound === false ? (undefined as never) : gate,
    );
}

function pushInput(overrides: Record<string, unknown> = {}) {
    return {
        task: task(),
        userId: 'u-1',
        agentId: 'a-1',
        agentCanOpenPullRequests: true,
        branch: 'ever-works/task/add-a-thing',
        headSha: 'c'.repeat(40),
        // Reported by the fleet node. The gate must never see it.
        baseSha: 'f'.repeat(40),
        ...overrides,
    } as never;
}

const bodyOf = (m: Mocks, n = 0) => String(m.post.mock.calls[n]?.[1]?.body ?? '');
const blockedWith = (m: Mocks) =>
    m.transition.mock.calls.some((call) => call[1] === TaskStatus.BLOCKED);

describe('the gate does not touch what it should not', () => {
    it('is not asked for a Work that is not kind `app`', async () => {
        const m = mocks();

        await service(m, { kind: 'directory' }).finalizeRemotePush(pushInput());

        expect(m.evaluate).not.toHaveBeenCalled();
        expect(m.createPullRequest).toHaveBeenCalled();
    });

    it('proceeds when nothing is bound — nothing was promised', async () => {
        const m = mocks();

        await service(m, { bound: false }).finalizeRemotePush(pushInput());

        expect(m.createPullRequest).toHaveBeenCalled();
        // Opening a pull request transitions to `in_review`; what must not
        // happen is a BLOCKED transition.
        expect(blockedWith(m)).toBe(false);
    });

    it('opens the pull request when the gate allows', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('pr-opened');
        expect(m.evaluate).toHaveBeenCalledTimes(1);
        // The fleet path is judged after its push, by the provider's diff; the
        // pre-write question belongs to the tool path and the cloud path only.
        expect(m.checkPaths).not.toHaveBeenCalled();
        expect(m.branchChanges).not.toHaveBeenCalled();
    });
});

describe('what the gate is handed', () => {
    it('never receives a base commit — a fleet-reported baseSha cannot reach it', async () => {
        // The rules are read at a base commit, and on the fleet path the only
        // one available is reported by the machine the agent ran on. The port
        // has no field for it; this pins that nothing smuggles it through.
        const m = mocks();

        await service(m).finalizeRemotePush(pushInput());

        const handed = m.evaluate.mock.calls[0][0] as unknown as Record<string, unknown>;
        expect(handed).not.toHaveProperty('baseSha');
        expect(JSON.stringify(handed)).not.toContain('f'.repeat(40));
    });

    it('targets the App Work’s real repository, not the phantom data repository', async () => {
        const m = mocks();

        await service(m).finalizeRemotePush(pushInput());

        expect(m.evaluate.mock.calls[0][0]).toMatchObject({
            owner: 'acme',
            repo: 'their-app',
            baseRef: 'production',
            branch: 'ever-works/task/add-a-thing',
        });
    });

    it('passes the Task’s labels, for APW-04’s app-provision exemption', async () => {
        const m = mocks();

        await service(m).finalizeRemotePush(
            pushInput({ task: task({ labels: ['app-provision'] }) }),
        );

        expect(m.evaluate.mock.calls[0][0].taskLabels).toEqual(['app-provision']);
    });
});

describe('a refusal blocks the Task and says the branch was pushed', () => {
    it('opens no pull request and returns blocked-by-guard', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.createPullRequest).not.toHaveBeenCalled();
        expect(blockedWith(m)).toBe(true);
    });

    it('never claims the change was not pushed — it already was', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        await service(m).finalizeRemotePush(pushInput());

        expect(bodyOf(m)).toContain('The branch was pushed');
        expect(bodyOf(m)).toContain('infra/main.tf');
    });

    it('leaves branchState alone — the branch really is pushed', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        await service(m).finalizeRemotePush(pushInput());

        const states = m.updateById.mock.calls.map(
            (c) => (c[1] as { branchState?: string } | undefined)?.branchState,
        );
        expect(states).not.toContain('conflict');
    });

    it('turns a gate that REJECTS into a refusal rather than an escape', async () => {
        // The gate's contract is that it never rejects. If it ever does, an
        // escape would leave the Task pushed with no PR, no message and no
        // transition — worse than any refusal.
        const m = mocks();
        m.evaluate.mockRejectedValue(new Error('boom'));

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(bodyOf(m)).toContain('could not be read');
        expect(blockedWith(m)).toBe(true);
    });

    it('posts the size note when the gate allows a large change', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue({
            allowed: true,
            note: 'This change is 700 lines, over guidance.',
        });

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('pr-opened');
        expect(bodyOf(m)).toContain('700 lines');
    });
});

describe('every push is judged, including one onto an open pull request', () => {
    const withPr = () =>
        pushInput({ task: task({ prNumber: 12, prUrl: 'https://example.test/pr/12' }) });

    it('asks the gate even though the Task already has a pull request', async () => {
        // A re-run pushes MORE commits onto the same branch and the open pull
        // request picks them up. The first wiring skipped this path.
        const m = mocks();

        await service(m).finalizeRemotePush(withPr());

        expect(m.evaluate).toHaveBeenCalledTimes(1);
    });

    it('keeps the idempotent answer when the new push is clean', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(withPr());

        expect(outcome).toEqual({
            outcome: 'pr-opened',
            prNumber: 12,
            prUrl: 'https://example.test/pr/12',
        });
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('blocks, and says the OPEN pull request now contains the refused change', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).finalizeRemotePush(withPr());

        expect(outcome).toEqual({
            outcome: 'blocked-by-guard',
            prNumber: 12,
            prUrl: 'https://example.test/pr/12',
        });
        expect(bodyOf(m)).toContain('pull request #12 now contains');
        expect(blockedWith(m)).toBe(true);
    });

    it('does no extra I/O for a non-App Task that already has a pull request', async () => {
        const m = mocks();

        await service(m, { kind: 'directory' }).finalizeRemotePush(withPr());

        expect(m.evaluate).not.toHaveBeenCalled();
        expect(m.getRepository).not.toHaveBeenCalled();
    });
});

describe('a node cannot move the judgement off an open pull request', () => {
    const openPr = (branchRef: string) =>
        task({ prNumber: 12, prUrl: 'https://example.test/pr/12', branchRef });

    it('BLOCKS when the reported branch is not the pull request head — before recording it', async () => {
        // The second adversarial review: a node pushed a refused change to the PR
        // head and reported an innocuous branch, and was judged on the innocuous
        // one. A Task's branch never changes once written.
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(
            pushInput({ task: openPr('ever-works/task/add-a-thing'), branch: 'innocuous' }),
        );

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard', prNumber: 12 });
        expect(m.evaluate).not.toHaveBeenCalled();
        // `recordRemotePush` would have overwritten the recorded head.
        const recorded = m.updateById.mock.calls.map(
            (c) => (c[1] as { branchRef?: string })?.branchRef,
        );
        expect(recorded).not.toContain('innocuous');
        expect(bodyOf(m)).toContain('#12');
    });

    /**
     * Third adversarial review: the rule held only while a pull request was
     * RECORDED. `branchRef` is written before the job leaves, so a Task whose
     * agent may not open pull requests (a person opens one by hand) had its
     * branch rewritten to whatever the node reported, and every later
     * judgement followed the node's name.
     */
    it('BLOCKS a mismatched branch with no pull request recorded, too — and does not record it', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(
            pushInput({
                task: task({ branchRef: 'ever-works/task/add-a-thing' }),
                branch: 'innocuous',
            }),
        );

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard' });
        const recorded = m.updateById.mock.calls.map(
            (c) => (c[1] as { branchRef?: string })?.branchRef,
        );
        expect(recorded).not.toContain('innocuous');
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('the question and failure paths block a mismatched branch too, after judging the recorded head', async () => {
        // On those paths the reconciler records the push AFTER this; a
        // mismatch not refused here is written over `branchRef`.
        const m = mocks();

        const outcome = await service(m).judgeAppWorkBranch({
            task: openPr('ever-works/task/add-a-thing') as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: 'innocuous',
        });

        expect(m.evaluate).toHaveBeenCalledWith(
            expect.objectContaining({ branch: 'ever-works/task/add-a-thing' }),
        );
        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard', prNumber: 12 });
        expect(blockedWith(m)).toBe(true);
    });

    it('blocks a mismatched branch on those paths when no pull request is recorded', async () => {
        const m = mocks();

        const outcome = await service(m).judgeAppWorkBranch({
            task: task({ branchRef: 'ever-works/task/add-a-thing' }) as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: 'innocuous',
        });

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard' });
    });
});

describe('a merged or closed pull request is not an open one', () => {
    /**
     * Third adversarial review: `judgeAppWorkBranch` treated any recorded
     * pull request as open. After a merge the branch is often deleted, the
     * gate fails closed on a branch it cannot read, and a Task whose work had
     * already landed was blocked with "must not be merged".
     */
    it.each([
        ['prState merged', { prState: 'merged' }],
        ['prState closed', { prState: 'closed' }],
        ['branchState merged', { branchState: 'merged' }],
        ['branchState cleaned', { branchState: 'cleaned' }],
    ])('does not judge the recorded head when %s', async (_why, fields) => {
        const m = mocks();

        const outcome = await service(m).judgeAppWorkBranch({
            task: task({
                prNumber: 12,
                prUrl: 'https://example.test/pr/12',
                branchRef: 'task/real-head',
                ...fields,
            }) as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch: null,
        });

        expect(outcome).toBeNull();
        expect(m.evaluate).not.toHaveBeenCalled();
    });
});

describe('judgeAppWorkBranch — runs that never reach finalize', () => {
    const judge = (
        m: Mocks,
        t: ReturnType<typeof task>,
        reportedBranch: string | null,
        kind = 'app',
    ) =>
        service(m, { kind }).judgeAppWorkBranch({
            task: t as never,
            userId: 'u-1',
            agentId: 'a-1',
            reportedBranch,
        });

    it('judges an open pull request at the head the PLATFORM recorded, not the reported one', async () => {
        const m = mocks();

        await judge(
            m,
            task({
                prNumber: 12,
                prUrl: 'https://example.test/pr/12',
                branchRef: 'task/real-head',
            }),
            'something-else',
        );

        expect(m.evaluate).toHaveBeenCalledWith(
            expect.objectContaining({ branch: 'task/real-head' }),
        );
    });

    it('blocks and names the open pull request when that head is refused', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await judge(
            m,
            task({
                prNumber: 12,
                prUrl: 'https://example.test/pr/12',
                branchRef: 'task/real-head',
            }),
            null,
        );

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard', prNumber: 12 });
        expect(blockedWith(m)).toBe(true);
        expect(bodyOf(m)).toContain('pull request #12 now contains');
    });

    it('judges the reported branch when there is no pull request but the node says it pushed', async () => {
        const m = mocks();

        await judge(m, task(), 'ever-works/task/add-a-thing');

        expect(m.evaluate).toHaveBeenCalledWith(
            expect.objectContaining({ branch: 'ever-works/task/add-a-thing' }),
        );
    });

    it('judges nothing when there is no pull request and nothing was pushed', async () => {
        const m = mocks();

        await expect(judge(m, task(), null)).resolves.toBeNull();
        expect(m.evaluate).not.toHaveBeenCalled();
    });

    it('returns at once for every other Work kind', async () => {
        const m = mocks();

        await expect(
            judge(
                m,
                task({ prNumber: 12, prUrl: 'x', branchRef: 'task/x' }),
                'task/x',
                'directory',
            ),
        ).resolves.toBeNull();
        expect(m.evaluate).not.toHaveBeenCalled();
    });
});

/**
 * The post-CI merge sweep asks this before it raises an approval or merges.
 * Every refusal leaves the pull request open, and the sweep reads the pull
 * request, not the Task — so without it a refused App Work change merged as
 * soon as CI went green.
 */
describe('judgeAppWorkMerge — before any merge or approval', () => {
    const OPEN = { prNumber: 12, prUrl: 'https://example.test/pr/12', branchRef: 'task/real-head' };

    it('judges the recorded head against the Work’s base, in the App Work’s real repository', async () => {
        const m = mocks();

        await expect(service(m).judgeAppWorkMerge(task(OPEN) as never)).resolves.toEqual({
            allowed: true,
        });
        expect(m.evaluate).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'acme',
                repo: 'their-app',
                baseRef: 'production',
                branch: 'task/real-head',
            }),
        );
    });

    it('answers refused — and says nothing, moves nothing: the sweep asks every few minutes', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        await expect(service(m).judgeAppWorkMerge(task(OPEN) as never)).resolves.toEqual({
            allowed: false,
            reason: 'app-change-refused',
        });
        expect(m.post).not.toHaveBeenCalled();
        expect(m.transition).not.toHaveBeenCalled();
    });

    it.each([
        ['no gate is bound', { bound: false }, OPEN, 'app-change-gate-unavailable'],
        ['no branch is recorded', {}, { ...OPEN, branchRef: null }, 'app-change-branch-unknown'],
    ])('fails closed when %s', async (_why, opts, fields, reason) => {
        const m = mocks();

        await expect(service(m, opts).judgeAppWorkMerge(task(fields) as never)).resolves.toEqual({
            allowed: false,
            reason,
        });
    });

    it('fails closed when the gate throws', async () => {
        const m = mocks();
        m.evaluate.mockRejectedValue(new Error('provider down'));

        await expect(service(m).judgeAppWorkMerge(task(OPEN) as never)).resolves.toEqual({
            allowed: false,
            reason: 'app-change-unjudged',
        });
    });

    it('returns null for every other Work kind, asking nothing', async () => {
        const m = mocks();

        await expect(
            service(m, { kind: 'directory' }).judgeAppWorkMerge(task(OPEN) as never),
        ).resolves.toBeNull();
        expect(m.evaluate).not.toHaveBeenCalled();
    });
});

const RUN_BRANCH = 'ever-works/task/add-a-thing';
const RUN_BASE_SHA = 'b'.repeat(40);

function runInput(taskOverrides: Record<string, unknown> = {}) {
    return {
        task: task(taskOverrides),
        userId: 'u-1',
        agentId: 'a-1',
        agentCanOpenPullRequests: true,
        workspace: {
            cwd: '/tmp/ws',
            baseSha: RUN_BASE_SHA,
            reused: false,
            branch: RUN_BRANCH,
        },
    } as never;
}

type FinalizeOpts = { commitMessage: string; push: boolean; publishSha?: string };
const finalizeOpts = (m: Mocks): FinalizeOpts[] =>
    m.finalize.mock.calls.map((call) => call[1] as FinalizeOpts);
const branchStatesWritten = (m: Mocks) =>
    m.updateById.mock.calls.map((c) => (c[1] as { branchState?: string } | undefined)?.branchState);

describe('finalizeRun — the cloud path', () => {
    // PINNED-ORDER CHANGE (APW-08 T17 cloud path). This case used to run with
    // no switch and no `checkPaths` answer, because the cloud path pushed first
    // and judged afterwards. Cloud App Work pushes are now OFF by default (owner
    // decision, until FR-12's admission lands) and, when enabled, the pushed
    // commit is judged by `checkPaths` BEFORE it is published. The post-push
    // `evaluate` this case pins is unchanged — it still runs, still receives no
    // `baseSha`, and still blocks on a refusal.
    withCloudPush('true');

    it('asks the same gate, and blocks on a refusal', async () => {
        const m = mocks();
        m.checkPaths.mockResolvedValue({ allowed: true, note: null });
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.createPullRequest).not.toHaveBeenCalled();
        expect(m.evaluate.mock.calls[0][0]).not.toHaveProperty('baseSha');
        // The post-push judgement still says what it always said.
        expect(bodyOf(m)).toContain('The branch was pushed');
    });
});

/**
 * Owner decision: the API-side (cloud) isolated-Task path does not push App Work
 * branches until APW-08 FR-12's isolated-run admission (T12) lands. The run's
 * commit stays local, the Task is blocked, and it says why — unless
 * `APP_WORKS_CLOUD_PUSH_ENABLED` is exactly `true`.
 */
describe('finalizeRun — cloud App Work pushes are off by default (FR-12 / T12)', () => {
    withCloudPush(undefined);

    it('commits locally, pushes nothing, and blocks the Task naming FR-12 and T12', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'blocked-by-guard' });
        expect(finalizeOpts(m)).toEqual([expect.objectContaining({ push: false })]);
        expect(finalizeOpts(m).some((opts) => opts.push)).toBe(false);
        expect(blockedWith(m)).toBe(true);
        expect(bodyOf(m)).toContain('FR-12');
        expect(bodyOf(m)).toContain('T12');
        expect(bodyOf(m)).toContain('Nothing was pushed');
        expect(branchStatesWritten(m)).not.toContain('pushed');
        expect(m.branchChanges).not.toHaveBeenCalled();
        expect(m.checkPaths).not.toHaveBeenCalled();
        expect(m.simulateMerge).not.toHaveBeenCalled();
        expect(m.evaluate).not.toHaveBeenCalled();
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('names an open pull request as NOT containing the change', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRun(
            runInput({ prNumber: 12, prUrl: 'https://example.test/pr/12' }),
        );

        expect(outcome).toEqual({
            outcome: 'blocked-by-guard',
            prNumber: 12,
            prUrl: 'https://example.test/pr/12',
        });
        expect(bodyOf(m)).toContain('pull request #12 does not contain');
        expect(finalizeOpts(m).some((opts) => opts.push)).toBe(false);
    });

    it.each([['false'], ['TRUE'], ['1'], ['yes'], ['']])(
        'stays off for %j — only exactly `true` enables it',
        async (value) => {
            process.env[CLOUD_PUSH_ENV] = value;
            const m = mocks();

            const outcome = await service(m).finalizeRun(runInput());

            expect(outcome.outcome).toBe('blocked-by-guard');
            expect(finalizeOpts(m).some((opts) => opts.push)).toBe(false);
        },
    );

    it('still reports an empty run as no-changes, and says nothing', async () => {
        const m = mocks();
        m.finalize.mockResolvedValueOnce({
            empty: true,
            changedFiles: 0,
            pushed: false,
            headSha: RUN_BASE_SHA,
        });

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'no-changes' });
        expect(finalizeOpts(m)).toEqual([expect.objectContaining({ push: false })]);
        expect(m.post).not.toHaveBeenCalled();
        expect(blockedWith(m)).toBe(false);
    });

    it('leaves every other Work kind exactly as it was: one finalize, pushed', async () => {
        const m = mocks();

        const outcome = await service(m, { kind: 'directory' }).finalizeRun(runInput());

        expect(outcome.outcome).toBe('pr-opened');
        expect(finalizeOpts(m)).toEqual([
            { commitMessage: 'feat(task): add-a-thing agent run output', push: true },
        ]);
        expect(m.branchChanges).not.toHaveBeenCalled();
    });

    it('leaves an App Work with no gate bound exactly as it was: one finalize, pushed', async () => {
        const m = mocks();

        const outcome = await service(m, { bound: false }).finalizeRun(runInput());

        expect(outcome.outcome).toBe('pr-opened');
        expect(finalizeOpts(m)).toEqual([
            { commitMessage: 'feat(task): add-a-thing agent run output', push: true },
        ]);
    });
});

describe('finalizeRun — judged before anything is pushed (cloud pushes enabled)', () => {
    withCloudPush('true');

    const SPEC = '.works/works.yml';
    const allow = (m: Mocks) => {
        m.checkPaths.mockResolvedValue({ allowed: true, note: null });
        return m;
    };

    it('refuses with ONE finalize that pushes nothing, and names the refused path', async () => {
        const m = mocks();
        m.branchChanges.mockResolvedValue({ paths: ['.github/workflows/ci.yml'], contents: {} });
        m.checkPaths.mockResolvedValue(refused(['.github/workflows/ci.yml']));

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'blocked-by-guard' });
        expect(finalizeOpts(m)).toEqual([expect.objectContaining({ push: false })]);
        expect(blockedWith(m)).toBe(true);
        expect(bodyOf(m)).toContain('Nothing was pushed');
        expect(bodyOf(m)).toContain('.github/workflows/ci.yml');
        expect(bodyOf(m)).not.toContain('The branch was pushed');
        expect(branchStatesWritten(m)).not.toContain('pushed');
        expect(m.simulateMerge).not.toHaveBeenCalled();
        expect(m.evaluate).not.toHaveBeenCalled();
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('publishes EXACTLY the judged commit, then judges the pushed branch and opens the PR', async () => {
        const m = allow(mocks());

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome.outcome).toBe('pr-opened');
        expect(finalizeOpts(m)).toEqual([
            expect.objectContaining({ push: false }),
            expect.objectContaining({ push: true, publishSha: HEAD_SHA }),
        ]);
        const order = (fn: jest.Mock, n = 0) => fn.mock.invocationCallOrder[n];
        expect(order(m.checkPaths)).toBeLessThan(order(m.finalize, 1));
        expect(order(m.finalize, 1)).toBeLessThan(order(m.evaluate));
        expect(order(m.evaluate)).toBeLessThan(order(m.createPullRequest));
        expect(branchStatesWritten(m)).toContain('pushed');
        // `branchState: 'pushed'` is written only once the publish returned.
        const pushedWrite = m.updateById.mock.calls.findIndex(
            (c) => (c[1] as { branchState?: string } | undefined)?.branchState === 'pushed',
        );
        expect(m.updateById.mock.invocationCallOrder[pushedWrite]).toBeGreaterThan(
            order(m.finalize, 1),
        );
    });

    it('hands checkPaths the branch changes, resolved server-side, with the Task’s labels', async () => {
        const m = allow(mocks());
        m.branchChanges.mockResolvedValue({
            paths: ['src/a.ts', 'src/b.ts'],
            contents: {},
        });

        await service(m).finalizeRun(runInput({ labels: ['app-provision'] }));

        expect(m.branchChanges).toHaveBeenCalledWith(
            {
                path: '/tmp/ws',
                baseSha: RUN_BASE_SHA,
                reused: false,
                branch: RUN_BRANCH,
                bindingKey: TASK_ID,
            },
            { headSha: HEAD_SHA, readPaths: [SPEC] },
            { userId: 'u-1', workId: WORK_ID },
        );
        const handed = m.checkPaths.mock.calls[0][0];
        expect(handed).toMatchObject({
            owner: 'acme',
            repo: 'their-app',
            baseRef: 'production',
            paths: ['src/a.ts', 'src/b.ts'],
            taskLabels: ['app-provision'],
            gitOptions: { userId: 'u-1', providerId: 'github', workId: WORK_ID },
        });
        expect(handed).not.toHaveProperty('baseSha');
        expect(handed.contents).toBeUndefined();
        expect(JSON.stringify(handed)).not.toContain(RUN_BASE_SHA);
    });

    it('passes the COMMITTED spec content when the change touches it', async () => {
        const m = allow(mocks());
        m.branchChanges.mockResolvedValue({
            paths: [SPEC, 'src/a.ts'],
            contents: { [SPEC]: 'spec: committed' },
        });

        await service(m).finalizeRun(runInput());

        expect(m.checkPaths.mock.calls[0][0].contents).toEqual({ [SPEC]: 'spec: committed' });
    });

    it('passes a deleted or renamed-away spec as empty content — which the gate refuses', async () => {
        const m = allow(mocks());
        m.branchChanges.mockResolvedValue({ paths: [SPEC], contents: { [SPEC]: null } });

        await service(m).finalizeRun(runInput());

        expect(m.checkPaths.mock.calls[0][0].contents).toEqual({ [SPEC]: '' });
    });

    it('refuses, pushing nothing, when the branch’s changes cannot be read', async () => {
        const m = allow(mocks());
        m.branchChanges.mockRejectedValue(new Error('Plugin x cannot report a branch'));

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'blocked-by-guard' });
        expect(finalizeOpts(m)).toEqual([expect.objectContaining({ push: false })]);
        expect(bodyOf(m)).toContain('Nothing was pushed');
        expect(m.checkPaths).not.toHaveBeenCalled();
        expect(blockedWith(m)).toBe(true);
    });

    it('turns a gate that REJECTS into a refusal, pushing nothing', async () => {
        const m = mocks();
        m.checkPaths.mockRejectedValue(new Error('boom'));

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'blocked-by-guard' });
        expect(bodyOf(m)).toContain('could not be read');
        expect(finalizeOpts(m).some((opts) => opts.push)).toBe(false);
    });

    it('refuses when the provider reports no commit to judge', async () => {
        const m = allow(mocks());
        m.finalize.mockResolvedValueOnce({
            empty: false,
            changedFiles: 1,
            pushed: false,
            headSha: null,
        });

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'blocked-by-guard' });
        expect(m.branchChanges).not.toHaveBeenCalled();
        expect(finalizeOpts(m)).toHaveLength(1);
    });

    it('names an open pull request as NOT containing the refused change', async () => {
        const m = mocks();
        m.checkPaths.mockResolvedValue(refused());

        const outcome = await service(m).finalizeRun(
            runInput({ prNumber: 12, prUrl: 'https://example.test/pr/12' }),
        );

        expect(outcome).toMatchObject({ outcome: 'blocked-by-guard', prNumber: 12 });
        expect(bodyOf(m)).toContain('pull request #12 does not contain');
        expect(bodyOf(m)).not.toContain('now contains');
    });

    it('fails loudly — and records no push — when the judged commit was not published', async () => {
        const m = allow(mocks());
        m.finalize.mockImplementation(async (_handle, opts) =>
            opts.publishSha
                ? {
                      empty: false,
                      pushed: false,
                      headSha: opts.publishSha,
                      publishWithheld: 'the lease expired',
                  }
                : { empty: false, changedFiles: 1, pushed: false, headSha: HEAD_SHA },
        );

        await expect(service(m).finalizeRun(runInput())).rejects.toThrow(/the lease expired/);
        expect(branchStatesWritten(m)).not.toContain('pushed');
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    // A provider that predates `publishSha` IGNORES it (the contract says so):
    // it commits the tree as usual and pushes HEAD — which can carry files
    // written after the judgement. `pushed: true` alone is not "the judged
    // commit was published".
    it('fails loudly — and records no push — when the publish pushed a DIFFERENT commit', async () => {
        const m = allow(mocks());
        const other = 'e'.repeat(40);
        m.finalize.mockImplementation(async (_handle, opts) =>
            opts.publishSha
                ? { empty: false, changedFiles: 2, pushed: true, headSha: other }
                : { empty: false, changedFiles: 1, pushed: false, headSha: HEAD_SHA },
        );

        const run = service(m).finalizeRun(runInput());

        await expect(run).rejects.toThrow(HEAD_SHA);
        await expect(run).rejects.toThrow(other);
        expect(branchStatesWritten(m)).not.toContain('pushed');
        expect(m.simulateMerge).not.toHaveBeenCalled();
        expect(m.evaluate).not.toHaveBeenCalled();
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('fails loudly when the publish reports no head at all', async () => {
        const m = allow(mocks());
        m.finalize.mockImplementation(async (_handle, opts) =>
            opts.publishSha
                ? { empty: false, pushed: true, headSha: null }
                : { empty: false, changedFiles: 1, pushed: false, headSha: HEAD_SHA },
        );

        await expect(service(m).finalizeRun(runInput())).rejects.toThrow(HEAD_SHA);
        expect(branchStatesWritten(m)).not.toContain('pushed');
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });

    it('publishes the SAME trimmed sha it judged', async () => {
        const m = allow(mocks());
        m.finalize.mockImplementation(async (_handle, opts) =>
            opts.publishSha
                ? { empty: false, pushed: true, headSha: opts.publishSha }
                : { empty: false, changedFiles: 1, pushed: false, headSha: ` ${HEAD_SHA}\n` },
        );

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome.outcome).toBe('pr-opened');
        expect(m.branchChanges.mock.calls[0][1]).toMatchObject({ headSha: HEAD_SHA });
        expect(finalizeOpts(m)[1]).toMatchObject({ push: true, publishSha: HEAD_SHA });
    });

    it('still reports an empty run as no-changes, judging nothing', async () => {
        const m = allow(mocks());
        m.finalize.mockResolvedValueOnce({
            empty: true,
            changedFiles: 0,
            pushed: false,
            headSha: RUN_BASE_SHA,
        });

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome).toEqual({ outcome: 'no-changes' });
        expect(m.checkPaths).not.toHaveBeenCalled();
        expect(m.branchChanges).not.toHaveBeenCalled();
    });

    it('leaves every other Work kind, and an unbound gate, with one pushing finalize', async () => {
        for (const opts of [{ kind: 'directory' }, { bound: false }]) {
            const m = mocks();

            const outcome = await service(m, opts).finalizeRun(runInput());

            expect(outcome.outcome).toBe('pr-opened');
            expect(finalizeOpts(m)).toEqual([
                { commitMessage: 'feat(task): add-a-thing agent run output', push: true },
            ]);
            expect(m.checkPaths).not.toHaveBeenCalled();
            expect(m.branchChanges).not.toHaveBeenCalled();
        }
    });
});
