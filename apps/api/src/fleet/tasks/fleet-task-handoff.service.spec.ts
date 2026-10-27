import { NotFoundException } from '@nestjs/common';
import { FleetTaskHandoffService } from './fleet-task-handoff.service';

/**
 * FL-15 P1 — `GET /api/fleet/tasks/:taskId/handoff-options`, the service
 * behind it, against fakes (ACC-FL15-01 … 06).
 *
 * What is pinned: the candidates are the Run-with-agent resolver's, tagged
 * the same way; a pinned Agent leaves only its computer selectable and the
 * pin is never written; an offline computer, one without `--work`, one
 * without the Agent's CLI and someone else's are listed with their reason;
 * a matching checkout makes a new worktree the default; the first message
 * names the Task and its GitHub source.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const NINA = '33333333-3333-4333-8333-333333333333';
const BUILD_01 = '44444444-4444-4444-8444-444444444444';
const BUILD_02 = '55555555-5555-4555-8555-555555555555';
const SHARED = '66666666-6666-4666-8666-666666666666';
const CHECKOUT = '77777777-7777-4777-8777-777777777777';

const node = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
    id,
    userId: OWNER,
    name,
    kind: 'node',
    status: 'online',
    platform: 'linux',
    capabilities: ['sessions', 'claude-code', 'codex'],
    lastHeartbeatAt: new Date(),
    consents: { work: true, attend: false, manage: true, usageScan: false },
    workerState: 'idle',
    sessionDaemon: { state: 'running', sessions: 0 },
    effectiveMaxConcurrentJobs: 2,
    ...patch,
});

function make(
    options: {
        pinnedNodeId?: string | null;
        nodes?: ReturnType<typeof node>[];
        connected?: string[];
    } = {},
) {
    const nodes = options.nodes ?? [node(BUILD_01, 'build-01'), node(BUILD_02, 'build-02')];
    const connected = new Set(options.connected ?? nodes.map((row) => row.id));
    const tasks = {
        getOne: jest.fn(async (_user: string, id: string) => {
            if (id !== TASK_ID) throw new NotFoundException();
            return {
                id: TASK_ID,
                slug: 'T-42',
                title: 'Login form drops the session cookie',
                description: 'Reported in https://github.com/acme/api/issues/910',
                status: 'todo',
                workId: 'work-1',
                branchRef: 'task/login-form',
                acceptanceChecks: [
                    { id: 'unit', name: 'unit tests', kind: 'test', command: 'pnpm test' },
                ],
            };
        }),
        listRunCandidates: jest.fn(async () => [
            { id: NINA, name: 'Nina', source: 'assignee' as const },
        ]),
    };
    const works = {
        findById: jest.fn(async () => ({
            kind: 'directory',
            gitProvider: 'github',
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'api',
            getWebsiteRepo: () => 'api-web',
        })),
    };
    const agents = {
        findByIdAndUser: jest.fn(async () => ({
            id: NINA,
            name: 'Nina',
            slug: 'nina',
            status: 'active',
            organizationId: 'org-1',
            aiProviderId: 'anthropic',
            modelId: 'claude-sonnet',
        })),
    };
    const runs = { findInFlightForTaskAgent: jest.fn(async () => null) };
    const fleetNodes = { findByUser: jest.fn(async () => nodes) };
    const access = {
        listSharedWith: jest.fn(async () => [
            { node: node(SHARED, 'office-mac', { userId: 'someone' }), role: 'member' },
        ]),
    };
    const killSwitch = { isStopped: jest.fn(async () => false) };
    const sessions = { countLiveAgentForNode: jest.fn(async () => 0) };
    const sessionTasks = {
        pinnedNodeId: jest.fn(async () => options.pinnedNodeId ?? null),
        admit: jest.fn(),
    };
    const checkouts = {
        findForNode: jest.fn(async (nodeId: string) =>
            nodeId === BUILD_01
                ? [
                      {
                          id: CHECKOUT,
                          nodeId,
                          path: '/home/me/code/api',
                          kind: 'clone',
                          branch: 'main',
                          remoteUrl: 'https://github.com/acme/api.git',
                          workId: null,
                          state: 'ready',
                          isolation: 'host',
                          updatedAt: new Date(),
                      },
                  ]
                : [],
        ),
    };
    const link = {
        isConnected: (id: string) => connected.has(id),
        liveConsents: () => null,
    };
    const service = new FleetTaskHandoffService(
        tasks as never,
        works as never,
        agents as never,
        runs as never,
        fleetNodes as never,
        access as never,
        killSwitch as never,
        sessions as never,
        sessionTasks as never,
        checkouts as never,
        link as never,
    );
    return { service, sessionTasks };
}

describe('FleetTaskHandoffService.options', () => {
    it('offers the Run-with-agent candidates with their CLI, model and tag (FR-4)', async () => {
        const { service } = make();
        const options = await service.options(OWNER, TASK_ID, null);
        expect(options.agents).toEqual([
            expect.objectContaining({
                id: NINA,
                source: 'assignee',
                cli: 'claude-code',
                modelId: 'claude-sonnet',
            }),
        ]);
        expect(options.agentId).toBe(NINA);
    });

    it('lists every computer, selectable or with its reason (FR-2, U1, U4)', async () => {
        const { service } = make({ connected: [BUILD_01] });
        const options = await service.options(OWNER, TASK_ID, null);
        const byName = Object.fromEntries(options.computers.map((row) => [row.name, row]));
        expect(byName['build-01'].selectable).toBe(true);
        expect(byName['build-02']).toEqual(
            expect.objectContaining({ selectable: false, reason: 'offline' }),
        );
        expect(byName['office-mac']).toEqual(
            expect.objectContaining({ selectable: false, reason: 'no-access' }),
        );
        expect(options.computers[0].name).toBe('build-01');
    });

    it('keeps only the pinned computer selectable and never writes the pin (FR-3)', async () => {
        const { service, sessionTasks } = make({ pinnedNodeId: BUILD_01 });
        const options = await service.options(OWNER, TASK_ID, null);
        const byName = Object.fromEntries(options.computers.map((row) => [row.name, row]));
        expect(byName['build-01']).toEqual(
            expect.objectContaining({ selectable: true, pinned: true }),
        );
        expect(byName['build-02']).toEqual(
            expect.objectContaining({ selectable: false, reason: 'not-pinned' }),
        );
        expect(sessionTasks.admit).not.toHaveBeenCalled();
    });

    it('names a missing CLI and a missing --work (U2, U6)', async () => {
        const { service } = make({
            nodes: [
                node(BUILD_01, 'build-01', { capabilities: ['sessions', 'codex'] }),
                node(BUILD_02, 'build-02', {
                    consents: { work: false, attend: false, manage: true, usageScan: false },
                }),
            ],
        });
        const options = await service.options(OWNER, TASK_ID, null);
        const byName = Object.fromEntries(options.computers.map((row) => [row.name, row]));
        expect(byName['build-01'].reason).toBe('missing-cli');
        expect(byName['build-02'].reason).toBe('needs-work');
    });

    it('defaults to a new worktree where a matching checkout exists, else a fresh clone (FR-5)', async () => {
        const { service } = make();
        const options = await service.options(OWNER, TASK_ID, null);
        const build01 = options.checkouts.find((row) => row.nodeId === BUILD_01)!;
        expect(build01.defaultMode).toBe('worktree');
        expect(build01.matching.map((row) => row.checkoutId)).toEqual([CHECKOUT]);
        expect(options.checkouts.find((row) => row.nodeId === BUILD_02)!.defaultMode).toBe('clone');
        expect(options.task.repository).toBe('acme/api');
    });

    it('prefills the first message with the Task, its source and its branch (FR-7, S3)', async () => {
        const { service } = make();
        const options = await service.options(OWNER, TASK_ID, null);
        expect(options.firstMessage).toContain('Fix T-42 "Login form drops the session cookie".');
        expect(options.firstMessage).toContain('Source: https://github.com/acme/api/issues/910');
        expect(options.firstMessage).toContain('Branch: task/login-form');
        expect(options.firstMessage).toContain('Acceptance: unit tests');
    });

    it('answers the 404 of an unknown Task', async () => {
        const { service } = make();
        await expect(
            service.options(OWNER, '99999999-9999-4999-8999-999999999999', null),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
