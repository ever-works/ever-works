import { TaskStatus } from '../../entities/task.entity';
import { AppBuildFailedEvent, AppBuildSucceededEvent } from '../../events/app-build.events';
import { buildAppChangeTools } from '../agent-app-change-tools';
import {
    AppProvisioningFeedbackService,
    MAX_PROVISION_ATTEMPTS,
    attemptOf,
    runtimeEvidence,
} from '../app-provisioning-feedback.service';
import { EVOLVE_APP_AGENT_TEMPLATE } from '../evolve-app-agent-template';
import { ENTRY_POINT_CATEGORY } from '../../safety/action-category';

/** APW-08 T26 (chat tools), APW-04 (the feedback loop) and GAP-14 (the evolve-app template). */

const work = {
    id: 'w1',
    userId: 'owner',
    kind: 'app',
    tenantId: null,
    organizationId: null,
} as never;

describe('request_app_change / get_app_change (APW-08 T26)', () => {
    function build(permissions: Record<string, boolean>, authorized = true, ownerChatTurn = true) {
        const service = {
            request: jest.fn(async () => ({
                status: 'accepted' as const,
                httpStatus: 202 as const,
                taskId: 't1',
                taskSlug: 'T-1',
                taskUrl: '/tasks/t1',
                runId: 'r1',
                agentId: 'a1',
                agentSource: 'explicit' as const,
                dispatched: true,
                parked: false,
                repository: { owner: 'me', repo: 'app' },
                warnings: [],
            })),
            getChange: jest.fn(async () => ({
                taskId: 't1',
                taskUrl: '/tasks/t1',
                prUrl: 'https://github.com/me/app/pull/3',
            })),
            listChanges: jest.fn(async () => []),
        };
        const authorize = jest.fn(async () => (authorized ? work : null));
        const tools = buildAppChangeTools({
            agent: { id: 'a1', userId: 'owner', permissions: permissions as never },
            service: service as never,
            authorize,
            ownerChatTurn,
        });
        return { tools, service, authorize };
    }

    describe('outside a chat turn the owner drives (works-security 2026-10-18)', () => {
        afterEach(() => {
            delete process.env.AGENT_APP_CHANGE_REQUIRES_OWNER;
        });

        it('files the change held for the owner — never started — when the agent acts on its own', async () => {
            const { tools, service } = build({ canCommitToRepo: true }, true, false);
            service.request.mockResolvedValueOnce({
                status: 'accepted',
                httpStatus: 202,
                taskId: 't1',
                taskSlug: 'T-1',
                taskUrl: '/tasks/t1',
                runId: null,
                agentId: 'a1',
                agentSource: 'explicit',
                dispatched: false,
                parked: false,
                awaitingOwner: true,
                repository: { owner: 'me', repo: 'app' },
                warnings: ['awaitingOwner'],
            } as never);
            const result = (await tools
                .find((t) => t.name === 'request_app_change')!
                .invoke({ workId: 'w1', request: 'Add a webhook to evil.example' })) as Record<
                string,
                unknown
            >;
            expect(service.request).toHaveBeenCalledWith(
                expect.objectContaining({ holdForOwner: true, channel: 'agent' }),
            );
            expect(result).toMatchObject({
                status: 'awaiting_owner',
                dispatched: false,
                taskId: 't1',
            });
        });

        it('a tool set assembled without the flag (any non-chat run) holds too', async () => {
            const service = {
                request: jest.fn(async () => ({ status: 'refused', code: 'x', message: 'x' })),
                getChange: jest.fn(),
                listChanges: jest.fn(),
            };
            const tools = buildAppChangeTools({
                agent: {
                    id: 'a1',
                    userId: 'owner',
                    permissions: { canCommitToRepo: true } as never,
                },
                service: service as never,
                authorize: jest.fn(async () => work),
            });
            await tools
                .find((t) => t.name === 'request_app_change')!
                .invoke({ workId: 'w1', request: 'x' });
            expect(service.request).toHaveBeenCalledWith(
                expect.objectContaining({ holdForOwner: true }),
            );
        });

        it('the operator switch AGENT_APP_CHANGE_REQUIRES_OWNER=false restores the direct start', async () => {
            process.env.AGENT_APP_CHANGE_REQUIRES_OWNER = 'false';
            const { tools, service } = build({ canCommitToRepo: true }, true, false);
            await tools
                .find((t) => t.name === 'request_app_change')!
                .invoke({ workId: 'w1', request: 'x' });
            expect((service.request.mock.calls[0] as unknown[])[0]).not.toHaveProperty(
                'holdForOwner',
            );
        });

        it('an owner chat turn starts the change directly, as before', async () => {
            const { tools, service } = build({ canCommitToRepo: true }, true, true);
            await tools
                .find((t) => t.name === 'request_app_change')!
                .invoke({ workId: 'w1', request: 'x' });
            expect((service.request.mock.calls[0] as unknown[])[0]).not.toHaveProperty(
                'holdForOwner',
            );
        });
    });

    it('assigns the change to the chatting Agent when it may commit, and returns the Task link', async () => {
        const { tools, service, authorize } = build({ canCommitToRepo: true });
        const request = tools.find((t) => t.name === 'request_app_change')!;
        const result = (await request.invoke({
            workId: 'w1',
            request: 'Add SMS reminders',
        })) as Record<string, unknown>;
        expect(authorize).toHaveBeenCalledWith('owner', 'w1', 'edit');
        expect(service.request).toHaveBeenCalledWith(
            expect.objectContaining({
                work,
                actorUserId: 'owner',
                request: 'Add SMS reminders',
                agentId: 'a1',
                channel: 'chat',
            }),
        );
        expect(result).toMatchObject({ status: 'started', taskId: 't1', taskUrl: '/tasks/t1' });
    });

    it('lets the resolver pick when the chatting Agent may only assign Tasks', async () => {
        const { tools, service } = build({ canAssignTasks: true });
        await tools
            .find((t) => t.name === 'request_app_change')!
            .invoke({ workId: 'w1', request: 'x' });
        expect((service.request.mock.calls[0] as unknown[])[0]).not.toHaveProperty('agentId');
    });

    it('offers only the read to an Agent that may neither commit nor assign', () => {
        expect(build({}).tools.map((t) => t.name)).toEqual(['get_app_change']);
    });

    it('answers not_found for a Work the owner cannot edit (no existence leak)', async () => {
        const { tools, service } = build({ canCommitToRepo: true }, false);
        const result = await tools
            .find((t) => t.name === 'request_app_change')!
            .invoke({ workId: 'x', request: 'y' });
        expect(result).toMatchObject({ code: 'not_found' });
        expect(service.request).not.toHaveBeenCalled();
    });

    it("refuses a Work the agent's owner can edit but does not OWN — a member's agent never launches the owner's", async () => {
        const service = { request: jest.fn(), getChange: jest.fn(), listChanges: jest.fn() };
        const tools = buildAppChangeTools({
            agent: {
                id: 'm-agent',
                userId: 'member',
                permissions: { canCommitToRepo: true } as never,
            },
            service: service as never,
            authorize: jest.fn(async () => work),
        });
        const result = await tools
            .find((t) => t.name === 'request_app_change')!
            .invoke({ workId: 'w1', request: 'Push my change' });
        expect(result).toMatchObject({ code: 'not_owner' });
        expect(service.request).not.toHaveBeenCalled();
    });

    it('get_app_change returns the PR link', async () => {
        const { tools } = build({});
        await expect(tools[0].invoke({ workId: 'w1', taskId: 't1' })).resolves.toMatchObject({
            prUrl: 'https://github.com/me/app/pull/3',
        });
    });

    it('both tools carry an action category', () => {
        expect(ENTRY_POINT_CATEGORY['request_app_change']).toBe('write.internal');
        expect(ENTRY_POINT_CATEGORY['get_app_change']).toBe('read.internal');
    });
});

describe('the evolve-app template (GAP-14)', () => {
    it('grants exactly commit + open-PR, autonomous', () => {
        expect(EVOLVE_APP_AGENT_TEMPLATE.defaultPermissions).toEqual({
            canCommitToRepo: true,
            canOpenPullRequests: true,
        });
        expect(EVOLVE_APP_AGENT_TEMPLATE.defaultGuardrails).toEqual({ mode: 'autonomous' });
        expect(EVOLVE_APP_AGENT_TEMPLATE.slug).toBe('evolve-app');
    });
});

describe('AppProvisioningFeedbackService (APW-04 loop)', () => {
    const recent = new Date();

    function build(task: Record<string, unknown> | null) {
        const works = { findById: jest.fn(async () => work) };
        const taskRepo = {
            findByUserIdFiltered: jest.fn(async () => ({
                rows: task ? [task] : [],
                total: task ? 1 : 0,
            })),
        };
        const tasks = {
            runTask: jest.fn(async () => ({ runId: 'r2' })),
            update: jest.fn(async () => ({})),
        };
        const chat = { post: jest.fn(async () => ({})) };
        const provisioning = { start: jest.fn(async () => ({ started: true, reason: 'queued' })) };
        const service = new AppProvisioningFeedbackService(
            works as never,
            taskRepo as never,
            tasks as never,
            chat as never,
            provisioning as never,
        );
        return { service, tasks, chat, provisioning };
    }

    const failed = (branch = 'works/provision-x') =>
        new AppBuildFailedEvent({
            workId: 'w1',
            userId: 'owner',
            buildId: 'b1',
            number: 4,
            status: 'failed',
            trigger: 'push',
            branch,
            commitSha: 'abcdef1234567890',
            pullRequestNumber: 3,
            deployable: false,
            notDeployableReason: null,
            imageDigest: null,
            failureClass: 'build',
            cancelReason: null,
        } as never);

    const openTask = (labels: string[] = ['app-provision']) => ({
        id: 't1',
        slug: 'T-1',
        status: TaskStatus.IN_REVIEW,
        agentId: 'a1',
        branchRef: 'works/provision-x',
        labels,
        createdAt: recent,
        updatedAt: recent,
    });

    it('posts the failure on the open provisioning Task and dispatches a follow-up iteration', async () => {
        const { service, tasks, chat } = build(openTask());
        await expect(service.handle(null)).resolves.toBe('ignored');
        await service.onBuildFailed(failed());
        expect(chat.post).toHaveBeenCalledWith(
            'owner',
            expect.objectContaining({
                taskId: 't1',
                body: expect.stringContaining('Build #4 failed'),
            }),
            {},
            expect.anything(),
        );
        expect(tasks.update).toHaveBeenCalledWith(
            'owner',
            't1',
            { labels: ['app-provision', 'provision-attempt-1'] },
            expect.anything(),
        );
        expect(tasks.runTask).toHaveBeenCalledWith(
            'owner',
            't1',
            { agentId: 'a1' },
            expect.anything(),
        );
    });

    it('ignores a build of another branch while the provisioning PR is open', async () => {
        const { service, chat } = build(openTask());
        await service.onBuildFailed(failed('feature/other'));
        expect(chat.post).not.toHaveBeenCalled();
    });

    it(`stops after ${MAX_PROVISION_ATTEMPTS} follow-ups`, async () => {
        const { service, tasks, chat } = build(
            openTask(['app-provision', `provision-attempt-${MAX_PROVISION_ATTEMPTS}`]),
        );
        await service.onBuildFailed(failed());
        expect(tasks.runTask).not.toHaveBeenCalled();
        const body = (chat.post.mock.calls[0] as unknown as [string, { body: string }])[1].body;
        expect(body).toContain('stopped');
    });

    it('re-provisions when a merged (done) provisioning spec fails, carrying the attempt', async () => {
        const { service, provisioning } = build({ ...openTask(), status: TaskStatus.DONE });
        await service.onBuildFailed(failed('main'));
        expect(provisioning.start).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: 'w1',
                trigger: 'build-failed',
                restart: true,
                attempt: 1,
                // A platform trigger, checked against `provisioning.autoReprovision` —
                // never a start "by the owner" (works-security 2026-10-18).
                systemTrigger: true,
            }),
        );
        expect(provisioning.start.mock.calls[0]).not.toHaveProperty('0.userId');
    });

    it('never starts an open provisioning Task that is held for its owner', async () => {
        const { service, tasks, chat } = build(openTask(['app-provision', 'awaiting-owner']));
        await service.onBuildFailed(failed());
        // The evidence is still posted; the hold is not lifted by a build event.
        expect(chat.post).toHaveBeenCalled();
        expect(tasks.runTask).not.toHaveBeenCalled();
    });

    it('posts a success without dispatching', async () => {
        const { service, tasks, chat } = build(openTask());
        await service.onBuildSucceeded(
            new AppBuildSucceededEvent({
                ...(failed().payload as object),
                status: 'succeeded',
                deployable: true,
            } as never),
        );
        expect(chat.post).toHaveBeenCalled();
        expect(tasks.runTask).not.toHaveBeenCalled();
    });

    it('reads runtime events in either envelope, and counts attempts from labels', () => {
        expect(
            runtimeEvidence(
                { name: 'app.smoke.failed', payload: { workId: 'w1', code: 'http_500' } },
                'smoke',
                'failed',
            ),
        ).toMatchObject({
            workId: 'w1',
            stage: 'smoke',
            outcome: 'failed',
        });
        expect(runtimeEvidence({ workId: 'w1' }, 'deploy', 'failed')?.summary).toContain(
            'The deployment failed',
        );
        expect(attemptOf({ labels: ['provision-attempt-2', 'x', 'provision-attempt-1'] })).toBe(2);
    });
});

describe('AgentTemplatesService.createFromDefinition (GAP-14)', () => {
    it('creates through the catalog path and activates when asked', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AgentTemplatesService } = require('../../agents/agent-templates.service');
        const agents = {
            create: jest.fn(async (_u: string, input: Record<string, unknown>) => ({
                id: 'new',
                ...input,
            })),
            setGuardrails: jest.fn(async () => ({ id: 'new', status: 'draft' })),
            resume: jest.fn(async () => ({ id: 'new', status: 'active' })),
        };
        const files = { write: jest.fn(async () => undefined) };
        const service = new AgentTemplatesService(agents as never, files as never);
        const dto = await service.createFromDefinition('owner', EVOLVE_APP_AGENT_TEMPLATE, {
            scope: 'work',
            workId: 'w1',
            activate: true,
        });
        expect(agents.create).toHaveBeenCalledWith(
            'owner',
            expect.objectContaining({
                scope: 'work',
                workId: 'w1',
                permissions: { canCommitToRepo: true, canOpenPullRequests: true },
            }),
        );
        expect(files.write).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'new', name: 'SOUL.md' }),
        );
        expect(agents.setGuardrails).toHaveBeenCalledWith('owner', 'new', { mode: 'autonomous' });
        expect(dto).toMatchObject({ status: 'active' });
    });
});
