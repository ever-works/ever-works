jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));

import { ConversationTitleService } from './conversation-title.service';
import type { ConversationRepository, WorkRepository } from '@ever-works/agent/database';
import type { AiFacadeService } from '@ever-works/agent/facades';

describe('ConversationTitleService', () => {
    let service: ConversationTitleService;
    let conversationRepo: jest.Mocked<Pick<ConversationRepository, 'findById' | 'updateTitle'>>;
    let aiFacade: jest.Mocked<Pick<AiFacadeService, 'createChatCompletion'>>;
    let workRepository: jest.Mocked<Pick<WorkRepository, 'findByUser'>>;

    const conversation = (overrides: Record<string, unknown> = {}) => ({
        id: 'c-1',
        userId: 'user-1',
        title: null,
        metadata: null,
        messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'tell me about cats' },
            { role: 'assistant', content: 'cats are great' },
        ],
        ...overrides,
    });

    beforeEach(() => {
        conversationRepo = {
            findById: jest.fn(),
            updateTitle: jest.fn(),
        } as any;
        aiFacade = {
            createChatCompletion: jest.fn(),
        } as any;
        workRepository = {
            findByUser: jest.fn(),
        } as any;

        service = new ConversationTitleService(
            conversationRepo as unknown as ConversationRepository,
            aiFacade as unknown as AiFacadeService,
            workRepository as unknown as WorkRepository,
        );
    });

    it('returns silently when conversation is not found', async () => {
        conversationRepo.findById.mockResolvedValue(null as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
    });

    it('skips when message count is below 4', async () => {
        conversationRepo.findById.mockResolvedValue(
            conversation({ messages: [{ role: 'user', content: 'hi' }] }) as any,
        );

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
    });

    it('skips when conversation already has aiTitle metadata', async () => {
        conversationRepo.findById.mockResolvedValue(
            conversation({ metadata: { aiTitle: true } }) as any,
        );

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
    });

    it('handles missing messages array as 0 count', async () => {
        conversationRepo.findById.mockResolvedValue(conversation({ messages: undefined }) as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
    });

    it('calls AI with last 4 user/assistant messages and updates title', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([{ id: 'w-1' }] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 'My Cat Title' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(aiFacade.createChatCompletion).toHaveBeenCalledTimes(1);
        const [opts, facadeOpts] = aiFacade.createChatCompletion.mock.calls[0];
        expect(facadeOpts).toEqual({ userId: 'user-1', workId: 'w-1' });
        expect(opts.temperature).toBe(0.3);
        expect(opts.maxTokens).toBe(30);
        expect(opts.messages[0].role).toBe('system');
        // The summary excludes 'system' and only takes last 4 user/assistant messages
        expect(opts.messages[1].content).toContain('user: hi');
        expect(opts.messages[1].content).toContain('user: tell me about cats');
        expect(opts.messages[1].content).toContain('assistant: cats are great');
        expect(conversationRepo.updateTitle).toHaveBeenCalledWith('c-1', 'user-1', 'My Cat Title', {
            aiTitle: true,
        });
    });

    it('truncates long generated titles to 100 chars', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([{ id: 'w-1' }] as any);
        const longTitle = 'a'.repeat(150);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: longTitle } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        const [, , title] = conversationRepo.updateTitle.mock.calls[0];
        expect(title).toHaveLength(100);
        expect(title).toBe('a'.repeat(100));
    });

    it('trims whitespace before truncating', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: '  Spaced Title  ' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(conversationRepo.updateTitle).toHaveBeenCalledWith('c-1', 'user-1', 'Spaced Title', {
            aiTitle: true,
        });
    });

    it('skips updateTitle when AI returns empty content', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: '   ' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(conversationRepo.updateTitle).not.toHaveBeenCalled();
    });

    it('skips updateTitle when AI returns non-string content', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 123 } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        expect(conversationRepo.updateTitle).not.toHaveBeenCalled();
    });

    it('logs and swallows AI failures without throwing', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockRejectedValue(new Error('upstream down'));

        await expect(service.maybeGenerateTitle('c-1', 'user-1')).resolves.toBeUndefined();
        expect(conversationRepo.updateTitle).not.toHaveBeenCalled();
    });

    it('falls back to userId-only facade options when workRepository.findByUser fails', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockRejectedValue(new Error('db down'));
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 'Title' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        const [, facadeOpts] = aiFacade.createChatCompletion.mock.calls[0];
        expect(facadeOpts).toEqual({ userId: 'user-1' });
    });

    it('extracts message text from `parts` array when content is empty', async () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '' },
            {
                role: 'user',
                content: '',
                parts: [
                    { type: 'text', text: 'Part one' },
                    { type: 'image', url: 'x' },
                    { type: 'text', text: 'Part two' },
                ],
            },
            { role: 'assistant', content: 'a' },
            { role: 'assistant', content: 'b' },
        ];
        conversationRepo.findById.mockResolvedValue(conversation({ messages }) as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 'T' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        const [opts] = aiFacade.createChatCompletion.mock.calls[0];
        expect(opts.messages[1].content).toContain('user: Part one Part two');
    });

    it('truncates each message to 200 chars in the summary', async () => {
        const long = 'a'.repeat(300);
        const messages = [
            { role: 'user', content: long },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
            { role: 'assistant', content: 'd' },
        ];
        conversationRepo.findById.mockResolvedValue(conversation({ messages }) as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 'T' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        const [opts] = aiFacade.createChatCompletion.mock.calls[0];
        expect(opts.messages[1].content).toContain('user: ' + 'a'.repeat(200) + '\n');
    });

    it('skips messages whose role is neither user nor assistant', async () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'tool', content: 'tool-result' },
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: 'a2' },
        ];
        conversationRepo.findById.mockResolvedValue(conversation({ messages }) as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 'T' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        const [opts] = aiFacade.createChatCompletion.mock.calls[0];
        expect(opts.messages[1].content).not.toContain('system:');
        expect(opts.messages[1].content).not.toContain('tool:');
        expect(opts.messages[1].content).toContain('user: u1');
    });

    it('handles missing facadeOptions.workId gracefully when works array is empty', async () => {
        conversationRepo.findById.mockResolvedValue(conversation() as any);
        workRepository.findByUser.mockResolvedValue([] as any);
        aiFacade.createChatCompletion.mockResolvedValue({
            choices: [{ message: { content: 'T' } }],
        } as any);

        await service.maybeGenerateTitle('c-1', 'user-1');

        const [, facadeOpts] = aiFacade.createChatCompletion.mock.calls[0];
        expect(facadeOpts).toEqual({ userId: 'user-1', workId: undefined });
    });
});
