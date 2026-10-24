import { readFleetSessionError } from '../fleet-session.errors';
import { FleetSessionTaskService } from '../fleet-session-task.service';

/**
 * FL-15 P1 — `FleetSessionTaskService`, the start-time rules of a Task
 * hand-off (spec FR-3, FR-6, U5, U13) and the Task a session's Run carries
 * (FR-10), against in-memory fakes.
 *
 * What is pinned: an unknown or someone else's Task is a 404; the same Agent
 * already on the Task is `busy` naming the session; a pin on another
 * computer is refused `invalid` and never written; a full computer is
 * `limit_exceeded`; the branch is the stored one, else the branch rule's;
 * run → Task refs are batched and a failed read answers an empty map.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const NODE_ID = '55555555-5555-4555-8555-555555555555';
const PINNED_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const ORG = '99999999-9999-4999-8999-999999999999';

interface FakeTask {
    id: string;
    userId: string;
    organizationId?: string | null;
    slug: string;
    title: string;
    workId: string | null;
    branchRef?: string | null;
}

function make(
    options: {
        tasks?: FakeTask[];
        inflight?: { id: string; fleetSessionId?: string | null } | null;
        pinnedNodeId?: string | null;
        liveAgents?: number;
        runs?: { id: string; taskId: string | null }[];
        failRuns?: boolean;
    } = {},
) {
    const tasks = options.tasks ?? [
        { id: TASK_ID, userId: OWNER, slug: 'T-42', title: 'Login drops cookie', workId: 'w-1', branchRef: null },
    ];
    const taskRepo = {
        findOne: jest.fn(async ({ where }: { where: Partial<FakeTask> }) =>
            tasks.find((task) =>
                Object.entries(where).every(([key, value]) => (task as unknown as Record<string, unknown>)[key] === value),
            ) ?? null,
        ),
        find: jest.fn(async () => tasks),
    };
    const sessions = { countLiveAgentForNode: jest.fn(async () => options.liveAgents ?? 0) };
    const nodes = {
        findById: jest.fn(async (id: string) => (id === PINNED_ID ? { id, name: 'build-02' } : null)),
    };
    const runs = {
        findInFlightForTaskAgent: jest.fn(async () => options.inflight ?? null),
        findByIds: jest.fn(async () => {
            if (options.failRuns) throw new Error('db down');
            return options.runs ?? [];
        }),
    };
    const affinities = {
        findForAgent: jest.fn(async () => (options.pinnedNodeId ? { nodeId: options.pinnedNodeId } : null)),
    };
    const service = new FleetSessionTaskService(
        taskRepo as never,
        sessions as never,
        nodes as never,
        runs as never,
        affinities as never,
    );
    return { service, taskRepo, runs, affinities };
}

const agent = { id: AGENT_ID, name: 'Nina', organizationId: ORG };
const node = { id: NODE_ID, name: 'build-01', effectiveMaxConcurrentJobs: 2 };

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetSessionError(error);
    }
    throw new Error('expected a refusal');
}

describe('FleetSessionTaskService.admit', () => {
    it('answers the Task, its Work and the branch rule when nothing refuses', async () => {
        const { service } = make();
        const admission = await service.admit({ userId: OWNER, agent, node, taskId: TASK_ID });
        expect(admission.taskId).toBe(TASK_ID);
        expect(admission.workId).toBe('w-1');
        expect(admission.slug).toBe('T-42');
        expect(admission.branch).toBe(`task/t-42-${TASK_ID.replace(/-/g, '')}`);
    });

    it('keeps a stored branch', async () => {
        const { service } = make({
            tasks: [{ id: TASK_ID, userId: OWNER, slug: 'T-42', title: 't', workId: 'w-1', branchRef: 'task/kept' }],
        });
        expect((await service.admit({ userId: OWNER, agent, node, taskId: TASK_ID })).branch).toBe('task/kept');
    });

    it('answers 404 for someone else’s Task outside the Agent’s Organization', async () => {
        const { service } = make({
            tasks: [{ id: TASK_ID, userId: OTHER, organizationId: null, slug: 'T-1', title: 't', workId: null }],
        });
        expect((await refusal(service.admit({ userId: OWNER, agent, node, taskId: TASK_ID })))?.code).toBe(
            'not_found',
        );
    });

    it('admits an Organization Task the Agent belongs to', async () => {
        const { service } = make({
            tasks: [{ id: TASK_ID, userId: OTHER, organizationId: ORG, slug: 'T-1', title: 't', workId: null }],
        });
        const admission = await service.admit({ userId: OWNER, agent, node, taskId: TASK_ID });
        expect(admission.branch).toBeNull();
    });

    it('refuses busy while the Agent already works the Task, naming the session (U13)', async () => {
        const { service } = make({ inflight: { id: RUN_ID, fleetSessionId: SESSION_ID } });
        const error = await refusal(service.admit({ userId: OWNER, agent, node, taskId: TASK_ID }));
        expect(error?.code).toBe('busy');
        expect(error?.details).toEqual({ runId: RUN_ID, sessionId: SESSION_ID });
    });

    it('refuses another computer than the pinned one and never writes the pin (FR-3)', async () => {
        const { service, affinities } = make({ pinnedNodeId: PINNED_ID });
        const error = await refusal(service.admit({ userId: OWNER, agent, node, taskId: TASK_ID }));
        expect(error?.code).toBe('invalid');
        expect(error?.hint).toContain('Nina is pinned to build-02');
        expect(Object.keys(affinities)).toEqual(['findForAgent']);
    });

    it('admits the pinned computer itself', async () => {
        const { service } = make({ pinnedNodeId: NODE_ID });
        await expect(service.admit({ userId: OWNER, agent, node, taskId: TASK_ID })).resolves.toBeTruthy();
    });

    it('refuses a computer with no free agent slot (U5)', async () => {
        const { service } = make({ liveAgents: 2 });
        const error = await refusal(service.admit({ userId: OWNER, agent, node, taskId: TASK_ID }));
        expect(error?.code).toBe('limit_exceeded');
        expect(error?.hint).toBe('build-01 is running 2 of 2 agent sessions');
    });

    it('refuses a malformed Task id', async () => {
        const { service } = make();
        expect((await refusal(service.admit({ userId: OWNER, agent, node, taskId: 'nope' })))?.code).toBe('invalid');
    });
});

describe('FleetSessionTaskService.refsForRuns', () => {
    it('maps each Run to its Task and skips Runs without one', async () => {
        const { service } = make({
            runs: [
                { id: RUN_ID, taskId: TASK_ID },
                { id: SESSION_ID, taskId: null },
            ],
        });
        const refs = await service.refsForRuns([RUN_ID, SESSION_ID, RUN_ID]);
        expect(refs.get(RUN_ID)).toEqual({ id: TASK_ID, slug: 'T-42', title: 'Login drops cookie' });
        expect(refs.has(SESSION_ID)).toBe(false);
    });

    it('answers an empty map when the read fails', async () => {
        const { service } = make({ failRuns: true });
        expect((await service.refsForRuns([RUN_ID])).size).toBe(0);
    });
});
