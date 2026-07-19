import { Test, TestingModule } from '@nestjs/testing';
import { MetricsFacadeService, MetricsFacadeError } from '../metrics.facade';
import { FacadeError, NoProviderError, ProviderNotFoundError } from '../base.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { PluginUsageService } from '../../usage/plugin-usage.service';
import { BudgetGuardService } from '../../budgets/budget-guard.service';
import { BudgetExceededException } from '../../budgets/budget-exceeded.exception';
import { PluginUsageCapability } from '../../entities/plugin-usage-event.entity';
import { WorkBudgetScope } from '../../entities/work-budget.entity';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type {
    IMetricsProviderPlugin,
    MetricDescriptor,
    MetricQuery,
    MetricSample,
    PluginManifest,
} from '@ever-works/plugin';

describe('MetricsFacadeService', () => {
    let service: MetricsFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;
    let pluginUsageService: jest.Mocked<Pick<PluginUsageService, 'record'>>;
    let budgetGuard: jest.Mocked<Pick<BudgetGuardService, 'checkBudget'>>;

    const defaultFacadeOptions = { userId: 'user-1', workId: 'work-1' };

    const mockDescriptors: MetricDescriptor[] = [
        {
            id: 'balance',
            label: 'Available balance',
            unit: 'usd',
            supportedWindows: ['point'],
        },
        {
            id: 'income',
            label: 'Income',
            unit: 'usd',
            supportedWindows: ['day', 'week', 'month'],
        },
    ];

    const mockSample: MetricSample = {
        value: 123456,
        unit: 'usd',
        at: '2026-07-19T00:00:00.000Z',
    };

    const mockQuery: MetricQuery = { metricId: 'income', window: 'month' };

    const createMockMetricsPlugin = (
        id: string,
        providerName: string,
        opts?: { withPricing?: boolean },
    ): IMetricsProviderPlugin => ({
        id,
        name: `${providerName} Plugin`,
        version: '1.0.0',
        category: 'metrics',
        capabilities: ['metrics-provider'],
        settingsSchema: { type: 'object', properties: {} },
        providerName,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        isAvailable: jest.fn().mockReturnValue(true),
        listMetrics: jest.fn().mockResolvedValue(mockDescriptors),
        getMetricValue: jest.fn().mockResolvedValue(mockSample),
        ...(opts?.withPricing && {
            getPricing: jest.fn().mockReturnValue({ costPerCallCents: 3, currency: 'usd' }),
        }),
    });

    const createRegisteredPlugin = (
        plugin: IMetricsProviderPlugin,
        manifest: Partial<PluginManifest>,
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test plugin',
            category: plugin.category,
            capabilities: manifest.capabilities || plugin.capabilities,
            systemPlugin: manifest.systemPlugin,
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    /** Register a plugin for BOTH resolution paths (explicit id + default chain). */
    const registerAsResolvable = (registered: RegisteredPlugin) => {
        registry.get.mockImplementation((id: string) =>
            id === registered.plugin.id ? registered : undefined,
        );
        registry.getByCapability.mockReturnValue([registered]);
    };

    beforeEach(async () => {
        pluginUsageService = {
            record: jest.fn().mockResolvedValue(null),
        };
        budgetGuard = {
            checkBudget: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                MetricsFacadeService,
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
                        getSettings: jest.fn().mockResolvedValue({}),
                    },
                },
                {
                    provide: PluginUsageService,
                    useValue: pluginUsageService,
                },
                {
                    provide: BudgetGuardService,
                    useValue: budgetGuard,
                },
            ],
        }).compile();

        service = module.get<MetricsFacadeService>(MetricsFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('capability plumbing', () => {
        it('targets the metrics-provider capability id from PLUGIN_CAPABILITIES', async () => {
            // The registry-facing capability id and the usage-event capability
            // enum are two different registries — pin BOTH literals since the
            // varchar column + FacadeExceptionFilter rely on them verbatim.
            expect(PLUGIN_CAPABILITIES.METRICS_PROVIDER).toBe('metrics-provider');
            expect(PluginUsageCapability.METRICS).toBe('metrics');

            registry.getByCapability.mockReturnValue([]);
            await expect(service.listMetrics(undefined, defaultFacadeOptions)).rejects.toThrow(
                NoProviderError,
            );
            expect(registry.getByCapability).toHaveBeenCalledWith('metrics-provider');
        });

        it('isConfigured reflects loaded metrics-provider plugins', () => {
            expect(service.isConfigured()).toBe(false);

            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            ]);
            expect(service.isConfigured()).toBe(true);
        });

        it('getAvailableProviders lists providers with enabled state', () => {
            const stripe = createMockMetricsPlugin('stripe', 'Stripe');
            const customHttp = createMockMetricsPlugin('custom-http', 'Custom HTTP');
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(stripe, { capabilities: ['metrics-provider'] }),
                createRegisteredPlugin(
                    customHttp,
                    { capabilities: ['metrics-provider'] },
                    'unloaded',
                ),
            ]);

            expect(service.getAvailableProviders()).toEqual([
                { id: 'stripe', name: 'Stripe', enabled: true },
                { id: 'custom-http', name: 'Custom HTTP', enabled: false },
            ]);
        });
    });

    describe('provider resolution', () => {
        it('resolves an explicit pluginId through the registry (override semantics)', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            const result = await service.listMetrics('stripe', defaultFacadeOptions);

            expect(result).toEqual(mockDescriptors);
            expect(registry.get).toHaveBeenCalledWith('stripe');
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'stripe',
                'work-1',
                'user-1',
            );
        });

        it('prefers the explicit pluginId over facadeOptions.providerOverride', async () => {
            const stripe = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(stripe, { capabilities: ['metrics-provider'] }),
            );

            await service.listMetrics('stripe', {
                ...defaultFacadeOptions,
                providerOverride: 'custom-http',
            });

            expect(registry.get).toHaveBeenCalledWith('stripe');
            expect(stripe.listMetrics).toHaveBeenCalled();
        });

        it('throws ProviderNotFoundError when the pluginId is not registered', async () => {
            registry.get.mockReturnValue(undefined);

            const promise = service.listMetrics('missing-plugin', defaultFacadeOptions);
            await expect(promise).rejects.toThrow(ProviderNotFoundError);
            // Name-stable for FacadeExceptionFilter mapping (PR #1292).
            await promise.catch((e) => expect(e.name).toBe('ProviderNotFoundError'));
        });

        it('throws ProviderNotFoundError when the plugin is registered but not enabled for the scope', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(
                service.getMetricValue('stripe', mockQuery, defaultFacadeOptions),
            ).rejects.toThrow(ProviderNotFoundError);
            expect(plugin.getMetricValue).not.toHaveBeenCalled();
        });

        it('throws ProviderNotFoundError when the registered plugin lacks the metrics-provider capability', async () => {
            const plugin = createMockMetricsPlugin('tavily', 'Tavily');
            registry.get.mockReturnValue(
                createRegisteredPlugin(plugin, { capabilities: ['search'] }),
            );

            await expect(service.listMetrics('tavily', defaultFacadeOptions)).rejects.toThrow(
                ProviderNotFoundError,
            );
        });

        it('falls back to the first enabled provider when pluginId is undefined', async () => {
            const plugin = createMockMetricsPlugin('custom-http', 'Custom HTTP');
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            ]);

            const result = await service.listMetrics(undefined, defaultFacadeOptions);

            expect(result).toEqual(mockDescriptors);
            expect(registry.get).not.toHaveBeenCalled();
            expect(plugin.listMetrics).toHaveBeenCalled();
        });

        it('throws NoProviderError when no metrics provider is enabled', async () => {
            registry.getByCapability.mockReturnValue([]);

            const promise = service.getMetricValue(undefined, mockQuery, defaultFacadeOptions);
            await expect(promise).rejects.toThrow(NoProviderError);
            await promise.catch((e) => expect(e.name).toBe('NoProviderError'));
        });
    });

    describe('listMetrics', () => {
        it('passes resolved settings (Work > User > Admin > defaults) to the provider', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );
            settingsService.getSettings.mockResolvedValue({ apiKey: 'sk-test' });

            await service.listMetrics('stripe', defaultFacadeOptions);

            expect(settingsService.getSettings).toHaveBeenCalledWith('stripe', {
                userId: 'user-1',
                workId: 'work-1',
                includeSecrets: true,
            });
            expect(plugin.listMetrics).toHaveBeenCalledWith({ apiKey: 'sk-test' });
        });

        it('records a capability=metrics usage event after a successful list (discovery is free)', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await service.listMetrics('stripe', defaultFacadeOptions);

            expect(pluginUsageService.record).toHaveBeenCalledTimes(1);
            expect(pluginUsageService.record).toHaveBeenCalledWith({
                workId: 'work-1',
                userId: 'user-1',
                agentId: undefined,
                taskId: undefined,
                pluginId: 'stripe',
                capability: PluginUsageCapability.METRICS,
                units: 1,
                costCents: 0,
                currency: undefined,
                metadata: {
                    operation: 'listMetrics',
                    metricCount: 2,
                },
            });
        });

        it('does not consult the budget guard for discovery calls', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await service.listMetrics('stripe', defaultFacadeOptions);

            expect(budgetGuard.checkBudget).not.toHaveBeenCalled();
        });

        it('wraps provider failures as MetricsFacadeError and records no usage', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            (plugin.listMetrics as jest.Mock).mockRejectedValue(new Error('upstream 500'));
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await expect(service.listMetrics('stripe', defaultFacadeOptions)).rejects.toThrow(
                MetricsFacadeError,
            );
            expect(pluginUsageService.record).not.toHaveBeenCalled();
        });
    });

    describe('getMetricValue', () => {
        it('returns the sample and passes (query, settings) to the provider', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );
            settingsService.getSettings.mockResolvedValue({ apiKey: 'sk-test' });

            const result = await service.getMetricValue('stripe', mockQuery, defaultFacadeOptions);

            expect(result).toEqual(mockSample);
            expect(plugin.getMetricValue).toHaveBeenCalledWith(mockQuery, { apiKey: 'sk-test' });
        });

        it('checks the budget BEFORE invoking the provider (EW-602 gate)', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await service.getMetricValue('stripe', mockQuery, defaultFacadeOptions);

            expect(budgetGuard.checkBudget).toHaveBeenCalledWith(
                'work-1',
                'user-1',
                PluginUsageCapability.METRICS,
                'stripe',
            );
            const guardOrder = budgetGuard.checkBudget.mock.invocationCallOrder[0];
            const providerOrder = (plugin.getMetricValue as jest.Mock).mock.invocationCallOrder[0];
            expect(guardOrder).toBeLessThan(providerOrder);
        });

        it('propagates BudgetExceededException unwrapped, never calls the provider, records no usage', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );
            const budgetError = new BudgetExceededException({
                workId: 'work-1',
                scope: WorkBudgetScope.GLOBAL,
                currentSpendCents: 500,
                capCents: 500,
                currency: 'usd',
            });
            budgetGuard.checkBudget.mockRejectedValue(budgetError);

            await expect(
                service.getMetricValue('stripe', mockQuery, defaultFacadeOptions),
            ).rejects.toBe(budgetError);
            expect(plugin.getMetricValue).not.toHaveBeenCalled();
            expect(pluginUsageService.record).not.toHaveBeenCalled();
        });

        it('skips the budget check when the call has no work scope', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            const result = await service.getMetricValue('stripe', mockQuery, {
                userId: 'user-1',
            });

            expect(result).toEqual(mockSample);
            expect(budgetGuard.checkBudget).not.toHaveBeenCalled();
        });

        it('records usage with declared pricing when the provider implements getPricing', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe', { withPricing: true });
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await service.getMetricValue('stripe', mockQuery, defaultFacadeOptions);

            expect(pluginUsageService.record).toHaveBeenCalledWith({
                workId: 'work-1',
                userId: 'user-1',
                agentId: undefined,
                taskId: undefined,
                pluginId: 'stripe',
                capability: PluginUsageCapability.METRICS,
                units: 1,
                costCents: 3,
                currency: 'usd',
                metadata: {
                    operation: 'getMetricValue',
                    metricId: 'income',
                    window: 'month',
                },
            });
        });

        it('records units-only (costCents 0) when the provider declares no pricing', async () => {
            const plugin = createMockMetricsPlugin('custom-http', 'Custom HTTP');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await service.getMetricValue('custom-http', mockQuery, defaultFacadeOptions);

            expect(pluginUsageService.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    pluginId: 'custom-http',
                    capability: PluginUsageCapability.METRICS,
                    units: 1,
                    costCents: 0,
                    currency: undefined,
                }),
            );
        });

        it('propagates agentId/taskId attribution into the usage event (Phase 15.6)', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await service.getMetricValue('stripe', mockQuery, {
                ...defaultFacadeOptions,
                agentId: 'agent-1',
                taskId: 'task-1',
            });

            expect(pluginUsageService.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    agentId: 'agent-1',
                    taskId: 'task-1',
                }),
            );
        });

        it('does not record usage when the provider read fails', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            (plugin.getMetricValue as jest.Mock).mockRejectedValue(new Error('rate limited'));
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await expect(
                service.getMetricValue('stripe', mockQuery, defaultFacadeOptions),
            ).rejects.toThrow(MetricsFacadeError);
            expect(pluginUsageService.record).not.toHaveBeenCalled();
        });
    });

    describe('error mapping', () => {
        it('wraps non-Facade provider errors as name-stable MetricsFacadeError with cause', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            const cause = new Error('connection reset');
            (plugin.getMetricValue as jest.Mock).mockRejectedValue(cause);
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            let caught: unknown;
            try {
                await service.getMetricValue('stripe', mockQuery, defaultFacadeOptions);
            } catch (e) {
                caught = e;
            }

            expect(caught).toBeInstanceOf(MetricsFacadeError);
            const error = caught as MetricsFacadeError;
            // `.name` is the FacadeExceptionFilter mapping key (PR #1292) —
            // pin the literal, not just the class identity.
            expect(error.name).toBe('MetricsFacadeError');
            expect(error.operation).toBe('getMetricValue');
            expect(error.provider).toBe('stripe');
            expect(error.cause).toBe(cause);
            expect(error.message).toContain('connection reset');
        });

        it('lets FacadeError subclasses thrown by the provider pass through unwrapped', async () => {
            const plugin = createMockMetricsPlugin('stripe', 'Stripe');
            const nested = new FacadeError('nested facade failure', 'getMetricValue', 'stripe');
            (plugin.getMetricValue as jest.Mock).mockRejectedValue(nested);
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            await expect(
                service.getMetricValue('stripe', mockQuery, defaultFacadeOptions),
            ).rejects.toBe(nested);
        });

        it('stringifies non-Error throwables into the wrapped cause', async () => {
            const plugin = createMockMetricsPlugin('custom-http', 'Custom HTTP');
            (plugin.listMetrics as jest.Mock).mockRejectedValue('boom');
            registerAsResolvable(
                createRegisteredPlugin(plugin, { capabilities: ['metrics-provider'] }),
            );

            let caught: unknown;
            try {
                await service.listMetrics('custom-http', defaultFacadeOptions);
            } catch (e) {
                caught = e;
            }

            expect(caught).toBeInstanceOf(MetricsFacadeError);
            const error = caught as MetricsFacadeError;
            expect(error.cause).toBeInstanceOf(Error);
            expect(error.cause?.message).toBe('boom');
        });
    });
});
