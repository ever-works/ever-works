// Stub the deep import chain (database -> entities -> @src alias) that
// otherwise breaks Jest. We test the WorkProposalsApiService glue with
// fully mocked deps; deeper service correctness is covered in the agent
// package's own tests.
jest.mock(
    '@ever-works/agent/database',
    () => ({
        UserRepository: class {},
    }),
    { virtual: true },
);

jest.mock(
    '@ever-works/agent/entities',
    () => ({
        User: class {},
    }),
    { virtual: true },
);

class StubRateLimitedError extends Error {
    constructor(_b: string, _c: number, _m: number) {
        super('rate-limited');
    }
}

jest.mock(
    '@ever-works/agent/user-research',
    () => ({
        DEFAULT_MAX_PENDING_WORK_PROPOSALS: 6,
        UserResearchRateLimitedError: StubRateLimitedError,
        UserResearchService: class {},
        WorkProposalService: class {},
        UserResearchLimitsService: class {},
        WorkProposalSource: {
            AUTO_SIGNUP: 'auto-signup',
            USER_REFRESH: 'user-refresh',
            DISCOVER: 'discover',
            SCHEDULED: 'scheduled',
            USER_MANUAL: 'user-manual',
            MISSION: 'mission',
        },
        WorkProposalStatus: {
            PENDING: 'pending',
            DISMISSED: 'dismissed',
            ACCEPTED: 'accepted',
            QUEUED: 'queued',
            BUILDING: 'building',
            FAILED: 'failed',
        },
    }),
    { virtual: true },
);

// Phase 1 PR B — WorkProposalsApiService now injects WorkAgentService.
// Stub the barrel for the same deep-import-chain reason as the others.
jest.mock(
    '@ever-works/agent/work-agent',
    () => ({
        WorkAgentService: class WorkAgentService {},
    }),
    { virtual: true },
);

import { WorkProposalsApiService } from './work-proposals.service';

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('WorkProposalsApiService', () => {
    const makeDeps = () => {
        const research = { research: jest.fn().mockResolvedValue({ status: 'completed' }) };
        const proposals = {
            countPending: jest.fn().mockResolvedValue(0),
            generate: jest.fn().mockResolvedValue({ status: 'generated', proposals: [] }),
            list: jest.fn().mockResolvedValue([]),
            dismiss: jest.fn().mockResolvedValue(true),
            markAccepted: jest.fn().mockResolvedValue(true),
            getForUser: jest.fn().mockResolvedValue({ id: 'p1' }),
        };
        const limits = {
            assertCanRun: jest.fn().mockResolvedValue(undefined),
            canRun: jest.fn().mockResolvedValue(true),
        };
        const users = {
            findById: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const userOrmRepo = { find: jest.fn().mockResolvedValue([]) };
        const config = { get: jest.fn((_k: string, d: unknown) => d) };
        const workAgent = {
            createGoal: jest.fn().mockResolvedValue({
                goal: { id: 'g1', instruction: '', status: 'waiting-for-approval' },
                run: { id: 'r1' },
            }),
            getPreferences: jest.fn().mockResolvedValue({
                enabled: false,
                autoApproveLowImpact: false,
                dailySuggestionsEnabled: true,
                guardrails: {},
                autoGenerateCadence: null,
                autoGenerateBatchSize: null,
                autoBuildThrottlePerDay: null,
                missionDefaultOutstandingCap: null,
                maxAutoRetries: 2,
                backoffSeconds: 60,
                exponentialBackoffFactor: 2.0,
                accountWideMonthlyCapCents: null,
                accountWideAllowOverage: true,
            }),
        };
        const taskLock = {
            isLocked: jest.fn().mockResolvedValue(false),
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<void>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        const svc = new WorkProposalsApiService(
            research as never,
            proposals as never,
            limits as never,
            users as never,
            userOrmRepo as never,
            config as never,
            workAgent as never,
            taskLock as never,
        );
        return {
            svc,
            research,
            proposals,
            limits,
            users,
            userOrmRepo,
            config,
            workAgent,
            taskLock,
        };
    };

    it('queues a refresh when caps are within budget', async () => {
        const { svc, research, proposals } = makeDeps();
        const result = await svc.refresh('u1');
        expect(result.status).toBe('queued');
        await flushMicrotasks();
        await flushMicrotasks();
        expect(research.research).toHaveBeenCalledWith('u1', {
            timeoutMs: 1_800_000,
            maxSteps: 14,
        });
        expect(proposals.generate).toHaveBeenCalledWith('u1', {
            source: 'user-refresh',
            suppressLowConfidence: true,
            maxPendingProposals: 6,
            targetCount: null,
        });
    });

    it('allows low-confidence proposals for auto-signup runs', async () => {
        const { svc, proposals } = makeDeps();

        await svc.refresh('u1', 'auto-signup' as never);
        await flushMicrotasks();
        await flushMicrotasks();

        expect(proposals.generate).toHaveBeenCalledWith('u1', {
            source: 'auto-signup',
            suppressLowConfidence: false,
            maxPendingProposals: 6,
            targetCount: null,
        });
    });

    it('runs refresh pipelines through the distributed per-user lock', async () => {
        const { svc, taskLock } = makeDeps();

        await svc.refresh('u1');
        await flushMicrotasks();
        await flushMicrotasks();

        expect(taskLock.runExclusive).toHaveBeenCalledWith(
            'work-proposals:pipeline:u1',
            expect.any(Function),
            expect.objectContaining({ ttlMs: 7_200_000 }),
        );
    });

    it('passes configured research timeout and step limits to the agent', async () => {
        const { svc, research, config } = makeDeps();
        config.get.mockImplementation((key: string, d: unknown) => {
            if (key === 'USER_RESEARCH_TIMEOUT_MS') return '600000';
            return d;
        });

        await svc.refresh('u1');
        await flushMicrotasks();
        await flushMicrotasks();

        expect(research.research).toHaveBeenCalledWith('u1', {
            timeoutMs: 600_000,
            maxSteps: 14,
        });
    });

    it('returns at-limit before spending research tokens when pending proposals are full', async () => {
        const { svc, proposals, research } = makeDeps();
        proposals.countPending.mockResolvedValue(6);

        const result = await svc.refresh('u1');

        expect(result.status).toBe('at-limit');
        expect(research.research).not.toHaveBeenCalled();
    });

    it('returns rate-limited when cap is exceeded', async () => {
        const { svc, limits } = makeDeps();
        limits.assertCanRun.mockRejectedValue(new StubRateLimitedError('maxRunsPerDay', 3, 3));
        const result = await svc.refresh('u1');
        expect(result.status).toBe('rate-limited');
    });

    it('skips proposal generation when research did not complete', async () => {
        const { svc, research, proposals } = makeDeps();
        research.research.mockResolvedValue({ status: 'no-data' });
        await svc.refresh('u1');
        await flushMicrotasks();
        await flushMicrotasks();
        expect(proposals.generate).not.toHaveBeenCalled();
    });

    it('getRefreshStatus reports researching=false and canRefresh=true on a fresh user', async () => {
        const { svc } = makeDeps();
        await expect(svc.getRefreshStatus('u1')).resolves.toEqual({
            researching: false,
            canRefresh: true,
        });
    });

    it('getRefreshStatus reports researching=true when another instance holds the pipeline lock', async () => {
        const { svc, taskLock } = makeDeps();
        taskLock.isLocked.mockResolvedValue(true);

        await expect(svc.getRefreshStatus('u1')).resolves.toEqual({
            researching: true,
            canRefresh: true,
        });
    });

    it('getRefreshStatus reports canRefresh=false when pending proposal limit is reached', async () => {
        const { svc, proposals } = makeDeps();
        proposals.countPending.mockResolvedValue(6);

        await expect(svc.getRefreshStatus('u1')).resolves.toEqual({
            researching: false,
            canRefresh: false,
            refreshDisabledReason: 'at-limit',
        });
    });

    it('getRefreshStatus reports canRefresh=false when daily limit reached', async () => {
        const { svc, limits } = makeDeps();
        limits.canRun.mockResolvedValue(false);
        await expect(svc.getRefreshStatus('u1')).resolves.toEqual({
            researching: false,
            canRefresh: false,
            refreshDisabledReason: 'rate-limited',
        });
    });

    it('getRefreshStatus reports researching=true while a run is in flight', async () => {
        // Relies on getRefreshStatus reading inFlight.has(userId) synchronously
        // before its first await — if that order ever changes, the pipeline
        // microtask queued by refresh() could drain first and inFlight would
        // be empty by the time we look. Reorder = flip; update the test then.
        const { svc } = makeDeps();
        await svc.refresh('u1');
        const status = await svc.getRefreshStatus('u1');
        expect(status.researching).toBe(true);
    });

    it('updates preferences via repo', async () => {
        const { svc, users } = makeDeps();
        await svc.updatePreferences('u1', true);
        expect(users.update).toHaveBeenCalledWith('u1', { userResearchOptOut: true });
    });

    it('ingestWorkCreated merges categories + tags into topics', async () => {
        const { svc, users } = makeDeps();
        users.findById.mockResolvedValue({
            inferredInterests: { topics: ['ai'], confidence: 'high' },
        });
        await svc.ingestWorkCreated('u1', { categories: ['design', 'ai'], tags: ['react'] });
        const call = users.update.mock.calls[0][1] as { inferredInterests: { topics: string[] } };
        expect(call.inferredInterests.topics).toEqual(
            expect.arrayContaining(['ai', 'design', 'react']),
        );
    });

    it('ingestWorkCreated is a no-op when there is no profile yet', async () => {
        const { svc, users } = makeDeps();
        users.findById.mockResolvedValue({ inferredInterests: null });
        await svc.ingestWorkCreated('u1', { categories: ['x'] });
        expect(users.update).not.toHaveBeenCalled();
    });
});
