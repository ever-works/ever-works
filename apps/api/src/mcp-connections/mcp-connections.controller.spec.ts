import { NotFoundException } from '@nestjs/common';
import { McpConnectionsController } from './mcp-connections.controller';
import { AgentMcpServersController } from './agent-mcp-servers.controller';
import type { McpConnectionsService } from '@ever-works/agent/mcp';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Agent Plugins MCP slice — controller delegation pins. The behavioral
 * matrix (masking, resolution, SSRF, cross-user 404) is covered in
 * `packages/agent/src/mcp/__tests__`; these pins assert the HTTP layer
 * scopes every call to the AUTHENTICATED user and propagates the
 * service's 404 untouched (no existence leak).
 */
const auth = { userId: 'u1' } as AuthenticatedUser;

function makeService(): jest.Mocked<
    Pick<
        McpConnectionsService,
        | 'list'
        | 'get'
        | 'create'
        | 'update'
        | 'remove'
        | 'test'
        | 'listForAgent'
        | 'setAgentBinding'
        | 'clearAgentBinding'
    >
> {
    return {
        list: jest.fn().mockResolvedValue([{ id: 'c1' }]),
        get: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        update: jest.fn().mockResolvedValue({ id: 'c1' }),
        remove: jest.fn().mockResolvedValue({ deleted: true }),
        test: jest.fn().mockResolvedValue({ ok: true, toolCount: 1, tools: ['t'] }),
        listForAgent: jest.fn().mockResolvedValue([]),
        setAgentBinding: jest.fn().mockResolvedValue({}),
        clearAgentBinding: jest.fn().mockResolvedValue({}),
    } as never;
}

describe('McpConnectionsController', () => {
    it('scopes every call to the authenticated user', async () => {
        const service = makeService();
        const controller = new McpConnectionsController(service as never);

        await controller.list(auth);
        await controller.create(auth, {
            name: 'github',
            url: 'https://mcp.example.com',
            transport: 'streamable-http',
            authHeaders: { Authorization: 'Bearer x' },
        });
        await controller.update(auth, 'c1', { enabled: false });
        await controller.remove(auth, 'c1');
        await controller.test(auth, 'c1');

        expect(service.list).toHaveBeenCalledWith('u1');
        expect(service.create).toHaveBeenCalledWith('u1', {
            name: 'github',
            url: 'https://mcp.example.com',
            transport: 'streamable-http',
            authHeaders: { Authorization: 'Bearer x' },
        });
        expect(service.update).toHaveBeenCalledWith('u1', 'c1', {
            name: undefined,
            url: undefined,
            transport: undefined,
            authHeaders: undefined,
            enabled: false,
        });
        expect(service.remove).toHaveBeenCalledWith('u1', 'c1');
        expect(service.test).toHaveBeenCalledWith('u1', 'c1');
    });

    it('wraps list results in { data }', async () => {
        const controller = new McpConnectionsController(makeService() as never);
        await expect(controller.list(auth)).resolves.toEqual({ data: [{ id: 'c1' }] });
    });

    it('propagates the service 404 untouched (no existence leak)', async () => {
        const service = makeService();
        service.get.mockRejectedValue(new NotFoundException('MCP connection c1 not found.'));
        const controller = new McpConnectionsController(service as never);
        await expect(controller.get(auth, 'c1')).rejects.toThrow(NotFoundException);
    });
});

describe('AgentMcpServersController', () => {
    it('scopes binding calls to the authenticated user + path agent', async () => {
        const service = makeService();
        const controller = new AgentMcpServersController(service as never);

        await controller.list(auth, 'agent-1');
        await controller.set(auth, 'agent-1', 'c1', { enabled: false });
        await controller.clear(auth, 'agent-1', 'c1');

        expect(service.listForAgent).toHaveBeenCalledWith('u1', 'agent-1');
        expect(service.setAgentBinding).toHaveBeenCalledWith('u1', 'agent-1', 'c1', false);
        expect(service.clearAgentBinding).toHaveBeenCalledWith('u1', 'agent-1', 'c1');
    });
});
