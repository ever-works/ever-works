import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { RunDispatchGateService } from '../../agents/run-dispatch-gate.service';
import { ConversationDispatchService } from '../conversation-dispatch.service';
import { ConversationMessageService } from '../conversation-message.service';
import { ConversationMentionService } from '../conversation-mention.service';
import { MAX_CONVERSATION_BODY_BYTES } from '../conversation.types';

const CONVERSATION = {
    id: 'c1',
    userId: 'u1',
    kind: 'direct',
    agentId: 'a1',
    tenantId: 't1',
    organizationId: 'o1',
};

describe('ConversationMessageService', () => {
    let conversations: Record<string, jest.Mock>;
    let conversationService: { assertParticipant: jest.Mock; ensureOwner: jest.Mock };
    let mentions: ConversationMentionService;
    let dispatch: { dispatch: jest.Mock };
    let service: ConversationMessageService;

    beforeEach(() => {
        conversations = {
            findByClientMessageId: jest.fn().mockResolvedValue(null),
            insertMessage: jest.fn(async (input) => ({
                id: 'm1',
                createdAt: new Date(),
                ...input,
            })),
            findMessageById: jest.fn(),
            updateMessageStatus: jest.fn().mockResolvedValue(undefined),
            deleteMessages: jest.fn().mockResolvedValue(1),
            findMessagesPaged: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(CONVERSATION),
            findByIdForUser: jest.fn().mockResolvedValue(CONVERSATION),
        };
        conversationService = {
            assertParticipant: jest.fn().mockResolvedValue(CONVERSATION),
            ensureOwner: jest.fn().mockResolvedValue(undefined),
        };
        mentions = new ConversationMentionService(
            {
                findByUserIdScoped: jest.fn().mockResolvedValue({
                    rows: [{ id: 'a2', slug: 'orion', name: 'Orion', status: 'active' }],
                    total: 1,
                }),
            } as any,
            { findSummariesByUser: jest.fn() } as any,
        );
        dispatch = {
            dispatch: jest
                .fn()
                .mockResolvedValue([{ agentId: 'a1', outcome: 'delivered', runId: 'r1' }]),
        };
        service = new ConversationMessageService(
            conversations as any,
            conversationService as any,
            mentions,
            dispatch as any,
        );
    });

    describe('send', () => {
        it('stores the message as sent, then dispatches it with the resolved mentions', async () => {
            const scope = { tenantId: 't1', organizationId: 'o1' };
            const result = await service.send(
                'u1',
                'c1',
                { body: '@ghost ask @Orion please', clientMessageId: 'client-1' },
                scope,
            );

            expect(conversationService.assertParticipant).toHaveBeenCalledWith('c1', 'u1', scope);
            expect(conversations.insertMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversationId: 'c1',
                    role: 'user',
                    content: '@ghost ask @Orion please',
                    authorType: 'user',
                    authorId: 'u1',
                    status: 'sent',
                    clientMessageId: 'client-1',
                    mentions: [{ type: 'agent', id: 'a2', slug: 'orion' }],
                    tenantId: 't1',
                    organizationId: 'o1',
                }),
            );
            expect(dispatch.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    agentVisibleBody: 'ask @Orion please',
                    mentionedAgentIds: ['a2'],
                }),
            );
            expect(result.duplicate).toBe(false);
            expect(result.reach).toEqual([{ agentId: 'a1', outcome: 'delivered', runId: 'r1' }]);
        });

        it('sending the same client id twice returns the first message and creates no row', async () => {
            const first = { id: 'm-first', clientMessageId: 'client-1' };
            conversations.findByClientMessageId.mockResolvedValue(first);

            const result = await service.send('u1', 'c1', {
                body: 'hi',
                clientMessageId: 'client-1',
            });

            expect(result).toEqual({ message: first, reach: [], duplicate: true });
            expect(conversations.insertMessage).not.toHaveBeenCalled();
            expect(dispatch.dispatch).not.toHaveBeenCalled();
        });

        it('a lost race on the client id answers with the message that won', async () => {
            const winner = { id: 'm-winner', clientMessageId: 'client-1' };
            conversations.findByClientMessageId
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(winner);
            const violation = new QueryFailedError('INSERT', [], {
                code: 'SQLITE_CONSTRAINT_UNIQUE',
            } as any);
            conversations.insertMessage.mockRejectedValue(violation);

            const result = await service.send('u1', 'c1', {
                body: 'hi',
                clientMessageId: 'client-1',
            });

            expect(result).toEqual({ message: winner, reach: [], duplicate: true });
            expect(dispatch.dispatch).not.toHaveBeenCalled();
        });

        it('rejects a body over 16 KB before anything is stored, with its size', async () => {
            const body = 'é'.repeat(MAX_CONVERSATION_BODY_BYTES / 2 + 1);
            const error = await service.send('u1', 'c1', { body }).catch((e) => e);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse()).toMatchObject({
                failureCode: 'too_large',
                size: MAX_CONVERSATION_BODY_BYTES + 2,
                max: MAX_CONVERSATION_BODY_BYTES,
            });
            expect(conversations.insertMessage).not.toHaveBeenCalled();
        });

        it('rejects a body carrying a credential before anything is stored, without echoing it', async () => {
            const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
            const error = await service.send('u1', 'c1', { body: `use ${secret}` }).catch((e) => e);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse()).toMatchObject({ failureCode: 'secret_detected' });
            expect(JSON.stringify(error.getResponse())).not.toContain(secret);
            expect(conversations.insertMessage).not.toHaveBeenCalled();
        });

        it('rejects an empty body and more than ten attachments', async () => {
            await expect(service.send('u1', 'c1', { body: '   ' })).rejects.toThrow(
                BadRequestException,
            );
            const attachments = Array.from({ length: 11 }, (_, i) => ({ uploadId: `up-${i}` }));
            await expect(service.send('u1', 'c1', { body: 'hi', attachments })).rejects.toThrow(
                BadRequestException,
            );
            expect(conversations.insertMessage).not.toHaveBeenCalled();
        });

        it('404s for a Conversation the sender may not read', async () => {
            conversationService.assertParticipant.mockRejectedValue(new NotFoundException());
            await expect(service.send('u1', 'c-other', { body: 'hi' })).rejects.toThrow(
                NotFoundException,
            );
            expect(conversations.insertMessage).not.toHaveBeenCalled();
        });

        it('marks the message failed when every dispatch failed unexpectedly, so it can be retried', async () => {
            dispatch.dispatch.mockResolvedValue([
                { agentId: 'a1', outcome: 'refused', reason: 'dispatch-failed', runId: 'r1' },
            ]);

            const result = await service.send('u1', 'c1', { body: 'hi' });

            expect(conversations.updateMessageStatus).toHaveBeenCalledWith(
                'm1',
                'failed',
                'provider_unavailable',
            );
            expect(result.message).toMatchObject({
                status: 'failed',
                failureCode: 'provider_unavailable',
            });
        });

        it('marks the message failed with the reason when the dispatch gate would not start the reply', async () => {
            const cases: Array<[string, string]> = [
                ['concurrency-limit', 'capacity_limited'],
                ['kill-switch', 'capacity_limited'],
                ['insufficient-credits', 'budget_exceeded'],
            ];
            for (const [reason, failureCode] of cases) {
                conversations.updateMessageStatus.mockClear();
                dispatch.dispatch.mockResolvedValueOnce([
                    { agentId: 'a1', outcome: 'refused', reason },
                ]);

                const result = await service.send('u1', 'c1', { body: 'hi' });

                expect(conversations.updateMessageStatus).toHaveBeenCalledWith(
                    'm1',
                    'failed',
                    failureCode,
                );
                expect(result.message).toMatchObject({ status: 'failed', failureCode });
                expect(result.reach).toEqual([{ agentId: 'a1', outcome: 'refused', reason }]);
            }
        });

        it('keeps the message sent when another Agent did get it, or no job runtime exists', async () => {
            dispatch.dispatch.mockResolvedValueOnce([
                { agentId: 'a1', outcome: 'delivered', runId: 'r1' },
                { agentId: 'a2', outcome: 'refused', reason: 'concurrency-limit' },
            ]);
            await expect(service.send('u1', 'c1', { body: 'hi' })).resolves.toMatchObject({
                message: { status: 'sent' },
            });

            dispatch.dispatch.mockResolvedValueOnce([
                { agentId: 'a1', outcome: 'refused', reason: 'job-runtime-not-configured' },
            ]);
            await expect(service.send('u1', 'c1', { body: 'hi' })).resolves.toMatchObject({
                message: { status: 'sent' },
            });
            expect(conversations.updateMessageStatus).not.toHaveBeenCalled();
        });

        it('keeps the message sent when a reply was only queued or skipped', async () => {
            dispatch.dispatch.mockResolvedValue([
                { agentId: 'a1', outcome: 'queued', reason: 'concurrency-limit' },
            ]);
            const result = await service.send('u1', 'c1', { body: 'hi' });
            expect(conversations.updateMessageStatus).not.toHaveBeenCalled();
            expect(result.message.status).toBe('sent');
        });
    });

    describe('retry and discard', () => {
        const failed = {
            id: 'm1',
            conversationId: 'c1',
            authorType: 'user',
            authorId: 'u1',
            content: 'hi',
            status: 'failed',
            failureCode: 'provider_unavailable',
        };

        it('retries only a failed message, moving it back to sent and dispatching again', async () => {
            conversations.findMessageById.mockResolvedValue(failed);

            const result = await service.retry('u1', 'c1', 'm1');

            expect(conversations.updateMessageStatus).toHaveBeenCalledWith('m1', 'sent', null);
            expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
            expect(result.message.status).toBe('sent');
        });

        it('a second Retry of a message already sent is a 409 and dispatches nothing', async () => {
            conversations.findMessageById.mockResolvedValue({ ...failed, status: 'sent' });
            await expect(service.retry('u1', 'c1', 'm1')).rejects.toThrow(ConflictException);
            expect(dispatch.dispatch).not.toHaveBeenCalled();
        });

        it('discards only a failed message', async () => {
            conversations.findMessageById.mockResolvedValueOnce(failed);
            await service.discard('u1', 'c1', 'm1');
            expect(conversations.deleteMessages).toHaveBeenCalledWith('c1', ['m1']);

            conversations.findMessageById.mockResolvedValueOnce({ ...failed, status: 'sent' });
            await expect(service.discard('u1', 'c1', 'm1')).rejects.toThrow(ConflictException);
            expect(conversations.deleteMessages).toHaveBeenCalledTimes(1);
        });

        it('another person’s message, or an Agent’s, is not found', async () => {
            conversations.findMessageById.mockResolvedValueOnce({ ...failed, authorId: 'u2' });
            await expect(service.retry('u1', 'c1', 'm1')).rejects.toThrow(NotFoundException);
            conversations.findMessageById.mockResolvedValueOnce({ ...failed, authorType: 'agent' });
            await expect(service.discard('u1', 'c1', 'm1')).rejects.toThrow(NotFoundException);
        });
    });

    describe('a reply the dispatch gate refused', () => {
        const ORG_LIMIT_KEY = 'AGENT_MAX_CONCURRENT_RUNS_PER_ORG';
        let savedLimit: string | undefined;
        let runs: Record<string, jest.Mock>;
        let dispatcher: { enqueue: jest.Mock };
        let stored: Map<string, any>;
        let realService: ConversationMessageService;

        beforeEach(() => {
            savedLimit = process.env[ORG_LIMIT_KEY];
            process.env[ORG_LIMIT_KEY] = '2';

            // A Conversation store that remembers what was written, so the
            // Retry reads the status the send left behind.
            stored = new Map();
            conversations.insertMessage.mockImplementation(async (input) => {
                const row = { id: 'm1', createdAt: new Date(), ...input };
                stored.set(row.id, row);
                return row;
            });
            conversations.updateMessageStatus.mockImplementation(
                async (id: string, status: string, failureCode: string | null) => {
                    Object.assign(stored.get(id), { status, failureCode });
                },
            );
            conversations.findMessageById.mockImplementation(async (_c: string, id: string) =>
                stored.has(id) ? { ...stored.get(id) } : null,
            );

            runs = {
                // Two replies in flight at the org's limit of two, then one finishes.
                countInFlightForOrganization: jest
                    .fn()
                    .mockResolvedValueOnce(2)
                    .mockResolvedValue(1),
                countInFlightForUser: jest.fn().mockResolvedValue(0),
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                findInFlightForConversationAgent: jest.fn().mockResolvedValue(null),
                createQueued: jest.fn().mockResolvedValue({ id: 'run-1' }),
                setTriggerRunId: jest.fn().mockResolvedValue(undefined),
                markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            };
            dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'job-1' }) };
            const replies = new ConversationDispatchService(
                {
                    findByIdAndUser: jest.fn().mockResolvedValue({ id: 'a1', status: 'active' }),
                } as any,
                runs as any,
                dispatcher,
                undefined,
                new RunDispatchGateService(runs as any),
            );
            realService = new ConversationMessageService(
                conversations as any,
                conversationService as any,
                mentions,
                replies,
            );
        });

        afterEach(() => {
            if (savedLimit === undefined) delete process.env[ORG_LIMIT_KEY];
            else process.env[ORG_LIMIT_KEY] = savedLimit;
        });

        it('is not reported as sent, and Retry dispatches it exactly once when capacity exists', async () => {
            const sent = await realService.send('u1', 'c1', {
                body: 'hi',
                clientMessageId: 'client-1',
            });

            expect(sent.reach).toEqual([
                { agentId: 'a1', outcome: 'refused', reason: 'concurrency-limit' },
            ]);
            expect(sent.message).toMatchObject({
                status: 'failed',
                failureCode: 'capacity_limited',
            });
            expect(stored.get('m1')).toMatchObject({
                status: 'failed',
                failureCode: 'capacity_limited',
            });
            expect(runs.createQueued).not.toHaveBeenCalled();
            expect(dispatcher.enqueue).not.toHaveBeenCalled();

            const retried = await realService.retry('u1', 'c1', 'm1');

            expect(retried.reach).toEqual([
                { agentId: 'a1', outcome: 'delivered', runId: 'run-1' },
            ]);
            expect(retried.message).toMatchObject({ status: 'sent', failureCode: null });
            expect(stored.get('m1')).toMatchObject({ status: 'sent', failureCode: null });
            expect(runs.createQueued).toHaveBeenCalledTimes(1);
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(dispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ triggeringMessageId: 'm1', runId: 'run-1' }),
            );

            // The message is sent now: a second Retry is refused and starts nothing.
            await expect(realService.retry('u1', 'c1', 'm1')).rejects.toThrow(ConflictException);
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        });
    });

    describe('markReplyRefused', () => {
        it('moves the person’s sent message to failed with the reason', async () => {
            conversations.findMessageById.mockResolvedValue({
                id: 'm1',
                authorType: 'user',
                authorId: 'u1',
                status: 'sent',
            });

            await expect(
                service.markReplyRefused({
                    conversationId: 'c1',
                    messageId: 'm1',
                    failureCode: 'budget_exceeded',
                }),
            ).resolves.toBe(true);

            expect(conversations.findMessageById).toHaveBeenCalledWith('c1', 'm1');
            expect(conversations.updateMessageStatus).toHaveBeenCalledWith(
                'm1',
                'failed',
                'budget_exceeded',
            );
        });

        it('marks a failed model call provider_unavailable, once, while the message is still sent', async () => {
            const row = { id: 'm1', authorType: 'user', authorId: 'u1', status: 'sent' };
            conversations.findMessageById.mockImplementation(async () => ({ ...row }));
            conversations.updateMessageStatus.mockImplementation(async (_id, status) => {
                row.status = status;
            });
            const input = {
                conversationId: 'c1',
                messageId: 'm1',
                failureCode: 'provider_unavailable' as const,
            };

            await expect(service.markReplyRefused(input)).resolves.toBe(true);
            // A second report (a redelivered job) finds the message failed already.
            await expect(service.markReplyRefused(input)).resolves.toBe(false);

            expect(conversations.updateMessageStatus).toHaveBeenCalledTimes(1);
            expect(conversations.updateMessageStatus).toHaveBeenCalledWith(
                'm1',
                'failed',
                'provider_unavailable',
            );
        });

        it('leaves a missing, already failed, or non-person message alone', async () => {
            const input = {
                conversationId: 'c1',
                messageId: 'm1',
                failureCode: 'budget_exceeded' as const,
            };
            conversations.findMessageById.mockResolvedValueOnce(null);
            await expect(service.markReplyRefused(input)).resolves.toBe(false);
            conversations.findMessageById.mockResolvedValueOnce({
                id: 'm1',
                authorType: 'user',
                status: 'failed',
            });
            await expect(service.markReplyRefused(input)).resolves.toBe(false);
            conversations.findMessageById.mockResolvedValueOnce({
                id: 'm1',
                authorType: 'agent',
                status: 'sent',
            });
            await expect(service.markReplyRefused(input)).resolves.toBe(false);
            expect(conversations.updateMessageStatus).not.toHaveBeenCalled();
        });
    });

    describe('appendAgentMessage', () => {
        it('records the reply as Agent-authored, answering the triggering message', async () => {
            await service.appendAgentMessage({
                conversationId: 'c1',
                agentId: 'a1',
                body: 'Done.',
                replyToMessageId: 'm1',
            });
            expect(conversations.insertMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversationId: 'c1',
                    role: 'assistant',
                    content: 'Done.',
                    authorType: 'agent',
                    authorId: 'a1',
                    status: 'sent',
                    replyToMessageId: 'm1',
                    tenantId: 't1',
                    organizationId: 'o1',
                }),
            );
        });

        it('redacts a credential an Agent echoed instead of storing it', async () => {
            const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
            await service.appendAgentMessage({ conversationId: 'c1', agentId: 'a1', body: secret });
            const stored = conversations.insertMessage.mock.calls[0][0].content as string;
            expect(stored).not.toContain(secret);
        });

        it('404s when the Conversation is gone', async () => {
            conversations.findById.mockResolvedValue(null);
            await expect(
                service.appendAgentMessage({ conversationId: 'gone', agentId: 'a1', body: 'x' }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('loadReplyContext', () => {
        it('loads the Conversation for the dispatching user, the triggering message and recent history', async () => {
            conversations.findMessageById.mockResolvedValue({ id: 'm1', content: 'hi' });
            conversations.findMessagesPaged.mockResolvedValue([{ id: 'm0' }, { id: 'm1' }]);

            const context = await service.loadReplyContext('u1', 'c1', 'm1');

            expect(conversations.findByIdForUser).toHaveBeenCalledWith('c1', 'u1');
            expect(conversations.findMessagesPaged).toHaveBeenCalledWith('c1', 20);
            expect(context?.triggering).toEqual({ id: 'm1', content: 'hi' });
            expect(context?.recent).toHaveLength(2);
        });

        it('returns null when the Conversation is no longer the user’s', async () => {
            conversations.findByIdForUser.mockResolvedValue(null);
            await expect(service.loadReplyContext('u2', 'c1', 'm1')).resolves.toBeNull();
        });
    });
});
