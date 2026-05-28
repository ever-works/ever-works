import { Test, TestingModule } from '@nestjs/testing';
import { AgentMemoryFacadeService, AgentMemoryFacadeError } from '../agent-memory.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    IAgentMemoryPlugin,
    PluginManifest,
    AgentMemoryRecord,
    AgentMemorySession,
    AgentMemorySearchResponse,
    AgentMemoryContext,
} from '@ever-works/plugin';
import { NoProviderError } from '../base.facade';

describe('AgentMemoryFacadeService', () => {
    let service: AgentMemoryFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const createMockMemoryPlugin = (id: string, providerName: string): IAgentMemoryPlugin => ({
        id,
        name: providerName,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['agent-memory'],
        settingsSchema: { type: 'object', properties: {} },
        providerName,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        openSession: jest.fn().mockResolvedValue({
            id: 'sess-1',
            startedAt: '2026-01-01T00:00:00Z',
        } as AgentMemorySession),
        closeSession: jest.fn().mockResolvedValue(undefined),
        saveMemory: jest.fn().mockResolvedValue({
            id: 'mem-1',
            content: 'remembered',
            createdAt: '2026-01-01T00:00:00Z',
        } as AgentMemoryRecord),
        searchMemory: jest.fn().mockResolvedValue({
            results: [],
        } as AgentMemorySearchResponse),
        buildContext: jest.fn().mockResolvedValue({
            content: 'context',
        } as AgentMemoryContext),
        deleteEntry: jest.fn().mockResolvedValue(undefined),
        listSessions: jest.fn().mockResolvedValue([]),
    });

    const createRegisteredPlugin = (
        plugin: IAgentMemoryPlugin,
        manifest: Partial<PluginManifest>,
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test agent-memory plugin',
            category: plugin.category,
            capabilities: manifest.capabilities || plugin.capabilities,
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AgentMemoryFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest
                            .fn()
                            .mockResolvedValue({ baseUrl: 'http://localhost:3111' }),
                    },
                },
            ],
        }).compile();

        service = module.get<AgentMemoryFacadeService>(AgentMemoryFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('isConfigured', () => {
        it('returns true when a loaded agent-memory plugin is registered', () => {
            const plugin = createMockMemoryPlugin('agentmemory', 'Agent Memory');
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['agent-memory'] }),
            ]);
            expect(service.isConfigured()).toBe(true);
        });

        it('returns false when no agent-memory plugins are registered', () => {
            registry.getByCapability.mockReturnValue([]);
            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('routing', () => {
        const opts = { userId: 'user-1', workId: 'work-1' };

        function wireSinglePlugin(): IAgentMemoryPlugin {
            const plugin = createMockMemoryPlugin('agentmemory', 'Agent Memory');
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['agent-memory'] }),
            ]);
            return plugin;
        }

        it('openSession passes injected settings to the plugin', async () => {
            const plugin = wireSinglePlugin();
            await service.openSession({ workId: 'work-1' }, opts);
            expect(plugin.openSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: { workId: 'work-1' },
                    settings: { baseUrl: 'http://localhost:3111' },
                }),
            );
        });

        it('saveMemory dispatches with the resolved settings hierarchy', async () => {
            const plugin = wireSinglePlugin();
            await service.saveMemory({ content: 'x' }, opts);
            expect(plugin.saveMemory).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'x',
                    settings: { baseUrl: 'http://localhost:3111' },
                }),
            );
            expect(settingsService.getSettings).toHaveBeenCalledWith(
                'agentmemory',
                expect.objectContaining({
                    userId: 'user-1',
                    workId: 'work-1',
                    includeSecrets: true,
                }),
            );
        });

        it('searchMemory forwards limit + tags through', async () => {
            const plugin = wireSinglePlugin();
            await service.searchMemory({ query: 'auth bug', limit: 5, tags: ['bug'] }, opts);
            expect(plugin.searchMemory).toHaveBeenCalledWith(
                expect.objectContaining({ query: 'auth bug', limit: 5, tags: ['bug'] }),
            );
        });

        it('buildContext returns the plugin response verbatim', async () => {
            const plugin = wireSinglePlugin();
            (plugin.buildContext as jest.Mock).mockResolvedValueOnce({ content: 'hello' });
            const result = await service.buildContext({ query: 'q' }, opts);
            expect(result.content).toBe('hello');
        });

        it('listSessions calls the plugin and returns its list', async () => {
            const plugin = wireSinglePlugin();
            (plugin.listSessions as jest.Mock).mockResolvedValueOnce([
                { id: 's1', startedAt: 't1' },
            ]);
            const result = await service.listSessions({ limit: 3 }, opts);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('s1');
        });
    });

    describe('error surfaces', () => {
        it('throws NoProviderError when no plugin is registered for the capability', async () => {
            registry.getByCapability.mockReturnValue([]);
            await expect(service.saveMemory({ content: 'x' }, { userId: 'u' })).rejects.toThrow(
                NoProviderError,
            );
        });

        it('wraps plugin errors as AgentMemoryFacadeError with operation metadata', async () => {
            const plugin = createMockMemoryPlugin('agentmemory', 'Agent Memory');
            (plugin.saveMemory as jest.Mock).mockRejectedValueOnce(new Error('backend down'));
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['agent-memory'] }),
            ]);
            await expect(
                service.saveMemory({ content: 'x' }, { userId: 'u' }),
            ).rejects.toMatchObject({
                name: 'AgentMemoryFacadeError',
                operation: 'saveMemory',
                provider: 'agentmemory',
            });
        });

        it('rejects deleteEntry when the resolved plugin omits it', async () => {
            const plugin = createMockMemoryPlugin('agentmemory', 'Agent Memory');
            delete (plugin as any).deleteEntry;
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['agent-memory'] }),
            ]);
            await expect(service.deleteEntry('mem-1', { userId: 'u' })).rejects.toThrow(
                /does not support deleteEntry/,
            );
        });
    });
});
