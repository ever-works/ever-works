import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { McpConnectionsService } from '../mcp-connections.service';
import type { McpServerConnection } from '../../entities/mcp-server-connection.entity';

function makeRow(over: Partial<McpServerConnection> = {}): McpServerConnection {
    return {
        id: 'c1',
        userId: 'u1',
        name: 'github',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
        authHeaders: { Authorization: 'Bearer secret-value' },
        enabled: true,
        source: 'manual',
        lastConnectedAt: null,
        lastError: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as McpServerConnection;
}

function makeHarness(rows: McpServerConnection[] = [makeRow()]) {
    const connectionsRepo = {
        findByUser: jest.fn().mockResolvedValue(rows),
        findEnabledByUser: jest.fn().mockResolvedValue(rows.filter((r) => r.enabled)),
        findByIdAndUser: jest
            .fn()
            .mockImplementation(
                async (id: string, userId: string) =>
                    rows.find((r) => r.id === id && r.userId === userId) ?? null,
            ),
        findByUserAndName: jest
            .fn()
            .mockImplementation(
                async (userId: string, name: string) =>
                    rows.find((r) => r.userId === userId && r.name === name) ?? null,
            ),
        create: jest
            .fn()
            .mockImplementation(async (data: Partial<McpServerConnection>) =>
                makeRow({ ...data, id: 'new-id' } as Partial<McpServerConnection>),
            ),
        save: jest.fn().mockImplementation(async (row: McpServerConnection) => row),
        deleteByIdAndUser: jest.fn().mockResolvedValue(undefined),
        stampConnectionResult: jest.fn().mockResolvedValue(undefined),
    };
    const bindingsRepo = {
        upsert: jest.fn().mockResolvedValue({}),
        deleteOne: jest.fn().mockResolvedValue(undefined),
        findForAgent: jest.fn().mockResolvedValue([]),
    };
    const client = {
        listTools: jest.fn().mockResolvedValue([
            { name: 'search_issues', description: '', inputSchema: {} },
            { name: 'create_issue', description: '', inputSchema: {} },
        ]),
        invalidate: jest.fn(),
    };
    const agents = {
        findByIdAndUser: jest
            .fn()
            .mockImplementation(async (agentId: string, userId: string) =>
                agentId === 'agent-1' && userId === 'u1' ? { id: agentId, userId } : null,
            ),
    };
    const service = new McpConnectionsService(
        connectionsRepo as never,
        bindingsRepo as never,
        client as never,
        agents as never,
        undefined,
    );
    return { service, connectionsRepo, bindingsRepo, client, agents };
}

describe('McpConnectionsService', () => {
    describe('masking', () => {
        it('list/get responses carry header NAMES only — never values', async () => {
            const { service } = makeHarness();
            const [view] = await service.list('u1');
            expect(view.authHeaderNames).toEqual(['Authorization']);
            expect(JSON.stringify(view)).not.toContain('secret-value');
        });
    });

    describe('create', () => {
        it('creates the connection AND the tenant inherit binding', async () => {
            const { service, bindingsRepo } = makeHarness([]);
            const view = await service.create('u1', {
                name: 'linear',
                url: 'https://mcp.linear.app/mcp',
                transport: 'streamable-http',
                authHeaders: { Authorization: 'Bearer tok' },
            });
            expect(view.name).toBe('linear');
            expect(view.authHeaderNames).toEqual(['Authorization']);
            expect(bindingsRepo.upsert).toHaveBeenCalledWith({
                userId: 'u1',
                connectionId: 'new-id',
                targetType: 'tenant',
                targetId: null,
                enabled: true,
            });
        });

        it('rejects a non-slug name (it becomes the tool-name prefix)', async () => {
            const { service } = makeHarness([]);
            await expect(
                service.create('u1', {
                    name: 'Bad Name!',
                    url: 'https://mcp.example.com',
                    transport: 'sse',
                }),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects a duplicate name for the same user', async () => {
            const { service } = makeHarness([makeRow({ name: 'github' })]);
            await expect(
                service.create('u1', {
                    name: 'github',
                    url: 'https://mcp.example.com',
                    transport: 'streamable-http',
                }),
            ).rejects.toThrow(ConflictException);
        });

        it('rejects private/loopback URLs (SSRF guard)', async () => {
            const { service } = makeHarness([]);
            for (const url of [
                'http://127.0.0.1:8080/mcp',
                'http://169.254.169.254/latest/meta-data',
                'ftp://mcp.example.com',
            ]) {
                await expect(
                    service.create('u1', { name: 'x1', url, transport: 'streamable-http' }),
                ).rejects.toThrow(BadRequestException);
            }
        });

        it('rejects an auth header VALUE carrying control characters', async () => {
            // A CR/LF in the value (trivially pasted from a token file) is
            // rejected by the runtime's `Headers` at connect time, in a
            // TypeError that quotes the value back — so it must never be
            // stored. The 400 names the header, never the value.
            const { service } = makeHarness([]);
            await expect(
                service.create('u1', {
                    name: 'x1',
                    url: 'https://mcp.example.com',
                    transport: 'streamable-http',
                    authHeaders: { Authorization: 'Bearer tok\r\nX-Injected: 1' },
                }),
            ).rejects.toThrow(BadRequestException);
            await expect(
                service.create('u1', {
                    name: 'x1',
                    url: 'https://mcp.example.com',
                    transport: 'streamable-http',
                    authHeaders: { Authorization: 'Bearer tok\r\nX-Injected: 1' },
                }),
            ).rejects.toThrow(/Authorization/);
        });

        it('rejects malformed auth header names', async () => {
            const { service } = makeHarness([]);
            await expect(
                service.create('u1', {
                    name: 'x1',
                    url: 'https://mcp.example.com',
                    transport: 'sse',
                    authHeaders: { 'Bad Header\nName': 'v' },
                }),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('authz (no existence leak)', () => {
        it('cross-user get/update/delete/test resolve to NotFound', async () => {
            const { service } = makeHarness();
            await expect(service.get('other-user', 'c1')).rejects.toThrow(NotFoundException);
            await expect(service.update('other-user', 'c1', { enabled: false })).rejects.toThrow(
                NotFoundException,
            );
            await expect(service.remove('other-user', 'c1')).rejects.toThrow(NotFoundException);
            await expect(service.test('other-user', 'c1')).rejects.toThrow(NotFoundException);
        });

        it('binding endpoints 404 on a foreign agent', async () => {
            const { service } = makeHarness();
            await expect(service.listForAgent('u1', 'foreign-agent')).rejects.toThrow(
                NotFoundException,
            );
            await expect(
                service.setAgentBinding('u1', 'foreign-agent', 'c1', false),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('update', () => {
        it('invalidates the tool cache after an edit', async () => {
            const { service, client } = makeHarness();
            await service.update('u1', 'c1', { url: 'https://mcp2.example.com/mcp' });
            expect(client.invalidate).toHaveBeenCalledWith('c1');
        });
    });

    describe('test', () => {
        it('returns tool names + count on success (bypassing the cache)', async () => {
            const { service, client } = makeHarness();
            const result = await service.test('u1', 'c1');
            expect(result).toEqual({
                ok: true,
                toolCount: 2,
                tools: ['search_issues', 'create_issue'],
            });
            expect(client.listTools).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), {
                bypassCache: true,
            });
        });

        it('returns ok:false with the classified error on failure', async () => {
            const { service, client } = makeHarness();
            client.listTools.mockRejectedValue(
                new Error('Server unreachable (connection failed).'),
            );
            const result = await service.test('u1', 'c1');
            expect(result).toEqual({
                ok: false,
                toolCount: 0,
                tools: [],
                error: 'Server unreachable (connection failed).',
            });
        });
    });

    describe('per-agent binding state (T27)', () => {
        it('reports inherited-from-tenant vs agent-override vs unbound', async () => {
            const rows = [
                makeRow({ id: 'c1', name: 'inherited' }),
                makeRow({ id: 'c2', name: 'overridden' }),
                makeRow({ id: 'c3', name: 'unbound' }),
            ];
            const { service, bindingsRepo } = makeHarness(rows);
            bindingsRepo.findForAgent.mockResolvedValue([
                { connectionId: 'c1', targetType: 'tenant', targetId: null, enabled: true },
                { connectionId: 'c2', targetType: 'tenant', targetId: null, enabled: true },
                { connectionId: 'c2', targetType: 'agent', targetId: 'agent-1', enabled: false },
            ]);

            const states = await service.listForAgent('u1', 'agent-1');

            expect(
                states.map((s) => [
                    s.connection.name,
                    s.effectiveEnabled,
                    s.bindingSource,
                    s.inheritedFromTenant,
                ]),
            ).toEqual([
                ['inherited', true, 'tenant', true],
                ['overridden', false, 'agent', false],
                ['unbound', false, 'none', false],
            ]);
        });
    });
});
