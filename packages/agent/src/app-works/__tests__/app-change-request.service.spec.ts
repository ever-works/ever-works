import { AgentStatus } from '../../entities/agent.entity';
import {
    APP_CHANGE_LABEL,
    AppChangeRequestService,
    changeTitle,
} from '../app-change-request.service';
import {
    AppProvisioningService,
    AppProvisionEventsService,
    extractYaml,
} from '../app-provisioning.service';
import { PROVISION_LABEL } from '../app-change-guard';

/** APW-08 T25 (`POST /api/works/:id/evolve`) and APW-04 (`start`) over the Task machinery. */

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
            relatedRepositories: { website: { owner: 'me', repo: 'helpdesk' } },
        },
        getRepoOwner: () => 'me',
        getDataRepo: () => 'helpdesk-data',
        getWebsiteRepo: () => 'helpdesk',
        ...over,
    } as never;
}

function tasksDouble() {
    return {
        create: jest.fn(async (_userId: string, input: Record<string, unknown>) => ({
            id: 't1',
            slug: 'T-1',
            ...input,
        })),
        runTask: jest.fn(async () => ({
            taskId: 't1',
            agentId: 'a1',
            runId: 'r1',
            dispatched: true,
            parked: false,
        })),
    };
}

describe('AppChangeRequestService (APW-08 T25)', () => {
    it('refuses a non-App Work with 422 notAppWork and creates nothing', async () => {
        const tasks = tasksDouble();
        const service = new AppChangeRequestService(tasks as never);
        const result = await service.request({
            work: appWork({ kind: 'directory' }),
            actorUserId: 'owner',
            request: 'Add a dark mode',
        });
        expect(result).toMatchObject({ status: 'refused', httpStatus: 422, code: 'notAppWork' });
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('answers 409 agentRequired with createFromTemplate when no committing Agent exists', async () => {
        const tasks = tasksDouble();
        const resolver = { resolve: jest.fn(async () => null) };
        const resolverService = { listCandidates: jest.fn(async () => []) };
        const service = new AppChangeRequestService(
            tasks as never,
            undefined,
            undefined,
            resolver,
            resolverService as never,
        );
        const result = await service.request({
            work: appWork(),
            actorUserId: 'owner',
            request: 'x',
        });
        expect(result).toMatchObject({
            status: 'refused',
            httpStatus: 409,
            code: 'agentRequired',
            createFromTemplate: { templateSlug: 'evolve-app', reason: 'noCommittableAgent' },
        });
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('creates an app-change Task for the resolved Agent and starts it through runTask', async () => {
        const tasks = tasksDouble();
        const resolver = {
            resolve: jest.fn(async () => ({ agentId: 'a1', source: 'pinned' as const })),
        };
        const service = new AppChangeRequestService(tasks as never, undefined, undefined, resolver);
        const result = await service.request({
            work: appWork(),
            actorUserId: 'editor',
            request: 'Add a dark mode toggle to the header\nand persist it.',
            channel: 'chat',
        });
        expect(result).toMatchObject({
            status: 'accepted',
            httpStatus: 202,
            taskId: 't1',
            taskSlug: 'T-1',
            runId: 'r1',
            agentId: 'a1',
            agentSource: 'pinned',
            dispatched: true,
            repository: { owner: 'me', repo: 'helpdesk' },
        });
        const [ownerId, input] = tasks.create.mock.calls[0];
        expect(ownerId).toBe('owner');
        expect(input).toMatchObject({
            title: 'Change: Add a dark mode toggle to the header',
            labels: [APP_CHANGE_LABEL],
            workId: 'w1',
            agentId: 'a1',
            createdById: 'editor',
        });
        expect(String(input.description)).toContain('and persist it.');
        expect(String(input.description)).toContain('Never push to or merge the default branch');
        expect(tasks.runTask).toHaveBeenCalledWith(
            'owner',
            't1',
            { agentId: 'a1' },
            expect.anything(),
        );
    });

    it('refuses an explicit Agent that may not commit', async () => {
        const tasks = tasksDouble();
        const agents = {
            findByIdAndUser: jest.fn(async () => ({
                id: 'a2',
                status: AgentStatus.ACTIVE,
                permissions: { canCommitToRepo: false },
                tenantId: null,
                organizationId: null,
            })),
        };
        const service = new AppChangeRequestService(tasks as never, undefined, agents as never);
        const result = await service.request({
            work: appWork(),
            actorUserId: 'owner',
            request: 'x',
            agentId: 'a2',
        });
        expect(result).toMatchObject({
            status: 'refused',
            httpStatus: 422,
            code: 'agentNotEligible',
        });
    });

    it('titles are short', () => {
        expect(changeTitle('x'.repeat(300))).toHaveLength('Change: '.length + 120);
    });
});

describe('AppProvisioningService (APW-04)', () => {
    function git() {
        return {
            getRepository: jest.fn(async () => ({ defaultBranch: 'main' })),
            getWorkContents: jest.fn(async () => [
                { name: 'Dockerfile', type: 'file', path: 'Dockerfile' },
                { name: 'package.json', type: 'file', path: 'package.json' },
            ]),
            getFileContent: jest.fn(async (_o: string, _r: string, path: string) => {
                if (path === 'Dockerfile')
                    return { content: 'FROM node:22\nEXPOSE 3000\n', encoding: 'utf-8' };
                if (path === 'package.json')
                    return {
                        content: Buffer.from(
                            JSON.stringify({ dependencies: { express: '4' } }),
                        ).toString('base64'),
                        encoding: 'base64',
                    };
                return null;
            }),
        };
    }

    it('files an app-provision Task for the resolved Agent and dispatches it', async () => {
        const tasks = tasksDouble();
        const works = { findById: jest.fn(async () => appWork()) };
        const taskRepo = { findByUserIdFiltered: jest.fn(async () => ({ rows: [], total: 0 })) };
        const resolver = {
            resolve: jest.fn(async () => ({ agentId: 'a1', source: 'tenant-default' as const })),
        };
        const service = new AppProvisioningService(
            works as never,
            git() as never,
            tasks as never,
            taskRepo as never,
            resolver,
        );
        // A non-manual trigger answers at once and works behind the answer (RPC callers).
        await expect(service.start({ workId: 'w1', trigger: 'auto-create' })).resolves.toEqual({
            started: true,
            reason: 'queued',
        });
        const result = await service.whenSettled('w1')!;
        expect(result).toMatchObject({
            started: true,
            taskId: 't1',
            agentId: 'a1',
            runId: 'r1',
            draftValid: true,
        });
        expect(result.detection).toMatchObject({
            dockerfile: 'Dockerfile',
            framework: 'express',
            port: 3000,
        });
        const [, input] = tasks.create.mock.calls[0];
        expect(input.labels).toEqual([PROVISION_LABEL]);
        expect(String(input.description)).toContain('Dockerfile found (EXPOSE 3000)');
        expect(String(input.description)).toContain('strategy: dockerfile');
        expect(tasks.runTask).toHaveBeenCalled();
    });

    it('is a no-op while an app-provision Task is open', async () => {
        const tasks = tasksDouble();
        const works = { findById: jest.fn(async () => appWork()) };
        const taskRepo = {
            findByUserIdFiltered: jest.fn(async () => ({
                rows: [{ id: 'open', slug: 'T-9' }],
                total: 1,
            })),
        };
        const service = new AppProvisioningService(
            works as never,
            git() as never,
            tasks as never,
            taskRepo as never,
        );
        await expect(service.start({ workId: 'w1', trigger: 'manual' })).resolves.toMatchObject({
            started: false,
            reason: 'alreadyProvisioning',
            taskId: 'open',
        });
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('without an Agent files the Task unassigned and notifies the owner once', async () => {
        const tasks = tasksDouble();
        const works = { findById: jest.fn(async () => appWork()) };
        const notifications = { create: jest.fn(async () => undefined) };
        const service = new AppProvisioningService(
            works as never,
            git() as never,
            tasks as never,
            undefined,
            { resolve: jest.fn(async () => null) },
            notifications as never,
        );
        const result = await service.start({ workId: 'w1', trigger: 'manual' });
        expect(result).toMatchObject({ started: true, agentId: null, runId: null });
        expect(tasks.runTask).not.toHaveBeenCalled();
        expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('the events port re-provisions on an upstream smoke failure', async () => {
        const provisioning = { start: jest.fn(async () => ({ started: true, reason: null })) };
        const events = new AppProvisionEventsService(provisioning as never);
        await events.smokeFailedAfterUpstreamSync('w1', 'aaa', 'bbb');
        expect(provisioning.start).toHaveBeenCalledWith(
            expect.objectContaining({ workId: 'w1', trigger: 'smoke-failed' }),
        );
    });

    it('extractYaml takes the fenced block of a model answer', () => {
        expect(extractYaml('Sure:\n```yaml\nversion: 2\nkind: app\n```\nDone')).toBe(
            'version: 2\nkind: app\n',
        );
        expect(extractYaml('no spec here')).toBeNull();
    });
});
