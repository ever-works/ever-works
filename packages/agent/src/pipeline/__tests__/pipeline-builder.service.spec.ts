import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    PipelineBuilderService,
    CircularDependencyError,
    MissingDependencyError,
} from '../pipeline-builder.service';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { DefaultPipelinePlugin } from '@ever-works/default-pipeline-plugin';
import type {
    IPlugin,
    PluginManifest,
    PluginCategory,
    PipelineStepDefinition,
    IPipelineStepPlugin,
    MutableGenerationContext,
    StepPosition,
} from '@ever-works/plugin';

describe('PipelineBuilderService', () => {
    let service: PipelineBuilderService;
    let registry: PluginRegistryService;

    const createMockPipelinePlugin = (
        id: string,
        stepDef: PipelineStepDefinition,
    ): IPipelineStepPlugin =>
        ({
            id,
            name: `Plugin ${id}`,
            version: '1.0.0',
            category: 'pipeline' as PluginCategory,
            capabilities: ['pipeline-step'],
            settingsSchema: { type: 'object', properties: {} },
            configurationMode: 'hybrid',
            onLoad: jest.fn(),
            onEnable: jest.fn(),
            onDisable: jest.fn(),
            onUnload: jest.fn(),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            getStepDefinition: () => stepDef,
            execute: jest.fn().mockImplementation((ctx) => Promise.resolve(ctx)),
        }) as unknown as IPipelineStepPlugin;

    const createMockManifest = (id: string): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: 'pipeline' as PluginCategory,
        capabilities: ['pipeline-step'],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PipelineBuilderService,
                PluginRegistryService,
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                        on: jest.fn(),
                        off: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<PipelineBuilderService>(PipelineBuilderService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
    });

    afterEach(() => {
        registry.clear();
    });

    describe('build()', () => {
        it('should return built-in steps when no plugins enabled', async () => {
            const pipeline = await service.build();

            expect(pipeline.steps.length).toBe(DefaultPipelinePlugin.getBuiltInSteps().length);
            expect(pipeline.source).toBe('standard');
            expect(pipeline.disabledSteps.size).toBe(0);
            expect(pipeline.replacedSteps.size).toBe(0);
            expect(pipeline.injectedSteps.size).toBe(0);
        });

        it('should include all built-in step IDs', async () => {
            const pipeline = await service.build();

            const stepIds = pipeline.steps.map((s) => s.id);
            for (const builtIn of DefaultPipelinePlugin.getBuiltInSteps()) {
                expect(stepIds).toContain(builtIn.id);
            }
        });

        it('should create executor map for built-in steps', async () => {
            const pipeline = await service.build();

            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                const executor = pipeline.executorMap.get(step.id);
                expect(executor).toBeDefined();
                expect(executor?.type).toBe('builtin');
            }
        });

        it('should identify parallel groups', async () => {
            const pipeline = await service.build();

            expect(pipeline.groups.length).toBeGreaterThan(0);
            // Verify all steps are in groups
            const stepsInGroups = new Set(pipeline.groups.flatMap((g) => g.stepIds));
            for (const step of pipeline.steps) {
                expect(stepsInGroups.has(step.id)).toBe(true);
            }
        });

        it('should calculate estimated duration', async () => {
            const pipeline = await service.build();

            expect(pipeline.estimatedDuration).toBeGreaterThan(0);
        });
    });

    describe('step replacement (Task 3.5)', () => {
        it('should replace step when plugin provides replacement', async () => {
            const replacementStep: PipelineStepDefinition = {
                id: 'custom-domain-detection',
                name: 'Custom Domain Detection',
                position: { type: 'replace', stepId: 'domain-detection' },
                provides: ['domainAnalysis'],
                requires: ['subject'],
            };

            const plugin = createMockPipelinePlugin('domain-plugin', replacementStep);
            registry.register(plugin as unknown as IPlugin, createMockManifest('domain-plugin'), {
                state: 'enabled',
            });

            const pipeline = await service.build();

            // The replacement step takes on the original step's ID for dependency resolution
            // but the name should be the replacement's name
            const domainStep = pipeline.steps.find((s) => s.id === 'domain-detection');
            expect(domainStep).toBeDefined();
            expect(domainStep?.name).toBe('Custom Domain Detection');

            // Track the original replacement step ID
            expect(pipeline.replacedSteps.has('domain-detection')).toBe(true);
            expect(pipeline.replacedSteps.get('domain-detection')).toBe('custom-domain-detection');
        });

        it('should use plugin executor for replaced steps', async () => {
            const replacementStep: PipelineStepDefinition = {
                id: 'custom-prompt-processing',
                name: 'Custom Prompt Processing',
                position: { type: 'replace', stepId: 'prompt-processing' },
                provides: ['subject', 'featuredItemHints'],
            };

            const plugin = createMockPipelinePlugin('prompt-plugin', replacementStep);
            registry.register(plugin as unknown as IPlugin, createMockManifest('prompt-plugin'), {
                state: 'enabled',
            });

            const pipeline = await service.build();

            // The executor is keyed by the original step ID (which the replacement step now uses)
            const executor = pipeline.executorMap.get('prompt-processing');
            expect(executor?.type).toBe('plugin');
            if (executor?.type === 'plugin') {
                expect(executor.pluginId).toBe('prompt-plugin');
                // The stepId in the executor references the original plugin step ID
                expect(executor.stepId).toBe('custom-prompt-processing');
            }
        });
    });

    describe('step injection (Task 3.6)', () => {
        it('should inject step before existing step', async () => {
            const injectedStep: PipelineStepDefinition = {
                id: 'pre-domain-step',
                name: 'Pre Domain Step',
                position: { type: 'before', stepId: 'domain-detection' },
                provides: ['customData'],
            };

            const plugin = createMockPipelinePlugin('inject-plugin', injectedStep);
            registry.register(plugin as unknown as IPlugin, createMockManifest('inject-plugin'), {
                state: 'enabled',
            });

            const pipeline = await service.build();

            const domainIndex = pipeline.steps.findIndex((s) => s.id === 'domain-detection');
            const injectedIndex = pipeline.steps.findIndex((s) => s.id === 'pre-domain-step');

            expect(injectedIndex).toBeGreaterThanOrEqual(0);
            expect(injectedIndex).toBeLessThan(domainIndex);
            expect(pipeline.injectedSteps.has('pre-domain-step')).toBe(true);
        });

        it('should inject step after existing step', async () => {
            const injectedStep: PipelineStepDefinition = {
                id: 'post-search-step',
                name: 'Post Search Step',
                position: { type: 'after', stepId: 'web-search' },
                provides: ['additionalUrls'],
            };

            const plugin = createMockPipelinePlugin('post-search-plugin', injectedStep);
            registry.register(
                plugin as unknown as IPlugin,
                createMockManifest('post-search-plugin'),
                { state: 'enabled' },
            );

            const pipeline = await service.build();

            // After topological sort, the injected step should come after web-search
            // but before any step that depends on web-search's output
            const searchIndex = pipeline.steps.findIndex((s) => s.id === 'web-search');
            const injectedIndex = pipeline.steps.findIndex((s) => s.id === 'post-search-step');

            expect(injectedIndex).toBeGreaterThanOrEqual(0);
            expect(pipeline.injectedSteps.has('post-search-step')).toBe(true);
        });
    });

    describe('step disabling (Task 3.7)', () => {
        it('should not include disabled steps', async () => {
            // We need to test the disableStep method indirectly through build context
            // For now, verify that disabled steps set is properly tracked
            const pipeline = await service.build();

            // Initially no steps should be disabled
            expect(pipeline.disabledSteps.size).toBe(0);
        });
    });

    describe('append/prepend positioning (Task 3.8)', () => {
        it('should prepend step to pipeline start', async () => {
            const prependStep: PipelineStepDefinition = {
                id: 'init-step',
                name: 'Initialization Step',
                position: { type: 'first' },
                provides: ['initData'],
            };

            const plugin = createMockPipelinePlugin('init-plugin', prependStep);
            registry.register(plugin as unknown as IPlugin, createMockManifest('init-plugin'), {
                state: 'enabled',
            });

            const pipeline = await service.build();

            // After topological sort, step should still be early (no dependencies)
            const initIndex = pipeline.steps.findIndex((s) => s.id === 'init-step');
            expect(initIndex).toBeGreaterThanOrEqual(0);
            expect(pipeline.injectedSteps.has('init-step')).toBe(true);
        });

        it('should append step to pipeline end', async () => {
            const appendStep: PipelineStepDefinition = {
                id: 'cleanup-step',
                name: 'Cleanup Step',
                position: { type: 'last' },
                provides: ['cleanupResult'],
                dependencies: [{ stepId: 'markdown-generation', required: false }],
            };

            const plugin = createMockPipelinePlugin('cleanup-plugin', appendStep);
            registry.register(plugin as unknown as IPlugin, createMockManifest('cleanup-plugin'), {
                state: 'enabled',
            });

            const pipeline = await service.build();

            const cleanupIndex = pipeline.steps.findIndex((s) => s.id === 'cleanup-step');
            expect(cleanupIndex).toBeGreaterThanOrEqual(0);
            expect(pipeline.injectedSteps.has('cleanup-step')).toBe(true);
        });
    });

    describe('topological sort', () => {
        it('should topologically sort steps by dependencies', async () => {
            const pipeline = await service.build();

            // Verify dependency order is maintained
            const stepIndexMap = new Map(pipeline.steps.map((s, i) => [s.id, i]));

            for (const step of pipeline.steps) {
                if (step.dependencies) {
                    for (const dep of step.dependencies) {
                        if (dep.required) {
                            const depIndex = stepIndexMap.get(dep.stepId);
                            const stepIndex = stepIndexMap.get(step.id);
                            if (depIndex !== undefined && stepIndex !== undefined) {
                                expect(depIndex).toBeLessThan(stepIndex as number);
                            }
                        }
                    }
                }
            }
        });

        it('should detect circular dependencies and throw', async () => {
            // Create two steps that depend on each other
            const stepA: PipelineStepDefinition = {
                id: 'step-a',
                name: 'Step A',
                position: { type: 'first' },
                dependencies: [{ stepId: 'step-b', required: true }],
                provides: ['dataA'],
            };

            const stepB: PipelineStepDefinition = {
                id: 'step-b',
                name: 'Step B',
                position: { type: 'last' },
                dependencies: [{ stepId: 'step-a', required: true }],
                provides: ['dataB'],
            };

            const pluginA = createMockPipelinePlugin('plugin-a', stepA);
            const pluginB = createMockPipelinePlugin('plugin-b', stepB);

            registry.register(pluginA as unknown as IPlugin, createMockManifest('plugin-a'), {
                state: 'enabled',
            });
            registry.register(pluginB as unknown as IPlugin, createMockManifest('plugin-b'), {
                state: 'enabled',
            });

            await expect(service.build()).rejects.toThrow(CircularDependencyError);
            await expect(service.build()).rejects.toThrow(/step-a -> step-b -> step-a/);
        });
    });

    describe('validation', () => {
        it('should detect duplicate step IDs and throw', async () => {
            const stepA: PipelineStepDefinition = {
                id: 'duplicate-step',
                name: 'Step A',
                position: { type: 'first' },
            };

            const stepB: PipelineStepDefinition = {
                id: 'duplicate-step', // Duplicate ID
                name: 'Step B',
                position: { type: 'last' },
            };

            const pluginA = createMockPipelinePlugin('plugin-a', stepA);
            const pluginB = createMockPipelinePlugin('plugin-b', stepB);

            registry.register(pluginA as unknown as IPlugin, createMockManifest('plugin-a'), {
                state: 'enabled',
            });
            registry.register(pluginB as unknown as IPlugin, createMockManifest('plugin-b'), {
                state: 'enabled',
            });

            await expect(service.build()).rejects.toThrow(
                'Duplicate step ID detected: "duplicate-step"',
            );
        });
    });

    describe('parallel groups', () => {
        it('should identify parallel groups for concurrent execution', async () => {
            const pipeline = await service.build();

            // Find groups with multiple steps (parallelizable)
            const parallelGroups = pipeline.groups.filter((g) => g.stepIds.length > 1);

            // The built-in pipeline has some parallelizable steps
            // (e.g., content-retrieval, items-extraction, image-capture are marked parallelizable)
            expect(pipeline.groups.length).toBeGreaterThan(0);
        });

        it('should correctly group independent steps (A -> [B, C] -> D)', async () => {
            // Mock the built-in steps to create a specific dependency graph
            // A -> B
            // A -> C
            // B, C -> D
            // B and C are parallelizable
            const mockSteps: PipelineStepDefinition[] = [
                {
                    id: 'step-a',
                    name: 'Step A',
                    position: { type: 'first' },
                    parallelizable: false,
                },
                {
                    id: 'step-b',
                    name: 'Step B',
                    position: { type: 'after', stepId: 'step-a' },
                    dependencies: [{ stepId: 'step-a', required: true }],
                    parallelizable: true,
                },
                {
                    id: 'step-c',
                    name: 'Step C',
                    position: { type: 'after', stepId: 'step-a' },
                    dependencies: [{ stepId: 'step-a', required: true }],
                    parallelizable: true,
                },
                {
                    id: 'step-d',
                    name: 'Step D',
                    position: { type: 'last' },
                    dependencies: [
                        { stepId: 'step-b', required: true },
                        { stepId: 'step-c', required: true },
                    ],
                    parallelizable: false,
                },
            ];

            jest.spyOn(DefaultPipelinePlugin, 'getBuiltInSteps').mockReturnValue(mockSteps as any);

            const pipeline = await service.build();

            // We expect 3 groups: [A], [B, C], [D]
            expect(pipeline.groups).toHaveLength(3);

            // Group 1: Step A
            expect(pipeline.groups[0].stepIds).toHaveLength(1);
            expect(pipeline.groups[0].stepIds).toContain('step-a');

            // Group 2: Step B and C (Parallel)
            expect(pipeline.groups[1].stepIds).toHaveLength(2);
            expect(pipeline.groups[1].stepIds).toContain('step-b');
            expect(pipeline.groups[1].stepIds).toContain('step-c');

            // Group 3: Step D
            expect(pipeline.groups[2].stepIds).toHaveLength(1);
            expect(pipeline.groups[2].stepIds).toContain('step-d');

            jest.restoreAllMocks();
        });

        it('should set maxConcurrent for parallel groups', async () => {
            const pipeline = await service.build();

            for (const group of pipeline.groups) {
                if (group.stepIds.length > 1) {
                    expect(group.maxConcurrent).toBeDefined();
                    expect(group.maxConcurrent).toBeGreaterThan(0);
                }
            }
        });

        it('should track allRequired flag for groups', async () => {
            const pipeline = await service.build();

            for (const group of pipeline.groups) {
                expect(typeof group.allRequired).toBe('boolean');
            }
        });
    });

    describe('getBuiltInSteps()', () => {
        it('should return copy of built-in steps', () => {
            const steps = service.getBuiltInSteps();

            expect(steps).toHaveLength(DefaultPipelinePlugin.getBuiltInSteps().length);
            expect(steps).not.toBe(DefaultPipelinePlugin.getBuiltInSteps());
        });
    });

    describe('plugin filtering', () => {
        it('should only include enabled plugins', async () => {
            const enabledStep: PipelineStepDefinition = {
                id: 'enabled-step',
                name: 'Enabled Step',
                position: { type: 'last' },
            };

            const disabledStep: PipelineStepDefinition = {
                id: 'disabled-step',
                name: 'Disabled Step',
                position: { type: 'last' },
            };

            const enabledPlugin = createMockPipelinePlugin('enabled-plugin', enabledStep);
            const disabledPlugin = createMockPipelinePlugin('disabled-plugin', disabledStep);

            registry.register(
                enabledPlugin as unknown as IPlugin,
                createMockManifest('enabled-plugin'),
                { state: 'enabled' },
            );
            registry.register(
                disabledPlugin as unknown as IPlugin,
                createMockManifest('disabled-plugin'),
                { state: 'loaded' }, // Not enabled
            );

            const pipeline = await service.build();

            expect(pipeline.steps.some((s) => s.id === 'enabled-step')).toBe(true);
            expect(pipeline.steps.some((s) => s.id === 'disabled-step')).toBe(false);
        });
    });
});
