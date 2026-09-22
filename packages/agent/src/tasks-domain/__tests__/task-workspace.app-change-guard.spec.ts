import { TaskStatus } from '../../entities/task.entity';

import { TaskWorkspaceService } from '../task-workspace.service';
import { AppChangeGuard } from '../../app-works/app-change-guard';
import {
    AppSpecUnreadableError,
    type AppWorkRulesService,
} from '../../app-works/app-work-rules.service';

/**
 * APW-08 T17 — the change guard, wired into the two finalize paths.
 *
 * `finalizeRun` and `finalizeRemotePush` are the shared finalize tail for
 * **every** Work in the product, so most of what matters here is what the guard
 * does NOT do: it must not run for a directory Work, it must not run when the
 * epic is not installed, and above all it must not throw.
 *
 * The three absences answer differently, and that is the design:
 *
 *   - not an App Work        → proceed
 *   - the epic is not bound  → proceed (nothing was promised)
 *   - bound, rules unreadable→ REFUSE (a run with unknown protected paths is a
 *                              run with no protected paths)
 *
 * The branch is already pushed by the time the guard runs, so every refusal says
 * so — the same thing the existing conflict copy is careful about.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const BASE_SHA = 'a'.repeat(40);

type Mocks = ReturnType<typeof mocks>;

function mocks() {
    return {
        updateById: jest.fn(async (_id: string, _fields: Record<string, unknown>) => undefined),
        // `transitionTask` re-reads the Task before transitioning
        // (`task-workspace.service.ts:2117`) and swallows anything that throws,
        // so a repository double without `findById` makes the transition
        // silently not happen.
        findByIdTask: jest.fn(async () => ({ id: TASK_ID, status: 'in_progress' })),
        transition: jest.fn(async () => undefined),
        post: jest.fn(async (_userId: string, _message: { body: string }) => undefined),
        getCompareDiff: jest.fn(async () => diff([{ path: 'src/app.ts' }])),
        getLatestCommit: jest.fn(async () => ({ sha: 'b'.repeat(40) })),
        getRepository: jest.fn(async () => ({ defaultBranch: 'production' })),
        getFileContent: jest.fn(async () => null),
        simulateMerge: jest.fn(async () => ({ clean: true, conflictPaths: [] })),
        finalize: jest.fn(async () => ({ empty: false, changedFiles: 1 })),
        createPullRequest: jest.fn(async () => ({ number: 7, url: 'https://example.test/pr/7' })),
        resolve: jest.fn(async () => rules()),
    };
}

function rules(overrides: Record<string, unknown> = {}) {
    return Object.freeze({
        sourceBranch: 'production',
        checks: [],
        protectedPaths: [],
        humanMergePaths: [],
        instructionFiles: [],
        sizeGuidance: 500,
        ...overrides,
    });
}

function diff(files: { path: string; previousPath?: string }[]) {
    return {
        files: files.map((f) => ({ status: 'modified', additions: 1, deletions: 0, ...f })),
        truncated: false,
        totalFiles: files.length,
        totalAdditions: files.length,
        totalDeletions: 0,
        patchBytes: 0,
    };
}

function work(kind = 'app') {
    return {
        id: WORK_ID,
        kind,
        gitProvider: 'github',
        taskIsolationBaseBranch: 'production',
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'their-app',
    };
}

function task() {
    return { id: TASK_ID, workId: WORK_ID, slug: 'add-a-thing', labels: [] as string[] };
}

/**
 * The service with only what this path reads.
 *
 * Positional, and the guard trio is LAST — the file's own arity rule. `guard`
 * and `specs` are passed as `undefined` by the "not installed" cases, which is
 * exactly what the eighteen existing construction sites do.
 */
function service(m: Mocks, opts: { installed?: boolean; kind?: string } = {}) {
    const installed = opts.installed !== false;
    const appRules = { resolve: m.resolve } as unknown as AppWorkRulesService;

    return new TaskWorkspaceService(
        { findById: jest.fn(async () => work(opts.kind ?? 'app')) } as never, // works
        { updateById: m.updateById, findById: m.findByIdTask } as never, // tasks
        {} as never, // runs
        { finalize: m.finalize, simulateMerge: m.simulateMerge } as never, // workspaceFacade
        {
            getRepository: m.getRepository,
            getCompareDiff: m.getCompareDiff,
            getLatestCommit: m.getLatestCommit,
            getFileContent: m.getFileContent,
            createPullRequest: m.createPullRequest,
        } as never, // gitFacade
        { transition: m.transition } as never, // transitions
        { post: m.post } as never, // taskChat
        undefined as never, // mergePolicy
        undefined as never, // activityLog
        undefined as never, // agentRepoAttachments
        undefined as never, // repoConnections
        installed ? appRules : (undefined as never),
        installed ? new AppChangeGuard() : (undefined as never),
        undefined as never, // appSpecs — rule 4 is exercised by the guard's own spec
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
        baseSha: BASE_SHA,
        ...overrides,
    } as never;
}

describe('the guard does not touch what it should not', () => {
    it('does not run for a Work that is not kind `app`', async () => {
        // This is the shared finalize tail for EVERY Work. `kind` defaults to
        // `'default'`, so an ungated guard would run on every Task in the
        // product.
        const m = mocks();

        await service(m, { kind: 'directory' }).finalizeRemotePush(pushInput());

        expect(m.resolve).not.toHaveBeenCalled();
        expect(m.getCompareDiff).not.toHaveBeenCalled();
        expect(m.createPullRequest).toHaveBeenCalled();
    });

    it('does not run when the epic is not installed — nothing was promised', async () => {
        const m = mocks();

        await service(m, { installed: false }).finalizeRemotePush(pushInput());

        expect(m.getCompareDiff).not.toHaveBeenCalled();
        expect(m.createPullRequest).toHaveBeenCalled();
        // It DOES transition — to `in_review`, which is what opening a pull
        // request means. What must not happen is a BLOCKED transition.
        expect(m.transition).not.toHaveBeenCalledWith(
            expect.anything(),
            TaskStatus.BLOCKED,
            expect.anything(),
        );
    });

    it('opens the pull request for a clean App Work change', async () => {
        const m = mocks();

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: WORK_ID }), BASE_SHA);
        expect(outcome.outcome).toBe('pr-opened');
    });
});

describe('the guard refuses, and says the branch was pushed', () => {
    it('blocks a protected-path change without opening a pull request', async () => {
        const m = mocks();
        m.resolve.mockResolvedValue(rules({ protectedPaths: ['infra/**'] }) as never);
        m.getCompareDiff.mockResolvedValue(diff([{ path: 'infra/main.tf' }]) as never);

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.createPullRequest).not.toHaveBeenCalled();
        expect(m.transition).toHaveBeenCalledWith(
            expect.anything(),
            TaskStatus.BLOCKED,
            expect.anything(),
        );
    });

    it('never claims the change was not pushed — it already was', async () => {
        // `finalizeRun` pushes before the guard point and `finalizeRemotePush`
        // is called after the fleet has pushed. Copy that said otherwise would
        // send a member looking for a branch that is already on the remote.
        const m = mocks();
        m.resolve.mockResolvedValue(rules({ protectedPaths: ['infra/**'] }) as never);
        m.getCompareDiff.mockResolvedValue(diff([{ path: 'infra/main.tf' }]) as never);

        await service(m).finalizeRemotePush(pushInput());

        const body = String(m.post.mock.calls[0]?.[1]?.body ?? '');
        expect(body).toContain('pushed');
        expect(body).toContain('infra/main.tf');
    });

    it('leaves branchState alone — the branch really is pushed', async () => {
        const m = mocks();
        m.resolve.mockResolvedValue(rules({ protectedPaths: ['infra/**'] }) as never);
        m.getCompareDiff.mockResolvedValue(diff([{ path: 'infra/main.tf' }]) as never);

        await service(m).finalizeRemotePush(pushInput());

        const states = m.updateById.mock.calls.map(
            (c) => (c[1] as { branchState?: string } | undefined)?.branchState,
        );
        expect(states).not.toContain('conflict');
    });
});

describe('nothing here may throw', () => {
    it('turns an unreadable spec into a refusal, not an escape', async () => {
        // Every other collaborator at finalize time swallows. An escape would
        // leave the Task at `pushed` with no PR, no message and no BLOCKED —
        // strictly worse than the refusal, because the member sees a Task that
        // simply stopped.
        const m = mocks();
        m.resolve.mockRejectedValue(new AppSpecUnreadableError(WORK_ID, 'production', 'invalid'));

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.transition).toHaveBeenCalled();
        expect(String(m.post.mock.calls[0]?.[1]?.body ?? '')).toContain('could not be read');
    });

    it('turns a provider that cannot diff into a refusal', async () => {
        const m = mocks();
        m.getCompareDiff.mockRejectedValue(new Error('getCompareDiff is not supported'));

        const outcome = await service(m).finalizeRemotePush(pushInput());

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.createPullRequest).not.toHaveBeenCalled();
    });
});

describe('the base commit', () => {
    it('resolves the base branch tip when the caller has no base sha', async () => {
        // The fleet passes `baseSha: result.git.baseSha ?? null`, and that is a
        // normal push rather than an error. The base branch's own tip is still
        // a commit the agent did not author.
        const m = mocks();

        await service(m).finalizeRemotePush(pushInput({ baseSha: null }));

        expect(m.getLatestCommit).toHaveBeenCalledWith(
            'acme',
            'their-app',
            'production',
            expect.anything(),
        );
        expect(m.resolve).toHaveBeenCalledWith(expect.anything(), 'b'.repeat(40));
    });

    it('refuses when even the base branch tip cannot be read', async () => {
        const m = mocks();
        m.getLatestCommit.mockResolvedValue(null as never);

        const outcome = await service(m).finalizeRemotePush(pushInput({ baseSha: null }));

        expect(outcome.outcome).toBe('blocked-by-guard');
        expect(m.resolve).not.toHaveBeenCalled();
    });

    it('prefers the caller’s base sha over a provider round-trip', async () => {
        const m = mocks();

        await service(m).finalizeRemotePush(pushInput());

        expect(m.getLatestCommit).not.toHaveBeenCalled();
    });
});
