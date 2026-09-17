jest.mock('@ever-works/agent/database', () => ({ ConversationRepository: class {} }));
jest.mock('@ever-works/agent/facades', () => ({}));
jest.mock('@ever-works/agent/conversations', () => ({
    ConversationService: class {},
    ConversationMessageService: class {},
    ConversationMentionService: class {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ConversationController } from './conversation.controller';
import { ConversationParticipantsController } from './conversation-participants.controller';
import { ConversationNameDto, SendConversationMessageDto } from './dto/conversation.dto';

const SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const auth = { userId: 'user-1' } as never;

/**
 * Named Conversations — every new route threads the caller's active scope
 * into the domain services, and a Conversation from another scope (or
 * another person) is a 404, never a 403 (FR-95, FR-97).
 */
describe('ConversationController — named Conversations and the active scope', () => {
    let repo: Record<string, jest.Mock>;
    let conversations: Record<string, jest.Mock>;
    let messages: Record<string, jest.Mock>;
    let mentions: Record<string, jest.Mock>;
    let controller: ConversationController;

    beforeEach(() => {
        repo = {
            findByUser: jest.fn().mockResolvedValue({ conversations: [], total: 0 }),
            create: jest.fn().mockResolvedValue({ id: 'legacy' }),
        };
        conversations = {
            list: jest.fn().mockResolvedValue({ conversations: [], total: 0 }),
            create: jest.fn().mockResolvedValue({ id: 'named' }),
            rename: jest.fn().mockResolvedValue({ id: ID, title: 'Q3', titleSource: 'user' }),
            markRead: jest.fn().mockResolvedValue(undefined),
        };
        messages = {
            send: jest
                .fn()
                .mockResolvedValue({ message: { id: MESSAGE_ID }, reach: [], duplicate: false }),
            retry: jest
                .fn()
                .mockResolvedValue({ message: { id: MESSAGE_ID }, reach: [], duplicate: false }),
            discard: jest.fn().mockResolvedValue(undefined),
            listMessages: jest.fn().mockResolvedValue([]),
        };
        mentions = { resolveCandidates: jest.fn().mockResolvedValue([]) };
        controller = new (ConversationController as any)(
            repo,
            { maybeGenerateTitle: jest.fn() },
            conversations,
            messages,
            mentions,
            { getScope: () => SCOPE },
        ) as ConversationController;
    });

    describe('list', () => {
        it('without new filters, answers exactly as before', async () => {
            await controller.list(auth, '20', '40');
            expect(repo.findByUser).toHaveBeenCalledWith('user-1', { limit: 20, offset: 40 });
            expect(conversations.list).not.toHaveBeenCalled();
        });

        it('with a filter, lists named Conversations in the active scope', async () => {
            await controller.list(auth, '500', undefined, 'direct', ID);
            expect(conversations.list).toHaveBeenCalledWith(
                'user-1',
                { limit: 200, offset: undefined, kind: 'direct', agentId: ID },
                SCOPE,
            );
            expect(repo.findByUser).not.toHaveBeenCalled();
        });

        it('refuses malformed values of the new filters only', async () => {
            await expect(controller.list(auth, undefined, undefined, 'thread')).rejects.toThrow(
                BadRequestException,
            );
            await expect(
                controller.list(auth, undefined, undefined, undefined, 'not-a-uuid'),
            ).rejects.toThrow(BadRequestException);
            await expect(
                controller.list(auth, undefined, undefined, undefined, undefined, 'workspace'),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('create', () => {
        it('a body with none of the new fields creates exactly as before', async () => {
            await controller.create(auth, { title: 't', providerId: 'openai' });
            expect(repo.create).toHaveBeenCalledWith({
                userId: 'user-1',
                title: 't',
                providerId: 'openai',
                model: undefined,
            });
            expect(conversations.create).not.toHaveBeenCalled();
        });

        it('a Conversation addressed at an Agent is created in the active scope', async () => {
            await controller.create(auth, { agentId: ID, contextType: 'mission', contextId: ID });
            expect(conversations.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ agentId: ID, contextType: 'mission', contextId: ID }),
                SCOPE,
            );
            expect(repo.create).not.toHaveBeenCalled();
        });
    });

    it('threads the scope through naming, sending, retry, discard, read and paging', async () => {
        await controller.setName(auth, ID, { name: 'Q3' });
        await controller.send(auth, ID, { body: 'hi', clientMessageId: 'client-1' });
        await controller.retry(auth, ID, MESSAGE_ID);
        await controller.discard(auth, ID, MESSAGE_ID);
        await controller.markRead(auth, ID, { lastReadMessageId: MESSAGE_ID });
        await controller.listMessages(auth, ID, '1000', MESSAGE_ID);
        await controller.mentionCandidates(auth, 'nov');

        expect(conversations.rename).toHaveBeenCalledWith(ID, 'user-1', 'Q3', SCOPE);
        expect(messages.send).toHaveBeenCalledWith(
            'user-1',
            ID,
            { body: 'hi', clientMessageId: 'client-1', attachments: undefined, model: undefined },
            SCOPE,
        );
        expect(messages.retry).toHaveBeenCalledWith('user-1', ID, MESSAGE_ID, SCOPE);
        expect(messages.discard).toHaveBeenCalledWith('user-1', ID, MESSAGE_ID, SCOPE);
        expect(conversations.markRead).toHaveBeenCalledWith(ID, 'user-1', MESSAGE_ID, SCOPE);
        expect(messages.listMessages).toHaveBeenCalledWith(
            'user-1',
            ID,
            { limit: 200, before: MESSAGE_ID },
            SCOPE,
        );
        expect(mentions.resolveCandidates).toHaveBeenCalledWith('nov', {
            userId: 'user-1',
            scope: SCOPE,
        });
    });

    it('a Conversation outside the active scope is a 404 on every route', async () => {
        const notFound = new NotFoundException();
        conversations.rename.mockRejectedValue(notFound);
        conversations.markRead.mockRejectedValue(notFound);
        messages.send.mockRejectedValue(notFound);
        messages.retry.mockRejectedValue(notFound);
        messages.listMessages.mockRejectedValue(notFound);

        await expect(controller.setName(auth, ID, { name: 'x' })).rejects.toThrow(
            NotFoundException,
        );
        await expect(controller.send(auth, ID, { body: 'hi' })).rejects.toThrow(NotFoundException);
        await expect(controller.retry(auth, ID, MESSAGE_ID)).rejects.toThrow(NotFoundException);
        await expect(
            controller.markRead(auth, ID, { lastReadMessageId: MESSAGE_ID }),
        ).rejects.toThrow(NotFoundException);
        await expect(controller.listMessages(auth, ID)).rejects.toThrow(NotFoundException);
    });

    it('refuses a malformed paging anchor and an over-long mention query', async () => {
        await expect(controller.listMessages(auth, ID, undefined, 'nope')).rejects.toThrow(
            BadRequestException,
        );
        await expect(controller.mentionCandidates(auth, 'x'.repeat(81))).rejects.toThrow(
            BadRequestException,
        );
    });

    it('the participant list is a 404 for a caller outside the scope', async () => {
        const service = {
            listParticipants: jest.fn().mockRejectedValue(new NotFoundException()),
        };
        const participants = new (ConversationParticipantsController as any)(service, {
            getScope: () => SCOPE,
        }) as ConversationParticipantsController;

        await expect(participants.list(auth, ID)).rejects.toThrow(NotFoundException);
        expect(service.listParticipants).toHaveBeenCalledWith(ID, 'user-1', SCOPE);

        service.listParticipants.mockResolvedValue([
            {
                participantType: 'agent',
                participantId: 'agent-1',
                role: 'member',
                joinedAt: new Date(0),
                leftAt: null,
                tenantId: SCOPE.tenantId,
            },
        ]);
        const result = await participants.list(auth, ID);
        expect(result.participants).toEqual([
            {
                participantType: 'agent',
                participantId: 'agent-1',
                role: 'member',
                joinedAt: new Date(0),
                leftAt: null,
                lastReadMessageId: null,
                lastReadAt: null,
            },
        ]);
    });
});

describe('named Conversation DTOs', () => {
    const errorsFor = (cls: new () => object, payload: Record<string, unknown>) =>
        validateSync(plainToInstance(cls, payload), {
            whitelist: true,
            forbidNonWhitelisted: true,
        }).map((error) => error.property);

    it('a name is a string or an explicit null — never absent', () => {
        expect(errorsFor(ConversationNameDto, { name: 'Q3' })).toEqual([]);
        expect(errorsFor(ConversationNameDto, { name: null })).toEqual([]);
        expect(errorsFor(ConversationNameDto, {})).toContain('name');
        expect(errorsFor(ConversationNameDto, { name: 'x'.repeat(201) })).toContain('name');
        expect(errorsFor(ConversationNameDto, { name: 7 })).toContain('name');
    });

    it('a send carries a body, a safe client id and at most ten attachments', () => {
        expect(
            errorsFor(SendConversationMessageDto, { body: 'hi', clientMessageId: 'c-1:2' }),
        ).toEqual([]);
        expect(errorsFor(SendConversationMessageDto, {})).toContain('body');
        expect(
            errorsFor(SendConversationMessageDto, { body: 'hi', clientMessageId: 'x'.repeat(65) }),
        ).toContain('clientMessageId');
        expect(
            errorsFor(SendConversationMessageDto, { body: 'hi', clientMessageId: 'has space' }),
        ).toContain('clientMessageId');
        expect(
            errorsFor(SendConversationMessageDto, {
                body: 'hi',
                attachments: Array.from({ length: 11 }, (_, i) => ({ uploadId: `u${i}` })),
            }),
        ).toContain('attachments');
        expect(
            errorsFor(SendConversationMessageDto, { body: 'hi', authorType: 'agent' }),
        ).toContain('authorType');
    });
});
