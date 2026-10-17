jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: {
        BACKLOG: 'backlog',
        TODO: 'todo',
        IN_PROGRESS: 'in_progress',
        IN_REVIEW: 'in_review',
        BLOCKED: 'blocked',
        DONE: 'done',
        CANCELLED: 'cancelled',
    },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: () => ({ tenantId: null, organizationId: null }),
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { REQUIRE_SCOPES_KEY } from '../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../auth/integration/integration-http.exception';

/**
 * EW-P1-2 — the two Task writes open to integration keys (`tasks:write`):
 * create and chat. The guards (scopes, org pin, act-as) are covered over HTTP in
 * `auth/integration/__tests__/integration-keys.http.spec.ts`; this pins what the
 * controller itself does for an integration principal:
 *
 *   - attribution: `createdByType`/`authorType` = `'integration'` and the key id
 *     without act-as, the person with act-as;
 *   - spend safety (D9): no `scheduledAt`, no relaxed approver policy, a start
 *     status of backlog/todo only, and chat `@agent` mentions never resolved
 *     (so no agent reply run is dispatched).
 */
describe('TasksController — integration principal (EW-P1-2)', () => {
    const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const TASK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const scope = { tenantId: 't-1', organizationId: 'o-1' };

    const integration = (actAsUserId: string | null) =>
        ({
            userId: actAsUserId ?? OWNER,
            authMethod: 'integration',
            integration: {
                keyId: KEY,
                keyName: 'Gauzy',
                integrationKind: 'ever-gauzy',
                tenantId: 't-1',
                allowedOrganizationIds: ['o-1'],
                scopes: ['tasks:write'],
                ownerUserId: OWNER,
                actAsUserId,
            },
        }) as never;
    const session = { userId: OWNER, authMethod: 'session' } as never;

    function build() {
        const service = {
            create: jest.fn().mockResolvedValue({ id: TASK }),
            transition: jest.fn().mockResolvedValue({ id: TASK, status: 'todo' }),
            syncTransition: jest.fn().mockResolvedValue({
                task: { id: TASK, status: 'done' },
                from: 'backlog',
                path: ['todo', 'in_progress', 'done'],
            }),
            getReadable: jest.fn().mockResolvedValue({ id: TASK, visibility: 'organization' }),
        };
        const chat = { post: jest.fn().mockResolvedValue({ id: 'm-1' }) };
        const agents = {
            findByUserIdScoped: jest
                .fn()
                .mockResolvedValue({ rows: [{ id: 'ag-1', slug: 'builder' }] }),
        };
        const controller = new TasksController(
            service as never,
            chat as never,
            {} as never,
            agents as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { getScope: () => scope } as never,
        );
        return { controller, service, chat, agents };
    }

    it('declares tasks:write on create, chat and transition, and nothing on other routes', () => {
        const proto = TasksController.prototype as unknown as Record<string, object>;
        expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, proto.create)).toEqual(['tasks:write']);
        expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, proto.postChat)).toEqual(['tasks:write']);
        // EW-P1-6 — sync transitions.
        expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, proto.transition)).toEqual(['tasks:write']);
        for (const name of ['list', 'getOne', 'update', 'remove', 'listChat']) {
            if (proto[name])
                expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, proto[name])).toBeUndefined();
        }
    });

    it('attributes a create without act-as to the integration key, owned by the key owner', async () => {
        const { controller, service } = build();
        await controller.create(integration(null), { title: 'From Gauzy' } as never);
        const [owner, input] = service.create.mock.calls[0];
        expect(owner).toBe(OWNER);
        expect(input).toMatchObject({ createdByType: 'integration', createdById: KEY });
    });

    it('attributes a create with act-as to the person', async () => {
        const { controller, service } = build();
        await controller.create(integration(MEMBER), { title: 'For Jane' } as never);
        const [owner, input] = service.create.mock.calls[0];
        expect(owner).toBe(MEMBER);
        expect(input).toMatchObject({ createdByType: 'user', createdById: MEMBER });
    });

    it('keeps a session create attributed to the user', async () => {
        const { controller, service } = build();
        await controller.create(session, {
            title: 'Mine',
            scheduledAt: new Date(Date.now() + 1e6).toISOString(),
        } as never);
        expect(service.create.mock.calls[0][1]).toMatchObject({
            createdByType: 'user',
            createdById: OWNER,
        });
    });

    it.each([
        ['scheduledAt', { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }],
        ['requireAllApprovers', { requireAllApprovers: false }],
        ['status', { status: 'in_progress' }],
    ])('refuses %s from an integration with 422 domain_rule (D9)', async (_field, extra) => {
        const { controller, service } = build();
        const err = await controller
            .create(integration(null), { title: 't', ...extra } as never)
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IntegrationHttpException);
        expect((err as IntegrationHttpException).getStatus()).toBe(422);
        expect((err as IntegrationHttpException).code).toBe('domain_rule');
        expect(service.create).not.toHaveBeenCalled();
    });

    it('lets an integration create in backlog or todo', async () => {
        const { controller, service } = build();
        await controller.create(integration(null), { title: 't', status: 'todo' } as never);
        await controller.create(integration(null), { title: 't', status: 'backlog' } as never);
        expect(service.create).toHaveBeenCalledTimes(2);
    });

    it('posts chat as the integration and never resolves @agent mentions (no agent run)', async () => {
        const { controller, chat, agents } = build();
        await controller.postChat(integration(null), TASK, { body: '@builder please' } as never);
        const [owner, input, lookups] = chat.post.mock.calls[0];
        expect(owner).toBe(OWNER);
        expect(input).toMatchObject({ authorType: 'integration', authorId: KEY });
        expect(lookups).toEqual({});
        expect(agents.findByUserIdScoped).not.toHaveBeenCalled();
    });

    it('posts chat with act-as as the person, still without agent lookups', async () => {
        const { controller, chat } = build();
        await controller.postChat(integration(MEMBER), TASK, { body: 'hi' } as never);
        const [owner, input, lookups] = chat.post.mock.calls[0];
        expect(owner).toBe(MEMBER);
        expect(input).toMatchObject({ authorType: 'user', authorId: MEMBER });
        expect(lookups).toEqual({});
    });

    it('still resolves @agent mentions for a session user', async () => {
        const { controller, chat, agents } = build();
        await controller.postChat(session, TASK, { body: '@builder go' } as never);
        expect(agents.findByUserIdScoped).toHaveBeenCalled();
        expect(chat.post.mock.calls[0][2].ownedAgentSlugs.get('builder')).toBe('ag-1');
    });

    // ── EW-P1-6 — sync transitions ───────────────────────────────────────

    it('mode sync walks through the service and answers the Task', async () => {
        const { controller, service } = build();
        const out = await controller.transition(integration(null), TASK, {
            to: 'done',
            mode: 'sync',
        } as never);
        expect(service.syncTransition).toHaveBeenCalledWith(
            OWNER,
            TASK,
            'done',
            { force: false },
            scope,
        );
        expect(service.transition).not.toHaveBeenCalled();
        expect(out).toEqual({ id: TASK, status: 'done' });
    });

    it('an integration must use mode sync and can never force (422 domain_rule)', async () => {
        const { controller, service } = build();
        for (const body of [{ to: 'todo' }, { to: 'done', mode: 'sync', force: true }]) {
            const err = await controller
                .transition(integration(null), TASK, body as never)
                .catch((e: unknown) => e);
            expect(err).toBeInstanceOf(IntegrationHttpException);
            expect((err as IntegrationHttpException).code).toBe('domain_rule');
        }
        expect(service.transition).not.toHaveBeenCalled();
        expect(service.syncTransition).not.toHaveBeenCalled();
    });

    // ── Review 2026-10-17 F6 — never a private Task through the core routes ──

    it('answers 404 to an integration for a private Task (transition, chat, create parent)', async () => {
        const { controller, service, chat } = build();
        service.getReadable.mockResolvedValue({ id: TASK, visibility: 'private' });
        await expect(
            controller.transition(integration(null), TASK, { to: 'todo', mode: 'sync' } as never),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            controller.postChat(integration(MEMBER), TASK, { body: 'hi' } as never),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            controller.create(integration(null), { title: 'Child', parentTaskId: TASK } as never),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(service.getReadable).toHaveBeenCalledWith(MEMBER, TASK, scope);
        expect(service.syncTransition).not.toHaveBeenCalled();
        expect(chat.post).not.toHaveBeenCalled();
        expect(service.create).not.toHaveBeenCalled();
    });

    it('a session never pays the extra read (its own private Tasks are its own)', async () => {
        const { controller, service } = build();
        service.getReadable.mockResolvedValue({ id: TASK, visibility: 'private' });
        await controller.transition(session, TASK, { to: 'todo' } as never);
        await controller.postChat(session, TASK, { body: 'hi' } as never);
        await controller.create(session, { title: 'Child', parentTaskId: TASK } as never);
        expect(service.getReadable).not.toHaveBeenCalled();
    });

    it('a session keeps the single-edge move, and may opt into sync mode', async () => {
        const { controller, service } = build();
        await controller.transition(session, TASK, { to: 'todo' } as never);
        expect(service.transition).toHaveBeenCalledWith(
            OWNER,
            TASK,
            'todo',
            { force: false },
            scope,
        );
        await controller.transition(session, TASK, {
            to: 'done',
            mode: 'sync',
            force: true,
        } as never);
        expect(service.syncTransition).toHaveBeenCalledWith(
            OWNER,
            TASK,
            'done',
            { force: true },
            scope,
        );
    });
});
