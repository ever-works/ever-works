jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ConversationController } from './conversation.controller';
import { ConversationTitleService } from './conversation-title.service';
import type { ConversationRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('ConversationController', () => {
    let controller: ConversationController;
    let repo: jest.Mocked<
        Pick<
            ConversationRepository,
            | 'findByUser'
            | 'create'
            | 'findById'
            | 'updateTitle'
            | 'appendMessages'
            | 'delete'
            | 'deleteAllByUser'
        >
    >;
    let titleService: jest.Mocked<Pick<ConversationTitleService, 'maybeGenerateTitle'>>;
    const auth: AuthenticatedUser = { userId: 'user-1' } as AuthenticatedUser;

    beforeEach(() => {
        repo = {
            findByUser: jest.fn(),
            create: jest.fn(),
            findById: jest.fn(),
            updateTitle: jest.fn(),
            appendMessages: jest.fn(),
            delete: jest.fn(),
            deleteAllByUser: jest.fn(),
        } as any;
        titleService = {
            maybeGenerateTitle: jest.fn().mockResolvedValue(undefined),
        } as any;
        controller = new ConversationController(
            repo as unknown as ConversationRepository,
            titleService as unknown as ConversationTitleService,
        );
    });

    describe('list', () => {
        it('parses limit/offset and forwards to findByUser', async () => {
            repo.findByUser.mockResolvedValue([] as any);

            await controller.list(auth, '20', '40');

            expect(repo.findByUser).toHaveBeenCalledWith('user-1', { limit: 20, offset: 40 });
        });

        it('passes undefined when limit/offset are missing', async () => {
            repo.findByUser.mockResolvedValue([] as any);

            await controller.list(auth);

            expect(repo.findByUser).toHaveBeenCalledWith('user-1', {
                limit: undefined,
                offset: undefined,
            });
        });
    });

    describe('create', () => {
        it('creates a conversation with body fields', async () => {
            repo.create.mockResolvedValue({ id: 'c-1' } as any);

            const result = await controller.create(auth, { title: 't', providerId: 'openai' });

            expect(repo.create).toHaveBeenCalledWith({
                userId: 'user-1',
                title: 't',
                providerId: 'openai',
            });
            expect(result).toEqual({ id: 'c-1' });
        });
    });

    describe('get', () => {
        it('returns the conversation when found', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1' } as any);

            const result = await controller.get(auth, 'c-1');

            expect(repo.findById).toHaveBeenCalledWith('c-1', 'user-1');
            expect(result).toEqual({ id: 'c-1' });
        });

        it('throws NotFoundException when missing', async () => {
            repo.findById.mockResolvedValue(null as any);

            await expect(controller.get(auth, 'missing')).rejects.toThrow(NotFoundException);
        });
    });

    describe('update', () => {
        it('updates title when conversation exists', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1' } as any);

            await controller.update(auth, 'c-1', { title: 'New' });

            expect(repo.updateTitle).toHaveBeenCalledWith('c-1', 'user-1', 'New');
        });

        it('throws NotFoundException when missing', async () => {
            repo.findById.mockResolvedValue(null as any);

            await expect(controller.update(auth, 'missing', { title: 'x' })).rejects.toThrow(
                NotFoundException,
            );
            expect(repo.updateTitle).not.toHaveBeenCalled();
        });
    });

    describe('appendMessages', () => {
        it('throws NotFoundException when conversation missing', async () => {
            repo.findById.mockResolvedValue(null as any);

            await expect(
                controller.appendMessages(auth, 'missing', {
                    messages: [{ role: 'user', content: 'hi' }],
                }),
            ).rejects.toThrow(NotFoundException);
            expect(repo.appendMessages).not.toHaveBeenCalled();
        });

        it('appends messages and sets short title from first user message when conversation has no title', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1', title: null } as any);

            const result = await controller.appendMessages(auth, 'c-1', {
                messages: [
                    { role: 'system', content: 'sys' },
                    {
                        role: 'user',
                        content: 'Hello   world\n\twith   spaces',
                        model: 'gpt',
                        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
                    },
                    { role: 'assistant', content: 'hi back' },
                ],
            });

            expect(repo.appendMessages).toHaveBeenCalledWith([
                {
                    conversationId: 'c-1',
                    role: 'system',
                    content: 'sys',
                    parts: undefined,
                    model: undefined,
                    usage: undefined,
                },
                {
                    conversationId: 'c-1',
                    role: 'user',
                    content: 'Hello   world\n\twith   spaces',
                    parts: undefined,
                    model: 'gpt',
                    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
                },
                {
                    conversationId: 'c-1',
                    role: 'assistant',
                    content: 'hi back',
                    parts: undefined,
                    model: undefined,
                    usage: undefined,
                },
            ]);
            // Whitespace is normalised
            expect(repo.updateTitle).toHaveBeenCalledWith(
                'c-1',
                'user-1',
                'Hello world with spaces',
            );
            expect(titleService.maybeGenerateTitle).toHaveBeenCalledWith('c-1', 'user-1');
            expect(result).toEqual({ success: true });
        });

        it('truncates long titles to 60 chars with ellipsis', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1', title: null } as any);
            const longText = 'a'.repeat(200);

            await controller.appendMessages(auth, 'c-1', {
                messages: [{ role: 'user', content: longText }],
            });

            const expected = 'a'.repeat(57) + '...';
            expect(repo.updateTitle).toHaveBeenCalledWith('c-1', 'user-1', expected);
            expect(expected.length).toBe(60);
        });

        it('does NOT set title when conversation already has one', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1', title: 'Existing' } as any);

            await controller.appendMessages(auth, 'c-1', {
                messages: [{ role: 'user', content: 'hi' }],
            });

            expect(repo.updateTitle).not.toHaveBeenCalled();
        });

        it('does NOT set title when no user message present', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1', title: null } as any);

            await controller.appendMessages(auth, 'c-1', {
                messages: [{ role: 'system', content: 'hi' }],
            });

            expect(repo.updateTitle).not.toHaveBeenCalled();
        });

        it('swallows errors from titleService.maybeGenerateTitle', async () => {
            repo.findById.mockResolvedValue({ id: 'c-1', title: 'Existing' } as any);
            titleService.maybeGenerateTitle.mockRejectedValue(new Error('boom'));

            await expect(
                controller.appendMessages(auth, 'c-1', {
                    messages: [{ role: 'user', content: 'hi' }],
                }),
            ).resolves.toEqual({ success: true });
        });
    });

    describe('delete', () => {
        it('returns nothing when delete succeeds', async () => {
            repo.delete.mockResolvedValue(true as any);

            await expect(controller.delete(auth, 'c-1')).resolves.toBeUndefined();
            expect(repo.delete).toHaveBeenCalledWith('c-1', 'user-1');
        });

        it('throws NotFoundException when not found', async () => {
            repo.delete.mockResolvedValue(false as any);

            await expect(controller.delete(auth, 'missing')).rejects.toThrow(NotFoundException);
        });
    });

    describe('deleteAll', () => {
        it('returns the deleted count', async () => {
            repo.deleteAllByUser.mockResolvedValue(7 as any);

            const result = await controller.deleteAll(auth);

            expect(repo.deleteAllByUser).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ deleted: 7 });
        });
    });
});
