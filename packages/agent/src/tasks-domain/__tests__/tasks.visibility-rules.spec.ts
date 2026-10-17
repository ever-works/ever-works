import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '../../entities/task.entity';
import { TaskChatService } from '../task-chat.service';
import { TasksService } from '../tasks.service';

/**
 * Record visibility (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §3–§4) —
 * the task READ and WRITE rules layered on the owner rule. Each case is one of the
 * replaced `userId = caller` filters:
 *
 *   - `GET /tasks/:id`  → `getReadable`: owner, else `visibleTo`; 404 otherwise.
 *   - `GET /tasks?view` → `mine` = the owner list; `shared` / `organization` =
 *                          `findVisibleFiltered`.
 *   - transition         → owner, or a user assignee / approver / reviewer; another
 *                          reader gets 403; a non-reader 404.
 *   - chat list / post  → anyone who may read; a non-owner's @agent mention never
 *                          dispatches a run.
 *   - writes (update…)  → still `getOne`, owner-only.
 */
describe('Task visibility rules (EW-P1-3)', () => {
    const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
    const shared = {
        id: 'task-1',
        userId: 'owner-1',
        status: TaskStatus.TODO,
        workId: null,
        ...scope,
    };
    const context = {
        principal: { kind: 'user', userId: 'reader-1' },
        organizationId: 'org-1',
        isOrganizationMember: true,
        teamIds: [],
        workIds: [],
    };

    function build(opts: { participant?: boolean; visible?: boolean } = {}) {
        const tasks = {
            findByIdAndUser: jest.fn().mockResolvedValue(null),
            findVisibleById: jest.fn().mockResolvedValue(opts.visible === false ? null : shared),
            findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            findVisibleFiltered: jest.fn().mockResolvedValue({ rows: [shared], total: 1 }),
        };
        const transitions = {
            transition: jest.fn(async (task: { id: string }, to: TaskStatus) => ({
                ...task,
                status: to,
            })),
        };
        const accessPolicy = {
            contextFor: jest.fn().mockResolvedValue(context),
            isTaskParticipant: jest.fn().mockResolvedValue(opts.participant ?? false),
        };
        const positional: unknown[] = new Array(26).fill(undefined);
        positional[0] = tasks;
        positional[1] = {};
        positional[2] = {};
        positional[3] = {};
        positional[4] = {};
        positional[5] = {};
        positional[6] = {};
        positional[7] = transitions;
        // [24] = the domain-event publisher (EW-P1-1 B2), absent here.
        positional[25] = accessPolicy;
        const service = new (TasksService as unknown as new (...args: unknown[]) => TasksService)(
            ...positional,
        );
        return { service, tasks, transitions, accessPolicy };
    }

    describe('getReadable (GET /tasks/:id)', () => {
        it('returns a Task the caller may read but does not own', async () => {
            const { service, tasks, accessPolicy } = build();
            await expect(service.getReadable('reader-1', 'task-1', scope)).resolves.toEqual(shared);
            expect(accessPolicy.contextFor).toHaveBeenCalledWith(
                { kind: 'user', userId: 'reader-1' },
                scope,
            );
            expect(tasks.findVisibleById).toHaveBeenCalledWith('task-1', context, scope);
        });

        it('404s when visibleTo does not admit the caller', async () => {
            const { service } = build({ visible: false });
            await expect(service.getReadable('reader-1', 'task-1', scope)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('stays owner-only in personal scope', async () => {
            const { service, tasks } = build();
            await expect(
                service.getReadable('reader-1', 'task-1', {
                    tenantId: 'tenant-1',
                    organizationId: null,
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(tasks.findVisibleById).not.toHaveBeenCalled();
        });

        it('getOne (every write path’s gate) is still owner-only', async () => {
            const { service, tasks } = build();
            await expect(service.getOne('reader-1', 'task-1', scope)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(tasks.findVisibleById).not.toHaveBeenCalled();
        });
    });

    describe('list view', () => {
        it('mine (default) is the owner list, unchanged', async () => {
            const { service, tasks } = build();
            await service.list('reader-1', {}, {}, scope);
            expect(tasks.findByUserIdFiltered).toHaveBeenCalledWith('reader-1', {}, scope);
            expect(tasks.findVisibleFiltered).not.toHaveBeenCalled();
        });

        it('a shared row embeds its run, loaded under the Task owner (never the caller)', async () => {
            const { service, tasks } = build();
            tasks.findVisibleFiltered.mockResolvedValueOnce({
                rows: [{ ...shared, latestRunId: 'run-1' }],
                total: 1,
            });
            const agentRuns = {
                findByIds: jest.fn().mockResolvedValue([{ id: 'run-1', status: 'running' }]),
            };
            (service as unknown as { agentRuns: unknown }).agentRuns = agentRuns;
            const result = await service.list(
                'reader-1',
                { view: 'organization' },
                { includeRun: true },
                scope,
            );
            expect(agentRuns.findByIds).toHaveBeenCalledWith(['run-1'], 'owner-1', scope);
            expect(result.rows[0]).toEqual(
                expect.objectContaining({ run: expect.objectContaining({ id: 'run-1' }) }),
            );
        });

        it.each(['shared', 'organization'] as const)('%s reads through visibleTo', async (view) => {
            const { service, tasks } = build();
            const result = await service.list('reader-1', { view }, {}, scope);
            expect(tasks.findVisibleFiltered).toHaveBeenCalledWith(context, view, { view }, scope);
            expect(result.rows).toEqual([shared]);
        });
    });

    describe('transition', () => {
        it('a user assignee / approver / reviewer may move a Task they do not own', async () => {
            const { service, transitions, accessPolicy } = build({ participant: true });
            await service.transition('reader-1', 'task-1', TaskStatus.IN_PROGRESS, {}, scope);
            expect(accessPolicy.isTaskParticipant).toHaveBeenCalledWith('task-1', 'reader-1', [
                'assignee',
                'approver',
                'reviewer',
            ]);
            // Review 2026-10-17 F5: a participant never starts the owner's agent runs.
            expect(transitions.transition).toHaveBeenCalledWith(shared, TaskStatus.IN_PROGRESS, {
                force: false,
                suppressAgentDispatch: true,
            });
        });

        // Review 2026-10-17 F5 (P1): `force` skips the approver gate, so the people the
        // gate checks could complete the Task on their own.
        it('a participant may not force a move past the gates (403)', async () => {
            const { service, transitions } = build({ participant: true });
            await expect(
                service.transition('reader-1', 'task-1', TaskStatus.DONE, { force: true }, scope),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('the owner keeps force and starts their own agent runs, exactly as before', async () => {
            const { service, tasks, transitions } = build();
            const own = { ...shared, userId: 'owner-1' };
            tasks.findByIdAndUser.mockResolvedValueOnce(own);
            await service.transition('owner-1', 'task-1', TaskStatus.DONE, { force: true }, scope);
            expect(transitions.transition).toHaveBeenCalledWith(own, TaskStatus.DONE, {
                force: true,
            });
        });

        it('another reader (e.g. an org member or a watcher) gets 403', async () => {
            const { service, transitions } = build({ participant: false });
            await expect(
                service.transition('reader-1', 'task-1', TaskStatus.IN_PROGRESS, {}, scope),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(transitions.transition).not.toHaveBeenCalled();
        });

        it('a non-reader gets 404 (existence never leaks)', async () => {
            const { service } = build({ visible: false, participant: true });
            await expect(
                service.transition('reader-1', 'task-1', TaskStatus.IN_PROGRESS, {}, scope),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('comments', () => {
        function buildChat() {
            const tasks = {
                findByIdAndUser: jest.fn().mockResolvedValue(null),
                findVisibleById: jest.fn().mockResolvedValue(shared),
            };
            const messages = {
                create: jest.fn(async (row: object) => ({ id: 'm1', ...row })),
                findByTaskId: jest.fn().mockResolvedValue([]),
            };
            const runs = { createQueued: jest.fn().mockResolvedValue({ id: 'run-1' }) };
            const chatDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
            const accessPolicy = { contextFor: jest.fn().mockResolvedValue(context) };
            const chat = new TaskChatService(
                tasks as never,
                messages as never,
                { add: jest.fn() } as never,
                undefined,
                runs as never,
                chatDispatcher as never,
                undefined,
                undefined,
                undefined, // domain-event publisher (EW-P1-1 B2)
                accessPolicy as never,
            );
            return { chat, tasks, messages, runs };
        }

        it('a reader may list and post comments', async () => {
            const { chat, messages } = buildChat();
            await chat.list('reader-1', 'task-1', {}, scope);
            expect(messages.findByTaskId).toHaveBeenCalledWith('task-1', 50, 0);
            await chat.post(
                'reader-1',
                { taskId: 'task-1', authorType: 'user', authorId: 'reader-1', body: 'looks good' },
                {},
                scope,
            );
            expect(messages.create).toHaveBeenCalled();
        });

        it("a non-owner's @agent mention is kept on the message but never dispatches a run", async () => {
            const { chat, messages, runs } = buildChat();
            await chat.post(
                'reader-1',
                { taskId: 'task-1', authorType: 'user', authorId: 'reader-1', body: 'hey @ceo' },
                { ownedAgentSlugs: new Map([['ceo', 'agent-1']]) },
                scope,
            );
            await new Promise((resolve) => setImmediate(resolve));
            expect(messages.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    mentions: [expect.objectContaining({ type: 'agent', id: 'agent-1' })],
                }),
            );
            expect(runs.createQueued).not.toHaveBeenCalled();
        });

        it('a non-reader gets 404', async () => {
            const { chat, tasks } = buildChat();
            tasks.findVisibleById.mockResolvedValueOnce(null);
            await expect(chat.list('reader-1', 'task-1', {}, scope)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });
});
