import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskChatService } from '../task-chat.service';
import { ActivityActionType } from '../../entities/activity-log.types';

describe('TaskChatService', () => {
    let tasks: any;
    let messages: any;
    let kbMentions: any;
    let activity: any;
    let svc: TaskChatService;

    beforeEach(() => {
        tasks = { findByIdAndUser: jest.fn() };
        messages = {
            findByTaskId: jest.fn().mockResolvedValue([]),
            findById: jest.fn(),
            create: jest.fn(),
            updateBody: jest.fn().mockResolvedValue(undefined),
            // Review-fix I3 (test sync): service now calls this on edit
            // instead of updateBody so re-parsed mentions persist.
            updateBodyAndMentions: jest.fn().mockResolvedValue(undefined),
        };
        kbMentions = { add: jest.fn().mockResolvedValue({}) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        svc = new TaskChatService(tasks, messages, kbMentions, activity);
    });

    describe('post', () => {
        it('404s for a cross-user Task', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(
                svc.post('u1', {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'hello',
                }),
            ).rejects.toThrow(NotFoundException);
        });

        it('rejects empty body', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            await expect(
                svc.post('u1', { taskId: 't1', authorType: 'user', authorId: 'u1', body: '   ' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects secret-bearing body', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            await expect(
                svc.post('u1', {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'use ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx now',
                }),
            ).rejects.toThrow(/Secret-like/);
        });

        it('strips unknown @mentions (T6 mitigation — model never sees a hallucinated reference)', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));
            await svc.post('u1', {
                taskId: 't1',
                authorType: 'user',
                authorId: 'u1',
                body: 'hey @does-not-exist take a look',
            });
            const createArg = messages.create.mock.calls[0][0];
            expect(createArg.mentions).toBeNull();
        });

        it('resolves a known @agent mention against the lookup map', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));
            await svc.post(
                'u1',
                {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'hey @ceo, look at this',
                },
                { ownedAgentSlugs: new Map([['ceo', 'agent-a1']]) },
            );
            const createArg = messages.create.mock.calls[0][0];
            expect(createArg.mentions).toEqual([{ type: 'agent', id: 'agent-a1', slug: 'ceo' }]);
        });

        it('materializes [[kb-doc]] references into task_kb_mentions', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));
            await svc.post(
                'u1',
                {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'See [[architecture-overview]] for context.',
                },
                { knownKbSlugs: new Map([['architecture-overview', 'kb-doc-1']]) },
            );
            expect(kbMentions.add).toHaveBeenCalledWith('t1', 'kb-doc-1');
        });

        it('emits TASK_COMMENTED activity', async () => {
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockResolvedValueOnce({ id: 'm1' });
            await svc.post('u1', { taskId: 't1', authorType: 'user', authorId: 'u1', body: 'hi' });
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.TASK_COMMENTED }),
            );
        });

        it('passes the pre-created AgentRun id to the chat reply dispatcher', async () => {
            const runs = { createQueued: jest.fn().mockResolvedValue({ id: 'run-chat-1' }) };
            const chatDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
            const dispatchingSvc = new TaskChatService(
                tasks,
                messages,
                kbMentions,
                activity,
                runs as any,
                chatDispatcher,
            );
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));

            await dispatchingSvc.post(
                'u1',
                {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'hey @ceo, look at this',
                },
                { ownedAgentSlugs: new Map([['ceo', 'agent-a1']]) },
            );
            await new Promise((resolve) => setImmediate(resolve));

            expect(runs.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({
                    agentId: 'agent-a1',
                    userId: 'u1',
                    triggerKind: 'chat',
                    taskId: 't1',
                    chatMessageId: 'm1',
                }),
            );
            expect(chatDispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'run-chat-1' }),
            );
        });

        it('transitions AgentRun to failed and does not fail comment posting if enqueue throws', async () => {
            const runs = {
                createQueued: jest.fn().mockResolvedValue({ id: 'run-chat-1' }),
                markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            };
            const chatDispatcher = {
                enqueue: jest.fn().mockRejectedValue(new Error('Trigger.dev down')),
            };
            const dispatchingSvc = new TaskChatService(
                tasks,
                messages,
                kbMentions,
                activity,
                runs as any,
                chatDispatcher,
            );
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));

            const result = await dispatchingSvc.post(
                'u1',
                {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'hey @ceo, look at this',
                },
                { ownedAgentSlugs: new Map([['ceo', 'agent-a1']]) },
            );

            expect(result.id).toBe('m1'); // Post comment itself succeeded

            await new Promise((resolve) => setImmediate(resolve));

            // Pin the `dispatch-failed:` prefix, not just the underlying cause —
            // it is what surfaces in the Activity tab for an orphaned run.
            expect(runs.markDispatchFailed).toHaveBeenCalledWith(
                'run-chat-1',
                expect.stringContaining('dispatch-failed: Trigger.dev down'),
            );
        });

        it('does not attempt markDispatchFailed when the queued run was never created', async () => {
            const runs = {
                createQueued: jest.fn().mockRejectedValue(new Error('DB down')),
                markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            };
            const chatDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
            const dispatchingSvc = new TaskChatService(
                tasks,
                messages,
                kbMentions,
                activity,
                runs as any,
                chatDispatcher,
            );
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));

            const result = await dispatchingSvc.post(
                'u1',
                {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'hey @ceo, look at this',
                },
                { ownedAgentSlugs: new Map([['ceo', 'agent-a1']]) },
            );

            expect(result.id).toBe('m1'); // Post comment itself succeeded

            await new Promise((resolve) => setImmediate(resolve));

            // `run` is still null here, so the `if (run)` guard must short-circuit.
            // Without it this path throws TypeError on `run.id`.
            expect(chatDispatcher.enqueue).not.toHaveBeenCalled();
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        });

        it('gracefully handles enqueue failures when runs repository is missing', async () => {
            const chatDispatcher = {
                enqueue: jest.fn().mockRejectedValue(new Error('Trigger.dev down')),
            };
            const dispatchingSvc = new TaskChatService(
                tasks,
                messages,
                kbMentions,
                activity,
                undefined,
                chatDispatcher,
            );
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            messages.create.mockImplementationOnce((d: any) => Promise.resolve({ id: 'm1', ...d }));

            const result = await dispatchingSvc.post(
                'u1',
                {
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    body: 'hey @ceo, look at this',
                },
                { ownedAgentSlugs: new Map([['ceo', 'agent-a1']]) },
            );

            expect(result.id).toBe('m1'); // Post comment itself succeeded

            await new Promise((resolve) => setImmediate(resolve));

            // No runs repository ⇒ no row was ever persisted, so dispatch still had
            // to be attempted with an undefined runId, and reconciliation must be
            // skipped rather than throwing. Asserting the runId pins the `run?.id`
            // behaviour that hoisting `run` out of the try block could have broken.
            expect(chatDispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ runId: undefined }),
            );
        });
    });

    describe('edit', () => {
        it('404s for a non-existent message', async () => {
            messages.findById.mockResolvedValueOnce(null);
            await expect(svc.edit('u1', 'gone', 'x')).rejects.toThrow(NotFoundException);
        });

        it('refuses to edit an agent-authored message', async () => {
            messages.findById.mockResolvedValueOnce({
                id: 'm1',
                taskId: 't1',
                authorType: 'agent',
                authorId: 'agent-a1',
                createdAt: new Date(),
            });
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            await expect(svc.edit('u1', 'm1', 'edit')).rejects.toThrow(ForbiddenException);
        });

        it('refuses when the user is not the original author', async () => {
            messages.findById.mockResolvedValueOnce({
                id: 'm1',
                taskId: 't1',
                authorType: 'user',
                authorId: 'somebody-else',
                createdAt: new Date(),
            });
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            await expect(svc.edit('u1', 'm1', 'edit')).rejects.toThrow(ForbiddenException);
        });

        it('refuses past the 5-minute edit window', async () => {
            messages.findById.mockResolvedValueOnce({
                id: 'm1',
                taskId: 't1',
                authorType: 'user',
                authorId: 'u1',
                createdAt: new Date(Date.now() - 10 * 60_000),
            });
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            await expect(svc.edit('u1', 'm1', 'edit')).rejects.toThrow(/Edit window has expired/);
        });

        it('happy path — within window, persists new body + re-parsed mentions', async () => {
            messages.findById
                .mockResolvedValueOnce({
                    id: 'm1',
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    createdAt: new Date(Date.now() - 30_000),
                })
                .mockResolvedValueOnce({ id: 'm1', body: 'new', editedAt: new Date() });
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            const out = await svc.edit('u1', 'm1', 'new');
            // Review-fix I3: service now uses updateBodyAndMentions so
            // the mentions JSON column stays honest if the user removed
            // a mention mid-edit. Passing `null` for empty mention sets.
            expect(messages.updateBodyAndMentions).toHaveBeenCalledWith('m1', 'new', null);
            expect(out.body).toBe('new');
        });

        it('persists re-parsed mention records on edit + re-materializes KB mentions', async () => {
            // Review-fix I3 regression. Edit with a known @agent + [[kb]]
            // — the new body's mention parser output is what should be
            // persisted to `mentions`, and the kbMentions table is
            // re-added (unique-violation safely swallowed).
            messages.findById
                .mockResolvedValueOnce({
                    id: 'm1',
                    taskId: 't1',
                    authorType: 'user',
                    authorId: 'u1',
                    createdAt: new Date(Date.now() - 30_000),
                })
                .mockResolvedValueOnce({
                    id: 'm1',
                    body: 'hi @ceo see [[runbook]]',
                    editedAt: new Date(),
                });
            tasks.findByIdAndUser.mockResolvedValueOnce({ id: 't1' });
            const lookups = {
                ownedAgentSlugs: new Map([['ceo', 'a1']]),
                knownKbSlugs: new Map([['runbook', 'kb1']]),
            };
            await svc.edit('u1', 'm1', 'hi @ceo see [[runbook]]', lookups);
            expect(messages.updateBodyAndMentions).toHaveBeenCalledWith(
                'm1',
                'hi @ceo see [[runbook]]',
                expect.arrayContaining([
                    expect.objectContaining({ type: 'agent', id: 'a1' }),
                    expect.objectContaining({ type: 'kb', id: 'kb1' }),
                ]),
            );
            expect(kbMentions.add).toHaveBeenCalledWith('t1', 'kb1');
        });
    });

    describe('parseMentions', () => {
        it('drops duplicate mentions', () => {
            const out = svc.parseMentions('@ceo @ceo @ceo', {
                ownedAgentSlugs: new Map([['ceo', 'a1']]),
            });
            expect(out.records).toHaveLength(1);
        });

        it('handles mixed @user, @agent, and [[kb]] tokens', () => {
            const out = svc.parseMentions('cc @alice and @ceo + see [[runbook-deploy]]', {
                knownUserSlugs: new Map([['alice', 'u-alice']]),
                ownedAgentSlugs: new Map([['ceo', 'a-ceo']]),
                knownKbSlugs: new Map([['runbook-deploy', 'kb-doc-1']]),
            });
            expect(out.records.map((r) => r.type).sort()).toEqual(['agent', 'kb', 'user']);
            expect(out.kbDocIds).toEqual(['kb-doc-1']);
        });
    });
});
