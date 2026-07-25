import { TaskWorkspaceService } from '../task-workspace.service';

/**
 * Run telemetry — `agent_runs.changedFilesCount`.
 *
 * The column, the API embed and the board/Sessions UI all shipped, but
 * nothing ever wrote it. The workspace provider is the only component
 * that knows the checkout, so it now reports `changedFiles` from
 * `git diff --name-only <baseSha>..HEAD` and finalize stamps it.
 *
 * Every assertion here is also a statement about the failure posture:
 * the stamp is best-effort on three independent axes (no runId, no
 * provider number, a throwing repository) and must never fail a
 * finalize that already pushed a branch or opened a real pull request.
 */
describe('TaskWorkspaceService.finalizeRun — changed-files telemetry', () => {
    const makeWork = (overrides: Record<string, unknown> = {}) => ({
        id: 'work-1',
        gitProvider: 'github',
        taskIsolation: 'worktree',
        taskIsolationBaseBranch: null,
        taskIsolationTargetRepo: 'work-output',
        taskBranchCleanup: 'on-merge',
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'site-data',
        ...overrides,
    });

    const makeTask = (overrides: Record<string, unknown> = {}) =>
        ({
            id: '123e4567-e89b-12d3-a456-426614174000',
            slug: 't-42',
            workId: 'work-1',
            isolationMode: null,
            branchRef: null,
            branchState: null,
            ...overrides,
        }) as any;

    const workspace = {
        cwd: '/ws/task',
        branch: 'task/t-42-123e4567',
        baseSha: 'abc123def456',
        reused: false,
        provider: 'workspace',
    };

    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let runs: { setWorkspaceMeta: jest.Mock; updateTelemetry: jest.Mock };
    let facade: { provision: jest.Mock; finalize: jest.Mock; simulateMerge: jest.Mock };
    let git: {
        getAccessToken: jest.Mock;
        getRepository: jest.Mock;
        createPullRequest: jest.Mock;
    };
    let transitions: { transition: jest.Mock };
    let taskChat: { post: jest.Mock };

    beforeEach(() => {
        works = { findById: jest.fn().mockResolvedValue(makeWork()) };
        tasks = {
            updateById: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn().mockResolvedValue(makeTask()),
        };
        runs = {
            setWorkspaceMeta: jest.fn().mockResolvedValue(undefined),
            updateTelemetry: jest.fn().mockResolvedValue(undefined),
        };
        facade = {
            provision: jest.fn().mockResolvedValue(workspace),
            finalize: jest.fn().mockResolvedValue({
                pushed: true,
                headSha: 'ff00',
                empty: false,
                changedFiles: 7,
            }),
            simulateMerge: jest.fn().mockResolvedValue({ clean: true, conflictPaths: [] }),
        };
        git = {
            getAccessToken: jest.fn().mockResolvedValue('tok-123'),
            getRepository: jest.fn().mockResolvedValue({
                defaultBranch: 'main',
                cloneUrl: 'https://github.com/acme/site-data.git',
            }),
            createPullRequest: jest.fn().mockResolvedValue({
                number: 7,
                url: 'https://github.com/acme/site-data/pull/7',
            }),
        };
        transitions = { transition: jest.fn().mockResolvedValue(undefined) };
        taskChat = { post: jest.fn().mockResolvedValue(undefined) };
    });

    const build = () =>
        new TaskWorkspaceService(
            works as any,
            tasks as any,
            runs as any,
            facade as any,
            git as any,
            transitions as any,
            taskChat as any,
        );

    const finalizeInput = (over: Record<string, unknown> = {}) => ({
        task: makeTask(),
        userId: 'user-1',
        agentId: 'agent-1',
        agentCanOpenPullRequests: true,
        workspace,
        runId: 'run-1',
        ...over,
    });

    it('stamps changedFilesCount on the run when the provider reports it', async () => {
        const result = await build().finalizeRun(finalizeInput());

        expect(result.outcome).toBe('pr-opened');
        expect(runs.updateTelemetry).toHaveBeenCalledWith('run-1', { changedFilesCount: 7 });
    });

    it('stamps an honest 0 on an empty run', async () => {
        facade.finalize.mockResolvedValue({
            pushed: false,
            headSha: null,
            empty: true,
            changedFiles: 0,
        });

        const result = await build().finalizeRun(finalizeInput());

        expect(result.outcome).toBe('no-changes');
        expect(runs.updateTelemetry).toHaveBeenCalledWith('run-1', { changedFilesCount: 0 });
    });

    it('stamps on the conflict path too — the branch changed files either way', async () => {
        facade.simulateMerge.mockResolvedValue({ clean: false, conflictPaths: ['src/app.ts'] });

        const result = await build().finalizeRun(finalizeInput());

        expect(result.outcome).toBe('conflict');
        expect(runs.updateTelemetry).toHaveBeenCalledWith('run-1', { changedFilesCount: 7 });
    });

    it('writes nothing when the provider omits changedFiles (never a misleading 0)', async () => {
        facade.finalize.mockResolvedValue({ pushed: true, headSha: 'ff00', empty: false });

        const result = await build().finalizeRun(finalizeInput());

        expect(result.outcome).toBe('pr-opened');
        expect(runs.updateTelemetry).not.toHaveBeenCalled();
    });

    it('writes nothing when the caller has no run context', async () => {
        const result = await build().finalizeRun(finalizeInput({ runId: undefined }));

        expect(result.outcome).toBe('pr-opened');
        expect(runs.updateTelemetry).not.toHaveBeenCalled();
    });

    it('a throwing telemetry write never fails a finalize that already opened a PR', async () => {
        runs.updateTelemetry.mockRejectedValue(new Error('db down'));

        const result = await build().finalizeRun(finalizeInput());

        expect(result).toEqual(expect.objectContaining({ outcome: 'pr-opened', prNumber: 7 }));
        expect(git.createPullRequest).toHaveBeenCalled();
    });

    it('clamps a nonsense provider value instead of writing it verbatim', async () => {
        facade.finalize.mockResolvedValue({
            pushed: true,
            headSha: 'ff00',
            empty: false,
            changedFiles: -3.7,
        });

        await build().finalizeRun(finalizeInput());

        expect(runs.updateTelemetry).toHaveBeenCalledWith('run-1', { changedFilesCount: 0 });
    });

    it('ignores a non-numeric provider value', async () => {
        facade.finalize.mockResolvedValue({
            pushed: true,
            headSha: 'ff00',
            empty: false,
            changedFiles: Number.NaN,
        });

        await build().finalizeRun(finalizeInput());

        expect(runs.updateTelemetry).not.toHaveBeenCalled();
    });
});
