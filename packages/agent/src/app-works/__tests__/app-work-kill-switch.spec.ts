import { Logger } from '@nestjs/common';

import { config } from '../../config';
import { AgentRunService } from '../../agents/agent-run.service';
import { PromptAssemblerService } from '../../agents/prompt-assembler.service';
import { AppBuildSucceededListener } from '../../app-runtime/app-build-succeeded.listener';
import { AppBuildSucceededEvent } from '../../events/app-build.events';
import { TaskTransitionService } from '../../tasks-domain/task-transition.service';
import { agentReviewRunScope } from '../../tasks-domain/task-agent-review';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';
import { AppChangeRequestService } from '../app-change-request.service';
import {
    APP_WORK_SWITCH_ENV,
    APP_WORK_SWITCH_OFF_CODE,
    readAppWorkSwitch,
    readAppWorkSwitches,
} from '../app-work-switches';

/**
 * APW-08 T49 (XC-10, FR-74, CONTRACTS R-30 / §7, ACC-08-38) — the evolve loop's operator kill
 * switches. Each dispatcher reads the switch itself, so every "switch off" case below fails on
 * `develop` before this lane, where no switch exists and every one of them would start a run or a
 * Deployment. The "default" cases pin that adding the switches changed nothing.
 */

const CHANGES = APP_WORK_SWITCH_ENV.changes;
const AUTO_DEPLOY = APP_WORK_SWITCH_ENV.autoDeploy;

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void> | void) {
    return async () => {
        const saved: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(values)) {
            saved[key] = process.env[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            await fn();
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    };
}

beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('APW-08 T49 — reading the switches', () => {
    it('both default ON when unset or blank (adding them changes no behaviour)', () => {
        expect(readAppWorkSwitches({})).toEqual({ changesEnabled: true, autoDeployEnabled: true });
        expect(readAppWorkSwitch(CHANGES, { [CHANGES]: '' })).toBe(true);
        expect(readAppWorkSwitch(CHANGES, { [CHANGES]: '   ' })).toBe(true);
    });

    it('reads the usual spellings, case-insensitively', () => {
        for (const on of ['true', 'TRUE', '1', 'on', 'yes', 'enabled']) {
            expect(readAppWorkSwitch(CHANGES, { [CHANGES]: on })).toBe(true);
        }
        for (const off of ['false', 'False', '0', 'off', 'no', 'disabled']) {
            expect(readAppWorkSwitch(AUTO_DEPLOY, { [AUTO_DEPLOY]: off })).toBe(false);
        }
    });

    it('fails CLOSED on a value it does not recognise', () => {
        expect(readAppWorkSwitch(CHANGES, { [CHANGES]: 'flase' })).toBe(false);
        expect(readAppWorkSwitch(AUTO_DEPLOY, { [AUTO_DEPLOY]: 'maybe' })).toBe(false);
    });

    it('is read at the moment of the decision, never cached', () => {
        expect(readAppWorkSwitches({ [CHANGES]: 'false' }).changesEnabled).toBe(false);
        expect(readAppWorkSwitches({ [CHANGES]: 'true' }).changesEnabled).toBe(true);
    });
});

function appWork(over: Record<string, unknown> = {}) {
    return {
        id: 'w1',
        userId: 'owner',
        name: 'Helpdesk',
        slug: 'helpdesk',
        kind: 'app',
        tenantId: null,
        organizationId: null,
        gitProvider: 'github',
        sourceRepository: {
            type: 'app_fork',
            owner: 'me',
            repo: 'helpdesk',
            upstream: { owner: 'example-org', repo: 'helpdesk', defaultBranch: 'main' },
        },
        getRepoOwner: () => 'me',
        getDataRepo: () => 'helpdesk-data',
        getWebsiteRepo: () => 'helpdesk',
        ...over,
    } as never;
}

describe('APW-08 T49 — the evolve request (chat, board, POST /api/works/:id/evolve)', () => {
    function service() {
        const tasks = {
            create: jest.fn(async () => ({ id: 't1', slug: 'T-1' })),
            runTask: jest.fn(async () => ({ runId: 'r1', dispatched: true, parked: false })),
        };
        const taskRepository = {
            findByUserIdFiltered: jest.fn(async () => ({
                rows: [
                    {
                        id: 't0',
                        slug: 'T-0',
                        title: 'Earlier change',
                        status: 'done',
                        labels: ['app-change'],
                    },
                ],
                total: 1,
            })),
        };
        const resolver = {
            resolve: jest.fn(async () => ({ agentId: 'a1', source: 'pinned' as const })),
        };
        const svc = new AppChangeRequestService(
            tasks as never,
            taskRepository as never,
            undefined,
            resolver,
        );
        return { svc, tasks };
    }

    it(
        'switch OFF: refused 503 switchOff, no Task filed, nothing started',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const { svc, tasks } = service();
            const result = await svc.request({
                work: appWork(),
                actorUserId: 'owner',
                request: 'Add dark mode',
            });
            expect(result).toMatchObject({ status: 'refused', httpStatus: 503, code: 'switchOff' });
            expect(result.status === 'refused' ? result.message : '').toContain(
                'paused by the operator',
            );
            expect(tasks.create).not.toHaveBeenCalled();
            expect(tasks.runTask).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch OFF: the change history still reads (nothing is hidden)',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const { svc } = service();
            const rows = await svc.listChanges(appWork() as never);
            expect(rows.map((row) => row.taskId)).toEqual(['t0']);
        }),
    );

    it(
        'default (unset): files and starts the change as before',
        withEnv({ [CHANGES]: undefined }, async () => {
            const { svc, tasks } = service();
            const result = await svc.request({
                work: appWork(),
                actorUserId: 'owner',
                request: 'Add dark mode',
            });
            expect(result).toMatchObject({ status: 'accepted', httpStatus: 202, runId: 'r1' });
            expect(tasks.runTask).toHaveBeenCalledTimes(1);
        }),
    );
});

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Add dark mode',
        description: null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: 'w-app',
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('APW-08 T49 — TaskTransitionService.dispatchAgentRun (board, Goal, recurrence, fan-out)', () => {
    const KINDS: Record<string, string> = { 'w-app': 'app', 'w-site': 'directory' };
    let runs: {
        createQueued: jest.Mock;
        markDispatchFailed: jest.Mock;
        setTriggerRunId: jest.Mock;
    };
    let dispatcher: { enqueue: jest.Mock };
    let works: { findById: jest.Mock };

    function makeSvc(opts: { noRuns?: boolean } = {}): TaskTransitionService {
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        works = {
            findById: jest.fn(async (id: string) => (KINDS[id] ? { id, kind: KINDS[id] } : null)),
        };
        const agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) => ({ id, userId })),
        };
        return new (TaskTransitionService as unknown as new (
            ...args: unknown[]
        ) => TaskTransitionService)(
            { casUpdateStatus: jest.fn(), findById: jest.fn() },
            { findByTaskId: jest.fn().mockResolvedValue([]) },
            { allApproved: jest.fn().mockResolvedValue(true) },
            { findAgentAssignees: jest.fn().mockResolvedValue([]) },
            opts.noRuns ? undefined : runs,
            dispatcher,
            undefined, // notifications
            undefined, // runDenorm
            undefined, // dispatchGate
            works,
            undefined, // terminalSessions
            agents,
        );
    }

    // Updated with park-with-auto-resume (R-30: "jobs pause … turning it back on resumes"): the
    // run is no longer refused — it is PARKED, and nothing starts. Just as strict: no enqueue.
    it(
        'switch OFF: the run of an App Work Task is PARKED app-changes-paused — a row, nothing started, no enqueue',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const result = await makeSvc().dispatchAgentRun(makeTask(), 'agent-a');
            expect(result).toMatchObject({ runId: 'r1', dispatched: false, parked: true });
            expect(runs.createQueued).toHaveBeenCalledTimes(1);
            expect(runs.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({ queuedReason: 'app-changes-paused' }),
            );
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch OFF without a run repository (no row to park in): refused as before, and says why',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const result = await makeSvc({ noRuns: true }).dispatchAgentRun(makeTask(), 'agent-a');
            expect(result).toMatchObject({ runId: null, dispatched: false, parked: false });
            expect(result.error).toMatch(
                new RegExp(`^${APP_WORK_SWITCH_OFF_CODE}: ${CHANGES} is off`),
            );
            expect(runs.createQueued).not.toHaveBeenCalled();
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch OFF: an unreadable Work fails closed',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const result = await makeSvc().dispatchAgentRun(
                makeTask({ workId: 'w-gone' }),
                'agent-a',
            );
            expect(result.dispatched).toBe(false);
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch OFF: a Task on another kind of Work and a Work-less Task still dispatch',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const svc = makeSvc();
            await expect(
                svc.dispatchAgentRun(makeTask({ workId: 'w-site' }), 'agent-a'),
            ).resolves.toMatchObject({
                dispatched: true,
            });
            await expect(
                svc.dispatchAgentRun(makeTask({ workId: null }), 'agent-a'),
            ).resolves.toMatchObject({
                dispatched: true,
            });
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        }),
    );

    it(
        'switch ON (default): an App Work Task dispatches as before, with no Work read at all',
        withEnv({ [CHANGES]: undefined }, async () => {
            const svc = makeSvc();
            await expect(svc.dispatchAgentRun(makeTask(), 'agent-a')).resolves.toMatchObject({
                dispatched: true,
            });
            expect(works.findById).not.toHaveBeenCalled();
        }),
    );
});

describe('APW-08 T49 — AgentRunService.execute (resumed, drained, assign-task and queued runs)', () => {
    function makeRunService(classifierAnswer: boolean) {
        const runs = {
            findByAgent: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue({ status: 'running' }),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            addTokens: jest.fn().mockResolvedValue(undefined),
            mergeFilesTouched: jest.fn().mockResolvedValue(undefined),
            takeSteeringSignals: jest
                .fn()
                .mockResolvedValue({ pendingInput: [], interruptRequested: false }),
        };
        const ai = {
            dispatch: jest.fn().mockResolvedValue({
                text: 'Done.',
                toolCalls: [],
                finishReason: 'stop',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: 'm',
            }),
        };
        const classifier = { appliesTo: jest.fn().mockResolvedValue(classifierAnswer) };
        const toolService = {
            resolveGrantedTools: jest.fn().mockResolvedValue({ tools: [], refused: [] }),
            releaseMcpRun: jest.fn().mockResolvedValue(undefined),
        };
        const positional: unknown[] = [
            {
                findById: jest.fn().mockResolvedValue({
                    id: 'a1',
                    userId: 'u1',
                    workId: null,
                    name: 'App Engineer',
                    slug: 'app-engineer',
                    soulMd: '# SOUL',
                    permissions: {},
                    maxSkillContextTokens: 4000,
                }),
            },
            runs,
            { append: jest.fn().mockResolvedValue(undefined) },
            { findByAgentId: jest.fn().mockResolvedValue(null) },
            new PromptAssemblerService(),
            { resolveActive: jest.fn().mockResolvedValue([]) },
            { log: jest.fn().mockResolvedValue(undefined) },
            { postReply: jest.fn().mockResolvedValue({ messageId: 'm1' }) },
            { finishTask: jest.fn().mockResolvedValue({ status: 'done' }) },
            toolService,
            ai,
        ];
        while (positional.length < 20) positional.push(undefined);
        positional.push(classifier);
        const svc = new (AgentRunService as unknown as new (...args: unknown[]) => AgentRunService)(
            ...positional,
        );
        return { svc, runs, ai, classifier };
    }

    const ctx = {
        runId: 'r1',
        agentId: 'a1',
        userId: 'u1',
        kind: 'task' as const,
        taskId: 't1',
        immediateInput: 'x',
    };

    it(
        'switch OFF: a run on an App Work Task is failed with the switch code before any model call',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const { svc, runs, ai, classifier } = makeRunService(true);
            const result = await svc.execute(ctx);
            expect(result.status).toBe('dispatch-failed');
            expect(classifier.appliesTo).toHaveBeenCalledWith({ taskId: 't1' });
            expect(runs.markFailed).toHaveBeenCalledWith(
                'r1',
                expect.stringMatching(/^switch_off: /),
            );
            expect(ai.dispatch).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch OFF: a review run is not a change, and runs',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const { svc, runs, classifier } = makeRunService(true);
            await svc.execute({ ...ctx, delegationScope: agentReviewRunScope() });
            // (The review run's own brief gate decides what happens next; the switch does not.)
            expect(classifier.appliesTo).not.toHaveBeenCalledWith({ taskId: 't1' });
            expect(runs.markFailed).not.toHaveBeenCalledWith(
                'r1',
                expect.stringMatching(/^switch_off/),
            );
        }),
    );

    it(
        'switch OFF: a run whose Task is not on an App Work runs',
        withEnv({ [CHANGES]: 'false' }, async () => {
            const { svc, ai } = makeRunService(false);
            await svc.execute(ctx);
            expect(ai.dispatch).toHaveBeenCalled();
        }),
    );

    it(
        'switch ON (default): the run proceeds',
        withEnv({ [CHANGES]: undefined }, async () => {
            const { svc, ai } = makeRunService(true);
            const result = await svc.execute(ctx);
            expect(result.status).toBe('dispatched');
            expect(ai.dispatch).toHaveBeenCalled();
        }),
    );
});

describe('APW-08 T49 — the automatic Deployment of a deployable Build (APW-06 T35)', () => {
    const payload = (over: Record<string, unknown> = {}) =>
        ({
            workId: 'w-1',
            userId: 'u-1',
            buildId: 'b-1',
            number: 7,
            status: 'succeeded',
            trigger: 'push',
            branch: 'main',
            commitSha: 'c'.repeat(40),
            pullRequestNumber: null,
            deployable: true,
            notDeployableReason: null,
            imageDigest: null,
            failureClass: null,
            cancelReason: null,
            ...over,
        }) as never;

    function harness(state: Record<string, unknown>) {
        const request = jest.fn(async () => ({
            status: 'accepted' as const,
            httpStatus: 202,
            code: null,
            deploymentId: 'd-1',
            queuedDeploymentId: null,
            queuedBuildId: null,
        }));
        const listener = new AppBuildSucceededListener(
            { request } as never,
            {
                getOrCreate: jest.fn(async () => state),
                clearPendingDomainRebuild: jest.fn(async () => true),
            },
            { findByWork: jest.fn(async () => []) } as never,
        );
        return { listener, request };
    }

    let enabled: jest.SpyInstance;
    beforeEach(() => {
        enabled = jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
    });
    afterEach(() => enabled.mockRestore());

    it(
        'switch OFF: a merge’s deployable Build deploys nothing by itself',
        withEnv({ [AUTO_DEPLOY]: 'false' }, async () => {
            const { listener, request } = harness({ target: 'your-cluster', targetSettings: {} });
            await expect(
                listener.onBuildSucceeded(new AppBuildSucceededEvent(payload())),
            ).resolves.toEqual({
                requested: false,
                reason: 'switch_off',
            });
            expect(request).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch OFF: the domain-change rebuild the owner asked for still deploys',
        withEnv({ [AUTO_DEPLOY]: 'false' }, async () => {
            const { listener, request } = harness({
                target: 'your-cluster',
                targetSettings: {},
                pendingDomainRebuildBuildId: 'b-1',
            });
            await expect(listener.onBuildSucceeded(payload())).resolves.toMatchObject({
                requested: true,
                trigger: 'domain-change',
            });
            expect(request).toHaveBeenCalledTimes(1);
        }),
    );

    it(
        'an unrecognised value fails closed',
        withEnv({ [AUTO_DEPLOY]: 'nope' }, async () => {
            const { listener, request } = harness({ target: 'your-cluster', targetSettings: {} });
            await listener.onBuildSucceeded(payload());
            expect(request).not.toHaveBeenCalled();
        }),
    );

    it(
        'switch ON (default): deploys as before',
        withEnv({ [AUTO_DEPLOY]: undefined }, async () => {
            const { listener, request } = harness({ target: 'your-cluster', targetSettings: {} });
            await expect(listener.onBuildSucceeded(payload())).resolves.toMatchObject({
                requested: true,
            });
            expect(request).toHaveBeenCalledTimes(1);
        }),
    );
});
