import { FindOperator } from 'typeorm';
import {
    DeliveryFollowUpService,
    FOLLOW_UP_NO_LONGER_NEEDED_NOTE,
    deliveryEscalationKeyOf,
    describeFailure,
    failureLogTail,
    followUpKeyOf,
    followUpTitle,
    type DeliveryFailure,
} from '../delivery-follow-up.service';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';

/**
 * APW-08 T21 / T55 (APW08-G23, FR-36…FR-39, S7, S22, S24) — the automatic follow-up Task.
 *
 * The dedup key is a SERVER-written column, never a label: two identical failures open one
 * Task, a label a user adds or clears changes nothing, and the 82-character key fits. The budget
 * is 2 per change along the chain and 3 open per App Work (APW08-G25 defaults, env-overridable);
 * past either, a `delivery-failed` escalation is raised instead, keyed per failure record.
 */

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
            throw new Error(`unsupported operator ${type}`);
        }
        return actual === expected;
    });
}

function repo(rows: Row[]) {
    return {
        rows,
        find: jest.fn(async (o: { where: Row; take?: number }) =>
            rows.filter((r) => matches(r, o.where)).slice(0, o.take ?? rows.length),
        ),
        findOne: jest.fn(async (o: { where: Row }) => rows.find((r) => matches(r, o.where)) ?? null),
        count: jest.fn(async (o: { where: Row }) => rows.filter((r) => matches(r, o.where)).length),
        update: jest.fn(async (where: Row, patch: Row) => {
            const target = rows.find((r) => matches(r, where));
            if (!target) return { affected: 0 };
            if (
                patch.followUpKey &&
                rows.some((r) => r !== target && r.followUpKey === patch.followUpKey)
            ) {
                throw new Error('UNIQUE constraint failed: tasks.followUpKey');
            }
            Object.assign(target, patch);
            return { affected: 1 };
        }),
    };
}

const ORIGINAL = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    slug: 'T-1',
    status: TaskStatus.DONE,
    workId: 'work-1',
    agentId: 'agent-1',
    followUpKey: null,
    tenantId: null,
    organizationId: null,
    createdAt: new Date('2026-10-29T09:00:00Z'),
};
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';

function failure(overrides: Partial<DeliveryFailure> = {}): DeliveryFailure {
    return {
        task: ORIGINAL as unknown as Task,
        work: { id: 'work-1', userId: 'user-1', name: 'Bookings', tenantId: null, organizationId: null },
        phase: 'deploy',
        failureId: DEPLOYMENT_ID,
        failedSha: '3f9c2ab0000000000000000000000000000000aa',
        outcome: 'rolled_back',
        deployment: { id: DEPLOYMENT_ID, state: 'ROLLED_BACK', lastError: 'pod crashloop', appRender: null },
        ...overrides,
    };
}

function harness(seed: { tasks?: Row[]; relations?: Row[]; escalations?: Row[] } = {}) {
    const tasks = repo(seed.tasks ?? [{ ...ORIGINAL }]);
    const relations = repo(seed.relations ?? []);
    const escalationRows = repo(seed.escalations ?? []);
    let created = 0;
    const tasksService = {
        create: jest.fn(async (_userId: string, input: Row, _scope: unknown, options: { withinCreate?: (row: Row, m?: unknown) => Promise<void> }) => {
            created += 1;
            const row: Row = {
                id: `follow-${created}`,
                userId: 'user-1',
                slug: `T-${created + 1}`,
                followUpKey: null,
                deliveryState: null,
                prState: null,
                createdAt: new Date(),
                ...input,
            };
            tasks.rows.push(row);
            try {
                if (options?.withinCreate) await options.withinCreate(row, undefined);
            } catch (error) {
                tasks.rows.splice(tasks.rows.indexOf(row), 1); // the create transaction rolls back
                throw error;
            }
            return row;
        }),
        addRelation: jest.fn(async (_u: string, taskId: string, relatedTaskId: string, kind: string) => {
            relations.rows.push({ id: `rel-${relations.rows.length}`, taskId, relatedTaskId, kind });
            return {};
        }),
        runTask: jest.fn(async () => ({ dispatched: true })),
    };
    const escalations = { record: jest.fn(async (input: Row) => ({ id: 'esc-1', ...input })) };
    const transitions = {
        transition: jest.fn(async (t: Row, to: string) => Object.assign(t, { status: to })),
    };
    const activityLog = { log: jest.fn(async () => ({})) };
    const service = new DeliveryFollowUpService(
        tasks as never,
        relations as never,
        escalationRows as never,
        tasksService as never,
        escalations as never,
        transitions as never,
        activityLog as never,
    );
    return { service, tasks, relations, escalationRows, tasksService, escalations, transitions, activityLog };
}

afterEach(() => {
    delete process.env.EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE;
    delete process.env.EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK;
});

describe('followUpKey — server-side, not a label (APW08-G23)', () => {
    it('is followup:<originalTaskId>:<failureId>, 82 characters for two uuids — over the 80-char label cap', () => {
        const key = followUpKeyOf(ORIGINAL.id, DEPLOYMENT_ID);
        expect(key).toBe(`followup:${ORIGINAL.id}:${DEPLOYMENT_ID}`);
        expect(key).toHaveLength(82);
        expect(key.length).toBeLessThanOrEqual(120);
    });

    it('is written on the follow-up inside its create transaction; the Task carries no label', async () => {
        const h = harness();
        const result = await h.service.open(failure());
        expect(result).toEqual({ kind: 'opened', taskId: 'follow-1', dispatched: true });
        const created = h.tasks.rows.find((r) => r.id === 'follow-1');
        expect(created).toMatchObject({ followUpKey: followUpKeyOf(ORIGINAL.id, DEPLOYMENT_ID) });
        const input = h.tasksService.create.mock.calls[0][1] as Row;
        expect(input.labels).toBeUndefined();
    });

    it('two identical failures open ONE follow-up', async () => {
        const h = harness();
        await h.service.open(failure());
        const second = await h.service.open(failure());
        expect(second).toEqual({ kind: 'exists', taskId: 'follow-1' });
        expect(h.tasksService.create).toHaveBeenCalledTimes(1);
    });

    it('a racing writer that wins the unique key leaves no duplicate Task behind', async () => {
        const h = harness();
        const key = followUpKeyOf(ORIGINAL.id, DEPLOYMENT_ID);
        // Another reconciler's create lands between the pre-check and this one's key write.
        h.tasks.findOne.mockImplementationOnce(async () => null);
        h.tasks.rows.push({ id: 'winner', followUpKey: key, status: TaskStatus.TODO, workId: 'work-1' });
        const result = await h.service.open(failure());
        expect(result).toEqual({ kind: 'exists', taskId: 'winner' });
        expect(h.tasks.rows.filter((r) => r.followUpKey === key)).toHaveLength(1);
        expect(h.tasks.rows.find((r) => r.id === 'follow-1')).toBeUndefined();
    });

    it('a user label that looks like the key changes nothing — the column decides', async () => {
        const key = followUpKeyOf(ORIGINAL.id, DEPLOYMENT_ID);
        const h = harness({
            tasks: [{ ...ORIGINAL }, { id: 'manual', labels: [key], followUpKey: null, status: TaskStatus.TODO, workId: 'work-1' }],
        });
        const result = await h.service.open(failure());
        expect(result.kind).toBe('opened');
    });
});

describe('the follow-up Task (FR-36, S7)', () => {
    it('is High priority, on the same App Work, assigned to the original Agent, related as a follow-up and started', async () => {
        const h = harness();
        await h.service.open(failure());
        expect(h.tasksService.create).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({
                title: 'Fix failed deployment of 3f9c2ab',
                priority: TaskPriority.P1,
                status: TaskStatus.TODO,
                workId: 'work-1',
                agentId: 'agent-1',
            }),
            { tenantId: null, organizationId: null },
            expect.objectContaining({ withinCreate: expect.any(Function) }),
        );
        expect(h.tasksService.addRelation).toHaveBeenCalledWith(
            'user-1',
            'follow-1',
            ORIGINAL.id,
            'follow-up',
            { tenantId: null, organizationId: null },
        );
        expect(h.tasksService.runTask).toHaveBeenCalledWith(
            'user-1',
            'follow-1',
            { agentId: 'agent-1' },
            { tenantId: null, organizationId: null },
        );
    });

    it('is not started when the original Task had no Agent', async () => {
        const h = harness();
        await h.service.open(failure({ task: { ...ORIGINAL, agentId: null } as unknown as Task }));
        expect(h.tasksService.runTask).not.toHaveBeenCalled();
    });

    it('titles a build failure "Fix failed build of {shortSha}"', () => {
        expect(followUpTitle('build', 'abcdef0123456')).toBe('Fix failed build of abcdef0');
        expect(followUpTitle('deploy', null)).toBe('Fix failed deployment of unknown');
    });

    it('fences the failure log as untrusted, redacts secrets and keeps the last 200 lines', () => {
        const excerpt = [
            ...Array.from({ length: 250 }, (_, i) => `line ${i}`),
            'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        ];
        const f = failure({
            phase: 'build',
            build: { id: 'b1', number: 4, status: 'failed', failureExcerpt: excerpt, logsUrl: 'https://ci.invalid/4' },
        });
        const tail = failureLogTail(f);
        expect(tail).toHaveLength(200);
        expect(tail[0]).toBe('line 51');
        expect(tail.join('\n')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

        const text = describeFailure(f);
        expect(text).toMatch(/<untrusted_failure_log id="[^"]+">/);
        expect(text).toContain('- Phase: build');
        expect(text).toContain('- Logs: https://ci.invalid/4');
        expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });

    it('redacts a multi-line PEM private key whole, body lines included (review of #3030)', () => {
        const body = ['MIIEowIBAAKCAQEAsecretbodyline1', 'Zm9vYmFyc2VjcmV0Ym9keWxpbmUy', 'c2VjcmV0Ym9keWxpbmUz'];
        const excerpt = ['step 3 failed', '-----BEGIN RSA PRIVATE KEY-----', ...body, '-----END RSA PRIVATE KEY-----', 'exit 1'];
        const tail = failureLogTail(failure({ phase: 'build', build: { id: 'b1', status: 'failed', failureExcerpt: excerpt } }));
        const text = tail.join('\n');
        for (const line of body) expect(text).not.toContain(line);
        expect(text).toContain('step 3 failed');
        expect(text).toContain('exit 1');
    });

    it('drops the body of a key whose footer was cut off, even when the tail slice would drop its header', () => {
        const body = Array.from({ length: 205 }, (_, i) => `c2VjcmV0a2V5Ym9keQ${i}`);
        const excerpt = ['build output', '-----BEGIN PRIVATE KEY-----', ...body];
        const tail = failureLogTail(failure({ phase: 'build', build: { id: 'b1', status: 'failed', failureExcerpt: excerpt } }));
        const text = tail.join('\n');
        for (const line of body) expect(text).not.toContain(line);
        expect(text).toContain('build output');
    });

    it('names the APW-06 outcome of a deployment failure', () => {
        expect(describeFailure(failure())).toContain('- Outcome: rolled back');
        expect(describeFailure(failure({ outcome: 'rollback_failed' }))).toContain('- Outcome: rollback failed');
    });
});

describe('the follow-up budget (FR-37, FR-38; APW08-G25 CL-08-5)', () => {
    /** original ← follow-1 ← follow-2 (two automatic follow-ups along the chain). */
    function chain() {
        return harness({
            tasks: [
                { ...ORIGINAL },
                { id: 'follow-1', userId: 'user-1', status: TaskStatus.DONE, workId: 'work-1', agentId: 'agent-1', followUpKey: 'followup:a:1' },
                { id: 'follow-2', userId: 'user-1', status: TaskStatus.IN_REVIEW, workId: 'work-1', agentId: 'agent-1', followUpKey: 'followup:b:2', slug: 'T-3', tenantId: null, organizationId: null },
            ],
            relations: [
                { id: 'r1', taskId: 'follow-1', relatedTaskId: ORIGINAL.id, kind: 'follow-up' },
                { id: 'r2', taskId: 'follow-2', relatedTaskId: 'follow-1', kind: 'follow-up' },
            ],
        });
    }

    it('S22 — the third failure along a chain raises the delivery-failed Inbox item instead', async () => {
        const h = chain();
        const failing = h.tasks.rows.find((r) => r.id === 'follow-2') as unknown as Task;
        const result = await h.service.open(failure({ task: failing }));

        expect(result).toEqual({ kind: 'escalated', reason: 'chain-limit', escalationId: 'esc-1' });
        expect(h.tasksService.create).not.toHaveBeenCalled();
        expect(h.escalations.record).toHaveBeenCalledWith(
            expect.objectContaining({
                reasonCode: 'delivery-failed',
                taskId: 'follow-2',
                workId: 'work-1',
                summary: 'Bookings: 3 deployments of this change failed. An agent has tried twice.',
                dedupKey: deliveryEscalationKeyOf('follow-2', DEPLOYMENT_ID),
                confidenceSource: 'heuristic',
            }),
        );
    });

    it('a chain with one follow-up still opens the second', async () => {
        const h = chain();
        h.relations.rows.pop();
        h.tasks.rows.pop();
        const failing = h.tasks.rows.find((r) => r.id === 'follow-1') as unknown as Task;
        await expect(h.service.countChain(failing)).resolves.toBe(1);
        const result = await h.service.open(failure({ task: failing }));
        expect(result.kind).toBe('opened');
    });

    it('EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE raises the per-change limit (owner may change the default)', async () => {
        process.env.EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE = '3';
        const h = chain();
        const failing = h.tasks.rows.find((r) => r.id === 'follow-2') as unknown as Task;
        await expect(h.service.open(failure({ task: failing }))).resolves.toMatchObject({ kind: 'opened' });
    });

    it('at 3 open automatic follow-ups on the App Work, the next failure escalates', async () => {
        const open = (id: string) => ({ id, workId: 'work-1', followUpKey: `followup:${id}:x`, status: TaskStatus.TODO });
        const h = harness({ tasks: [{ ...ORIGINAL }, open('o1'), open('o2'), open('o3'), { id: 'closed', workId: 'work-1', followUpKey: 'k', status: TaskStatus.DONE }] });
        await expect(h.service.countOpenForWork('work-1')).resolves.toBe(3);
        await expect(h.service.open(failure())).resolves.toMatchObject({ kind: 'escalated', reason: 'work-limit' });
    });

    it('an escalation already raised for this failure record is not raised again, and opens nothing', async () => {
        const h = harness({ escalations: [{ id: 'esc-0', dedupKey: deliveryEscalationKeyOf(ORIGINAL.id, DEPLOYMENT_ID) }] });
        await expect(h.service.open(failure())).resolves.toEqual({ kind: 'skipped', reason: 'escalated' });
        expect(h.escalations.record).not.toHaveBeenCalled();
        expect(h.tasksService.create).not.toHaveBeenCalled();
    });

    it('Try once more (manual) opens one more follow-up past both limits', async () => {
        const h = chain();
        const failing = h.tasks.rows.find((r) => r.id === 'follow-2') as unknown as Task;
        await expect(h.service.open(failure({ task: failing }), { manual: true })).resolves.toMatchObject({
            kind: 'opened',
        });
    });

    it('a follow-up that cannot be created raises the escalation — a failure always reaches a person', async () => {
        const h = harness();
        h.tasksService.create.mockRejectedValueOnce(new Error('credits exhausted'));
        await expect(h.service.open(failure())).resolves.toMatchObject({ kind: 'escalated', reason: 'create-failed' });
    });
});

describe('cancelObsolete (FR-39, S24, S8)', () => {
    it('cancels open, unmerged automatic follow-ups with the S24 note, and leaves the rest', async () => {
        const h = harness({
            tasks: [
                { ...ORIGINAL },
                { id: 'open-fix', userId: 'user-1', workId: 'work-1', status: TaskStatus.IN_PROGRESS, followUpKey: 'k1', deliveryState: null, prState: 'open' },
                { id: 'merged-fix', userId: 'user-1', workId: 'work-1', status: TaskStatus.IN_REVIEW, followUpKey: 'k2', deliveryState: 'deploying', prState: 'merged' },
                { id: 'done-fix', userId: 'user-1', workId: 'work-1', status: TaskStatus.DONE, followUpKey: 'k3' },
                { id: 'manual-fix', userId: 'user-1', workId: 'work-1', status: TaskStatus.TODO, followUpKey: null },
            ],
            relations: ['open-fix', 'merged-fix', 'done-fix', 'manual-fix'].map((id) => ({
                id: `r-${id}`,
                taskId: id,
                relatedTaskId: ORIGINAL.id,
                kind: 'follow-up',
            })),
        });
        await expect(h.service.cancelObsolete(ORIGINAL as unknown as Task)).resolves.toBe(1);
        expect(h.transitions.transition).toHaveBeenCalledTimes(1);
        expect(h.transitions.transition).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'open-fix' }),
            TaskStatus.CANCELLED,
            {},
        );
        expect(h.activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'app.change.closed',
                summary: FOLLOW_UP_NO_LONGER_NEEDED_NOTE,
                details: expect.objectContaining({ resourceId: 'open-fix', originalTaskId: ORIGINAL.id }),
            }),
        );
    });
});
