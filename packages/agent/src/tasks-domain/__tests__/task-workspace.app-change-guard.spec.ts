import { TaskStatus } from '../../entities/task.entity';

import { TaskWorkspaceService } from '../task-workspace.service';
import type {
    AppWorkChangeGate,
    AppWorkChangeGateInput,
    AppWorkChangeGateVerdict,
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
        finalize: jest.fn(async () => ({ empty: false, changedFiles: 1 })),
        createPullRequest: jest.fn(async () => ({ number: 7, url: 'https://example.test/pr/7' })),
        evaluate: jest.fn(
            async (_input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict> => ({
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
    const gate: AppWorkChangeGate = { evaluate: m.evaluate };

    return new TaskWorkspaceService(
        { findById: jest.fn(async () => work(opts.kind ?? 'app')) } as never, // works
        { updateById: m.updateById, findById: m.findByIdTask } as never, // tasks
        {} as never, // runs
        { finalize: m.finalize, simulateMerge: m.simulateMerge } as never, // workspaceFacade
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

describe('finalizeRun — the cloud path', () => {
    function runInput() {
        return {
            task: task(),
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

    it('asks the same gate, and blocks on a refusal', async () => {
        const m = mocks();
        m.evaluate.mockResolvedValue(refused());

        const outcome = await service(m).finalizeRun(runInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.createPullRequest).not.toHaveBeenCalled();
        expect(m.evaluate.mock.calls[0][0]).not.toHaveProperty('baseSha');
    });
});
