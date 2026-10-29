import { FindOperator } from 'typeorm';
import { UnprocessableEntityException } from '@nestjs/common';
import { TaskDeliveryService, APP_CHANGE_ACTIONS } from '../task-delivery.service';
import { TaskStatus, type Task } from '../../entities/task.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

/**
 * APW-08 T21 (ACC-08-16, 18, 19, 20, 22, 43, 45) — `TaskDeliveryService`: the merge hook, the
 * reconciler's compare-and-set writes, closing through the state machine, follow-ups, Close
 * anyway and Try once more.
 *
 * The repositories are in-memory fakes that honour the two guarantees the service leans on: the
 * compare-and-set `WHERE deliveryState = :from` (or `IS NULL`) and the unique
 * `(workId, mergeCommitSha)` index. The CAS's SQL is also asserted per driver, because the
 * platform runs on Postgres, SQLite, MySQL and MariaDB (APW08-G17).
 */

const MERGE = '3f9c2ab000000000000000000000000000000001';
const LATER = 'b0b0b0b000000000000000000000000000000002';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
        const actual = row[key] ?? null;
        if (expected instanceof FindOperator) {
            const type = (expected as unknown as { type: string }).type;
            const value = (expected as unknown as { value: unknown }).value;
            if (type === 'in') return (value as unknown[]).includes(actual);
            if (type === 'isNull') return actual === null;
            if (type === 'not') {
                // `value` unwraps a nested operator; `child` is the operator itself.
                const inner = (expected as unknown as { child?: unknown }).child ?? value;
                return !matches(row, { [key]: inner });
            }
            throw new Error(`fake repo: unsupported operator ${type}`);
        }
        return actual === expected;
    });
}

function fakeRepo<T extends Row>(rows: T[] = [], unique: Array<readonly string[]> = []) {
    const escapes: string[] = [];
    const repo = {
        rows,
        escape: (name: string) => `"${name}"`,
        wheres: [] as string[],
        find: jest.fn(async (options: { where?: Row; take?: number; order?: Row } = {}) => {
            let out = rows.filter((row) => matches(row, options.where ?? {}));
            if (options.order) {
                const [[key, dir]] = Object.entries(options.order);
                out = [...out].sort((a, b) => {
                    const left = new Date(a[key] as never).getTime() || 0;
                    const right = new Date(b[key] as never).getTime() || 0;
                    return dir === 'ASC' ? left - right : right - left;
                });
            }
            return out.slice(0, options.take ?? out.length);
        }),
        findOne: jest.fn(async (options: { where: Row }) => rows.find((row) => matches(row, options.where)) ?? null),
        count: jest.fn(async (options: { where: Row }) => rows.filter((row) => matches(row, options.where)).length),
        manager: { connection: { driver: { escape: (name: string) => repo.escape(name) } } },
        createQueryBuilder: jest.fn(() => {
            let patch: Row = {};
            const params: Row = {};
            const predicates: string[] = [];
            const qb = {
                update: () => qb,
                set: (value: Row) => {
                    patch = value;
                    return qb;
                },
                where: (sql: string, p: Row = {}) => {
                    predicates.push(sql);
                    Object.assign(params, p);
                    return qb;
                },
                andWhere: (sql: string, p: Row = {}) => {
                    predicates.push(sql);
                    Object.assign(params, p);
                    return qb;
                },
                execute: async () => {
                    repo.wheres.push(predicates.join(' AND '));
                    escapes.push(...predicates);
                    const target = rows.find((row) => row.id === params.taskId);
                    if (!target) return { affected: 0 };
                    const wantsNull = predicates.some((sql) => /IS NULL/.test(sql));
                    const current = target.deliveryState ?? null;
                    if (wantsNull ? current !== null : current !== params.fromState) {
                        return { affected: 0 };
                    }
                    const next = { ...target, ...patch };
                    delete (next as Row).updatedAt;
                    for (const columns of unique) {
                        const clash = rows.find(
                            (row) =>
                                row !== target &&
                                columns.every((c) => (next as Row)[c] != null && row[c] === (next as Row)[c]),
                        );
                        if (clash) throw new Error('UNIQUE constraint failed');
                    }
                    Object.assign(target, next);
                    return { affected: 1 };
                },
            };
            return qb;
        }),
    };
    return repo;
}

function task(overrides: Row = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 'T-1',
        status: TaskStatus.IN_REVIEW,
        workId: 'work-1',
        agentId: 'agent-1',
        prNumber: 7,
        prUrl: 'https://example.invalid/pr/7',
        prHeadSha: 'feedface',
        prState: 'merged',
        mergeCommitSha: null,
        deliveryState: null,
        deliveryBuildId: null,
        deliveryDeploymentId: null,
        deliveryUpdatedAt: null,
        deliveryClosedById: null,
        followUpKey: null,
        tenantId: null,
        organizationId: null,
        ...overrides,
    } as unknown as Task;
}

const WORK = {
    id: 'work-1',
    userId: 'user-1',
    name: 'Bookings',
    kind: 'app',
    gitProvider: 'github',
    taskIsolationBaseBranch: null,
    getRepoOwner: () => 'acme',
    getDataRepo: () => 'bookings',
};

const merged = (overrides: Row = {}) => ({
    number: 7,
    state: 'merged' as const,
    merged: true,
    baseRef: 'production',
    mergeCommitSha: MERGE,
    ciState: 'passing' as const,
    checks: [],
    ...overrides,
});

let clock = Date.parse('2026-10-29T10:00:00Z');
const at = () => new Date((clock += 60_000));

function harness(seed: { tasks?: Task[]; builds?: Row[]; deployments?: Row[]; runtime?: Row | null } = {}) {
    const tasks = fakeRepo((seed.tasks ?? [task()]) as unknown as Row[], [['workId', 'mergeCommitSha']]);
    const builds = fakeRepo(seed.builds ?? []);
    const deployments = fakeRepo(seed.deployments ?? []);
    const runtime = fakeRepo(
        seed.runtime === null ? [] : [{ workId: 'work-1', target: 'your-cluster', ...(seed.runtime ?? {}) }],
    );
    const works = { findById: jest.fn(async (id: string) => (id === 'work-1' ? WORK : null)) };
    const specStates = { findByWorkId: jest.fn(async () => ({ trackedBranch: 'production' })) };
    const specs = {
        getEffectiveSpec: jest.fn(async () => ({
            status: 'valid',
            spec: { build: { strategy: 'dockerfile' }, components: [{ name: 'web' }] },
        })),
    };
    const git = { isAncestorCommit: jest.fn(async () => true) };
    const transitions = { transition: jest.fn(async (t: Task, to: TaskStatus) => Object.assign(t, { status: to })) };
    const followUps = {
        open: jest.fn(async () => ({ kind: 'opened', taskId: 'follow-1', dispatched: true })),
        cancelObsolete: jest.fn(async () => 0),
        listFollowUps: jest.fn(async () => []),
    };
    const escalations = {
        getForUser: jest.fn(),
        resolveForTask: jest.fn(async () => true),
    };
    const activityLog = {
        log: jest.fn(async () => ({})),
        findResourceEvents: jest.fn(async () => ({ activities: [], total: 0 })),
    };
    const telemetry = { track: jest.fn() };
    const service = new TaskDeliveryService(
        tasks as never,
        builds as never,
        deployments as never,
        runtime as never,
        works as never,
        specStates as never,
        specs as never,
        git as never,
        transitions as never,
        followUps as never,
        escalations as never,
        activityLog as never,
        telemetry as never,
    );
    return { service, tasks, builds, deployments, runtime, works, specStates, specs, git, transitions, followUps, escalations, activityLog, telemetry };
}

function build(overrides: Row = {}): Row {
    return {
        id: `build-${clock}`,
        workId: 'work-1',
        number: 3,
        status: 'succeeded',
        deployable: true,
        trigger: 'push',
        branch: 'production',
        commitSha: MERGE,
        createdAt: at(),
        logsUrl: 'https://ci.invalid/run/3',
        failureExcerpt: ['npm ERR! build failed'],
        ...overrides,
    };
}

function deployment(overrides: Row = {}): Row {
    return {
        id: `dep-${clock}`,
        workId: 'work-1',
        environment: 'production',
        buildId: null,
        commitSha: MERGE,
        state: 'READY',
        createdAt: at(),
        smokeResult: { inCluster: [], public: [] },
        appRender: { warnings: [] },
        website: 'https://bookings.example.app',
        lastError: null,
        ...overrides,
    };
}

const tracked = (overrides: Row = {}) =>
    task({ mergeCommitSha: MERGE, deliveryState: 'merged', deliveryUpdatedAt: new Date(0), ...overrides });

afterEach(() => {
    delete process.env.EVER_WORKS_APP_AUTO_DEPLOY_ENABLED;
    delete process.env.EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES;
});

describe('TaskDeliveryService — the merge hook (FR-29, FR-33)', () => {
    it('tracks a merge into the App Work tracked branch with a merge commit', async () => {
        const { service } = harness();
        await expect(service.isDeliveryTracked(task(), merged())).resolves.toBe(true);
    });

    it('does not track a merge into another branch (S19)', async () => {
        const { service } = harness();
        await expect(service.isDeliveryTracked(task(), merged({ baseRef: 'staging' }))).resolves.toBe(false);
    });

    it('does not track a non-App Work, or a provider that reported no merge commit', async () => {
        const h = harness();
        await expect(h.service.isDeliveryTracked(task(), merged({ mergeCommitSha: null }))).resolves.toBe(false);
        h.works.findById.mockResolvedValue({ ...WORK, kind: 'directory' } as never);
        await expect(h.service.isDeliveryTracked(task(), merged())).resolves.toBe(false);
    });

    it('an App Work whose spec omits source.branch is still tracked, from APW-03 tracked branch (ACC-08-43)', async () => {
        const h = harness();
        h.specStates.findByWorkId.mockResolvedValue({ trackedBranch: 'main' });
        h.specs.getEffectiveSpec.mockResolvedValue({ status: 'valid', spec: { source: {} } } as never);
        await expect(h.service.isDeliveryTracked(task(), merged({ baseRef: 'main' }))).resolves.toBe(true);
    });

    it("prefers the Work's own isolation base branch when it is set", async () => {
        const h = harness();
        h.works.findById.mockResolvedValue({ ...WORK, taskIsolationBaseBranch: 'release' } as never);
        await expect(h.service.isDeliveryTracked(task(), merged({ baseRef: 'release' }))).resolves.toBe(true);
        await expect(h.service.isDeliveryTracked(task(), merged({ baseRef: 'production' }))).resolves.toBe(false);
    });

    it('records the merge once: merged state, one Activity row, one telemetry event (S29)', async () => {
        const h = harness();
        const t = h.tasks.rows[0] as unknown as Task;
        await expect(h.service.recordMerge(t, merged())).resolves.toEqual({ recorded: true });
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'merged', mergeCommitSha: MERGE });

        const copy = { ...h.tasks.rows[0], deliveryState: null } as unknown as Task;
        await expect(h.service.recordMerge(copy, merged())).resolves.toEqual({ recorded: false });
        expect(h.activityLog.log).toHaveBeenCalledTimes(1);
        expect(h.activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: ActivityActionType.APP_CHANGE,
                action: APP_CHANGE_ACTIONS.merged,
                details: expect.objectContaining({ resourceType: 'task', resourceId: 'task-1', state: 'merged' }),
            }),
        );
        expect(h.telemetry.track).toHaveBeenCalledWith(
            'app.change.merged',
            { workId: 'work-1', taskId: 'task-1' },
            'user-1',
        );
    });

    it('a second Task with the same merge commit on the Work is refused by the unique index', async () => {
        const first = tracked({ id: 'task-0' });
        const h = harness({ tasks: [first, task()] });
        const second = h.tasks.rows[1] as unknown as Task;
        await expect(h.service.recordMerge(second, merged())).resolves.toEqual({ recorded: false });
        expect(h.tasks.rows[1]).toMatchObject({ deliveryState: null });
    });
});

describe.each([
    ['postgres', (n: string) => `"${n}"`],
    ['sqlite', (n: string) => `"${n}"`],
    ['mysql', (n: string) => `\`${n}\``],
    ['mariadb', (n: string) => `\`${n}\``],
])('TaskDeliveryService — portable compare-and-set on %s (ACC-08-45, APW08-G17)', (_driver, escape) => {
    it('spells the CAS with the driver escape, = :from or IS NULL — never IS NOT DISTINCT FROM or <=>', async () => {
        const h = harness({ builds: [build({ status: 'running', deployable: false })] });
        h.tasks.escape = escape;
        await h.service.recordMerge(h.tasks.rows[0] as unknown as Task, merged());
        await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);

        const [mergeWhere, stateWhere] = h.tasks.wheres;
        expect(mergeWhere).toBe(`${escape('id')} = :taskId AND ${escape('deliveryState')} IS NULL`);
        expect(stateWhere).toBe(`${escape('id')} = :taskId AND ${escape('deliveryState')} = :fromState`);
        for (const where of h.tasks.wheres) {
            expect(where).not.toMatch(/IS NOT DISTINCT FROM|<=>/);
        }
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'building' });
    });

    it('a lost race (another worker moved the state) writes nothing and records nothing', async () => {
        const h = harness({ tasks: [tracked()], builds: [build({ status: 'running', deployable: false })] });
        h.tasks.escape = escape;
        const stale = { ...h.tasks.rows[0] } as unknown as Task;
        Object.assign(h.tasks.rows[0], { deliveryState: 'deploying' });
        const outcome = await h.service.reconcileTask(stale);
        expect(outcome.changed).toBe(false);
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'deploying' });
        expect(h.activityLog.log).not.toHaveBeenCalled();
    });
});

describe('TaskDeliveryService — the reconciler (FR-30…FR-40)', () => {
    it('merged → building → live: records the timeline and closes the Task through the state machine (S6)', async () => {
        const b = build({ status: 'running', deployable: false });
        const h = harness({ tasks: [tracked()], builds: [b] });
        const row = h.tasks.rows[0] as unknown as Task;

        await h.service.reconcileTask(row);
        expect(row).toMatchObject({ deliveryState: 'building', deliveryBuildId: b.id });

        Object.assign(b, { status: 'succeeded', deployable: true });
        const d = deployment({ buildId: b.id });
        h.deployments.rows.push(d);
        const outcome = await h.service.reconcileTask(row);

        expect(outcome).toMatchObject({ changed: true, closed: true });
        expect(row).toMatchObject({ deliveryState: 'live', deliveryDeploymentId: d.id });
        expect(h.transitions.transition).toHaveBeenCalledWith(
            row,
            TaskStatus.DONE,
            expect.objectContaining({ actorType: 'agent', ownRunTask: true, livePullRequestHeadSha: 'feedface' }),
        );
        expect(h.followUps.cancelObsolete).toHaveBeenCalledWith(row);
        const actions = h.activityLog.log.mock.calls.map((call) => (call as unknown as [Row])[0].action);
        expect(actions).toEqual([APP_CHANGE_ACTIONS.progressed, APP_CHANGE_ACTIONS.live]);
        expect(h.telemetry.track).toHaveBeenCalledWith(
            'app.change.delivered',
            expect.objectContaining({ workId: 'work-1', taskId: 'task-1', carried: false }),
            'user-1',
        );
    });

    it('a green Build on a target-None App Work closes the Task (S21)', async () => {
        const h = harness({ tasks: [tracked()], builds: [build()], runtime: { target: 'none' } });
        const outcome = await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(outcome).toMatchObject({ closed: true });
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'built' });
    });

    it('auto-deploy off: built, waiting for a person — the Task stays open (S20)', async () => {
        const h = harness({ tasks: [tracked()], builds: [build()], runtime: { targetSettings: { autoDeploy: false } } });
        const outcome = await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(outcome).toMatchObject({ closed: false });
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'built' });
        expect(h.transitions.transition).not.toHaveBeenCalled();
    });

    it('a rolled-back Deployment is deploy_failed and opens the follow-up for THAT Deployment (S7)', async () => {
        const b = build();
        const d = deployment({ buildId: b.id, state: 'ROLLED_BACK', lastError: 'crashloop' });
        const h = harness({ tasks: [tracked()], builds: [b], deployments: [d] });
        const outcome = await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);

        expect(outcome).toMatchObject({ followUp: 'opened', closed: false });
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'deploy_failed' });
        expect(h.followUps.open).toHaveBeenCalledWith(
            expect.objectContaining({
                phase: 'deploy',
                failureId: d.id,
                outcome: 'rolled_back',
                failedSha: MERGE,
                work: expect.objectContaining({ id: 'work-1', name: 'Bookings' }),
            }),
        );
        const actions = h.activityLog.log.mock.calls.map((call) => (call as unknown as [Row])[0].action);
        expect(actions).toEqual([APP_CHANGE_ACTIONS.failed, APP_CHANGE_ACTIONS.followUpOpened]);
        expect(h.telemetry.track).toHaveBeenCalledWith(
            'app.change.delivery_failed',
            { workId: 'work-1', taskId: 'task-1', phase: 'deploy', followUp: true },
            'user-1',
        );
    });

    it('a failed Build opens the build follow-up', async () => {
        const b = build({ status: 'failed', deployable: false });
        const h = harness({ tasks: [tracked()], builds: [b] });
        await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(h.followUps.open).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'build', failureId: b.id, build: expect.objectContaining({ id: b.id }) }),
        );
    });

    it('EVER_WORKS_APP_AUTO_DEPLOY_ENABLED=false: the state is still honest, but no follow-up opens (T49)', async () => {
        process.env.EVER_WORKS_APP_AUTO_DEPLOY_ENABLED = 'false';
        const h = harness({ tasks: [tracked()], builds: [build({ status: 'failed', deployable: false })] });
        await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'build_failed' });
        expect(h.followUps.open).not.toHaveBeenCalled();
    });

    it('a failed change carried to live by a later Deployment closes, and its open follow-ups are cancelled (S24)', async () => {
        const later = deployment({ commitSha: LATER });
        const h = harness({
            tasks: [tracked({ deliveryState: 'deploy_failed' })],
            deployments: [later],
        });
        const outcome = await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(h.git.isAncestorCommit).toHaveBeenCalledWith('acme', 'bookings', MERGE, LATER, {
            userId: 'user-1',
            providerId: 'github',
            workId: 'work-1',
        });
        expect(outcome).toMatchObject({ closed: true });
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'live' });
        expect(h.followUps.cancelObsolete).toHaveBeenCalledTimes(1);
    });

    it('caches the ancestry answer per (work, merge, candidate)', async () => {
        const h = harness({ tasks: [tracked()], deployments: [deployment({ commitSha: LATER, state: 'QUEUED' })] });
        const row = h.tasks.rows[0] as unknown as Task;
        await h.service.reconcileTask(row);
        await h.service.reconcileTask(row);
        expect(h.git.isAncestorCommit).toHaveBeenCalledTimes(1);
    });

    it('a provider that cannot say holds the change at merged — never claims live without proof (§8.2)', async () => {
        const h = harness({ tasks: [tracked()], deployments: [deployment({ commitSha: LATER })] });
        h.git.isAncestorCommit.mockResolvedValue(null as never);
        await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'merged' });
        expect(h.transitions.transition).not.toHaveBeenCalled();
    });

    it('a refused close (an approver gate) leaves the Task where it is, to be retried next tick', async () => {
        const h = harness({ tasks: [tracked()], deployments: [deployment()] });
        h.transitions.transition.mockRejectedValue(new Error('approval pending'));
        const outcome = await h.service.reconcileTask(h.tasks.rows[0] as unknown as Task);
        expect(outcome).toMatchObject({ changed: true, closed: false });
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'live', status: TaskStatus.IN_REVIEW });
    });

    it('reconcile: stalest first, one failing Task does not abort the tick, counters and sweep telemetry', async () => {
        const good = tracked({ id: 'task-good', deliveryUpdatedAt: new Date(2) });
        const bad = tracked({ id: 'task-bad', workId: 'work-boom', deliveryUpdatedAt: new Date(1) });
        // A merge commit is recorded once per Work (the unique index), so the third change has its own.
        const done = tracked({ id: 'task-live', deliveryState: 'live', mergeCommitSha: LATER });
        const h = harness({ tasks: [good, bad, done], builds: [build({ status: 'running', deployable: false })] });
        h.works.findById.mockImplementation(async (id: string) => {
            if (id === 'work-boom') throw new Error('boom');
            return WORK as never;
        });

        const summary = await h.service.reconcile({ limit: 500 });
        expect(h.tasks.find).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
        expect(summary).toMatchObject({ scanned: 2, changed: 1, failed: 1 });
        expect(h.tasks.rows.find((r) => r.id === 'task-good')).toMatchObject({ deliveryState: 'building' });
        expect(h.telemetry.track).toHaveBeenCalledWith(
            'app.change.delivery.sweep',
            expect.objectContaining({ scanned: 2, changed: 1, failed: 1 }),
        );
    });
});

describe('TaskDeliveryService — Close anyway (S9, S20)', () => {
    it.each(['building', 'deploying', 'live', null])('refuses a %s change with 422 notClosable', async (state) => {
        const h = harness({ tasks: [tracked({ deliveryState: state })] });
        await expect(
            h.service.closeWithoutDeploy('user-1', h.tasks.rows[0] as unknown as Task),
        ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'notClosable' }) });
    });

    it('closes a failed change as the person, through the gates, and records who', async () => {
        const h = harness({ tasks: [tracked({ deliveryState: 'deploy_failed' })] });
        const row = h.tasks.rows[0] as unknown as Task;
        const view = await h.service.closeWithoutDeploy('user-1', row, '  accepted as is  ');
        expect(h.transitions.transition).toHaveBeenCalledWith(row, TaskStatus.DONE, { actorType: 'user' });
        expect(row).toMatchObject({ deliveryState: 'closed_without_deploy', deliveryClosedById: 'user-1' });
        expect(view.state).toBe('closed_without_deploy');
        expect(h.activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: APP_CHANGE_ACTIONS.closed, summary: 'Closed without deploying: accepted as is' }),
        );
    });

    it('a gate refusal throws and changes nothing', async () => {
        const h = harness({ tasks: [tracked({ deliveryState: 'built' })] });
        h.transitions.transition.mockRejectedValue(new Error('approvers pending'));
        await expect(h.service.closeWithoutDeploy('user-1', h.tasks.rows[0] as unknown as Task)).rejects.toThrow(
            'approvers pending',
        );
        expect(h.tasks.rows[0]).toMatchObject({ deliveryState: 'built' });
    });

    it('a closed change is never reconciled again — no further follow-up (FR-40)', async () => {
        const h = harness({
            tasks: [tracked({ deliveryState: 'closed_without_deploy' })],
            builds: [build({ status: 'failed', deployable: false })],
        });
        await h.service.reconcile();
        expect(h.followUps.open).not.toHaveBeenCalled();
    });
});

describe('TaskDeliveryService — Try once more (S22, APW08-G21)', () => {
    const escalation = (overrides: Row = {}) => ({
        id: 'esc-1',
        reasonCode: 'delivery-failed',
        status: 'open',
        taskId: 'task-1',
        ...overrides,
    });
    const scope = { tenantId: null, organizationId: null };

    it('consumes the open delivery-failed escalation, then opens one manual follow-up', async () => {
        const d = deployment({ state: 'ERROR' });
        const h = harness({
            tasks: [tracked({ deliveryState: 'deploy_failed', deliveryDeploymentId: d.id })],
            deployments: [d],
        });
        h.escalations.getForUser.mockResolvedValue(escalation());
        const result = await h.service.requestFollowUp('user-1', h.tasks.rows[0] as unknown as Task, 'esc-1', scope);
        expect(result).toEqual({ taskId: 'follow-1' });
        expect(h.escalations.resolveForTask).toHaveBeenCalledWith('esc-1', 'user-1', 'task-1', scope, 'Try once more');
        expect(h.followUps.open).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'deploy', failureId: d.id, outcome: 'failed' }),
            { manual: true },
        );
    });

    it.each([
        ['another Task', { taskId: 'task-9' }],
        ['another reason', { reasonCode: 'gate-exhausted' }],
        ['an already-used item', { status: 'resolved' }],
    ])('refuses %s with 422 followUpLimit and opens nothing', async (_name, overrides) => {
        const h = harness({ tasks: [tracked({ deliveryState: 'build_failed', deliveryBuildId: 'b' })] });
        h.escalations.getForUser.mockResolvedValue(escalation(overrides));
        const attempt = h.service.requestFollowUp('user-1', h.tasks.rows[0] as unknown as Task, 'esc-1', scope);
        await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
        await expect(attempt).rejects.toMatchObject({ response: expect.objectContaining({ code: 'followUpLimit' }) });
        expect(h.followUps.open).not.toHaveBeenCalled();
    });

    it('a replay loses the consume race and is refused with the same code', async () => {
        const h = harness({ tasks: [tracked({ deliveryState: 'build_failed', deliveryBuildId: 'b' })] });
        h.escalations.getForUser.mockResolvedValue(escalation());
        h.escalations.resolveForTask.mockResolvedValue(false);
        await expect(
            h.service.requestFollowUp('user-1', h.tasks.rows[0] as unknown as Task, 'esc-1', scope),
        ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'followUpLimit' }) });
        expect(h.followUps.open).not.toHaveBeenCalled();
    });

    it('a change that is not failed is refused', async () => {
        const h = harness({ tasks: [tracked({ deliveryState: 'live' })] });
        await expect(
            h.service.requestFollowUp('user-1', h.tasks.rows[0] as unknown as Task, 'esc-1', scope),
        ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'followUpLimit' }) });
        expect(h.escalations.getForUser).not.toHaveBeenCalled();
    });
});

describe('TaskDeliveryService — the view (GET /api/tasks/:id/delivery)', () => {
    it('answers the TaskDeliveryView for a live, carried change', async () => {
        const b = build({ commitSha: LATER });
        const d = deployment({ commitSha: LATER, buildId: b.id, appRender: { warnings: [{ code: 'w' }] } });
        const h = harness({
            tasks: [tracked({ deliveryState: 'live', deliveryBuildId: b.id, deliveryDeploymentId: d.id })],
            builds: [b],
            deployments: [d],
        });
        h.activityLog.findResourceEvents.mockResolvedValue({
            activities: [
                { id: 'a2', actionType: 'app_change', createdAt: new Date('2026-10-29T10:10:00Z'), details: { state: 'live' } },
                { id: 'x', actionType: 'task_updated', createdAt: new Date('2026-10-29T10:05:00Z'), details: {} },
                { id: 'a1', actionType: 'app_change', createdAt: new Date('2026-10-29T10:00:00Z'), details: { state: 'merged' } },
            ],
            total: 3,
        } as never);
        h.followUps.listFollowUps.mockResolvedValue([
            { id: 'f1', slug: 'T-2', status: 'cancelled', followUpKey: 'followup:task-1:x' },
        ] as never);

        const view = await h.service.getView(h.tasks.rows[0] as unknown as Task);
        expect(view).toEqual({
            taskId: 'task-1',
            state: 'live',
            mergeCommitSha: MERGE,
            pullRequest: {
                number: 7,
                url: 'https://example.invalid/pr/7',
                base: 'production',
                mergedAt: '2026-10-29T10:00:00.000Z',
            },
            build: { id: b.id, number: 3, status: 'succeeded', commitSha: LATER, logsUrl: 'https://ci.invalid/run/3' },
            deployment: { id: d.id, number: null, status: 'READY', outcome: null },
            liveUrl: 'https://bookings.example.app',
            liveWithWarnings: true,
            carriedByLaterChange: true,
            followUps: [{ taskId: 'f1', slug: 'T-2', status: 'cancelled', automatic: true }],
            history: [
                { state: 'merged', at: '2026-10-29T10:00:00.000Z', activityId: 'a1' },
                { state: 'live', at: '2026-10-29T10:10:00.000Z', activityId: 'a2' },
            ],
        });
    });

    it('an untracked Task answers an empty chain', async () => {
        const h = harness();
        await expect(h.service.getView(h.tasks.rows[0] as unknown as Task)).resolves.toMatchObject({
            state: null,
            build: null,
            deployment: null,
            history: [],
            carriedByLaterChange: false,
        });
    });
});
