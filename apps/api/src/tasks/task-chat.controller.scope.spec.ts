jest.mock('@ever-works/agent/tasks-domain', () => ({ TaskChatService: class {} }));
jest.mock('@ever-works/agent/database', () => ({ AgentRepository: class {} }));

import { TaskChatController } from './task-chat.controller';

describe('TaskChatController — active ownership scope', () => {
    it('threads active scope through mention lookup and the edit ownership gate', async () => {
        const scope = {
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        };
        const chat = { edit: jest.fn().mockResolvedValue({ id: 'message-1' }) };
        const agents = {
            findByUserIdScoped: jest.fn().mockResolvedValue({
                rows: [{ id: 'agent-ever', slug: 'ceo' }],
            }),
        };
        const controller = new (TaskChatController as any)(chat, agents, {
            getScope: () => scope,
        }) as TaskChatController;

        await controller.editChat(
            { userId: 'user-1' } as never,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            { body: 'hello @ceo' },
        );

        expect(agents.findByUserIdScoped).toHaveBeenCalledWith('user-1', { limit: 500 }, scope);
        expect(chat.edit).toHaveBeenCalledWith(
            'user-1',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'hello @ceo',
            { ownedAgentSlugs: new Map([['ceo', 'agent-ever']]) },
            scope,
        );
    });
});
