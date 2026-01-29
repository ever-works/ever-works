import { Injectable, Logger } from '@nestjs/common';
import type {
    PipelineStepDefinition,
    StepPosition,
    ExecutablePipeline,
    ParallelGroup,
    StepExecutor,
    IPipelineStepPlugin,
    BuiltInStepId,
    IPlugin,
} from '@ever-works/plugin';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { BUILT_IN_STEPS, isBuiltInStep } from './built-in-steps';

/**
 * Create an empty executable pipeline
 * @param source - The source of the pipeline (standard or plugin ID)
 */
function createExecutablePipeline(source: 'standard' | string = 'standard'): ExecutablePipeline {
    return {
        steps: [],
        groups: [],
        executorMap: new Map(),
        replacedSteps: new Map(),
        disabledSteps: new Set(),
        injectedSteps: new Set(),
        source,
    };
}

/**
 * Type guard for pipeline step plugins
 */
function isPipelineStepPlugin(plugin: IPlugin): plugin is IPipelineStepPlugin {
    return plugin.capabilities.includes('pipeline-step');
}

/**
 * Injected step with position information
 */
interface InjectedStep {
    step: PipelineStepDefinition;
    position: StepPosition;
    pluginId: string;
}

/**
 * Build context for pipeline compilation
 */
interface BuildContext {
    /** Steps to be replaced: original ID -> replacement step */
    replacements: Map<string, { step: PipelineStepDefinition; pluginId: string }>;
    /** Steps to be disabled */
    disabledSteps: Set<string>;
    /** Steps to be injected */
    injections: InjectedStep[];
    /** Steps to prepend (first position) */
    prependSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>;
    /** Steps to append (last position) */
    appendSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>;
}

/**
 * Circular dependency error
 */
export class CircularDependencyError extends Error {
    constructor(
        public readonly cycle: string[],
        message?: string,
    ) {
        super(message || `Circular dependency detected: ${cycle.join(' -> ')}`);
        this.name = 'CircularDependencyError';
    }
}

/**
 * Missing dependency error
 */
export class MissingDependencyError extends Error {
    constructor(
        public readonly stepId: string,
        public readonly missingDependency: string,
    ) {
        super(`Step "${stepId}" depends on missing step "${missingDependency}"`);
        this.name = 'MissingDependencyError';
    }
}

/**
 * Service for building executable pipelines from built-in steps and plugin contributions.
 *
 * This service implements Tasks 3.4-3.8:
 * - 3.4: Pipeline compilation from multiple sources
 * - 3.5: Step replacement
 * - 3.6: Step injection (before/after)
 * - 3.7: Step disabling
 * - 3.8: Append/prepend positioning
 */
@Injectable()
export class PipelineBuilderService {
    private readonly logger = new Logger(PipelineBuilderService.name);

    constructor(private readonly registry: PluginRegistryService) {}

    /**
     * Build an executable pipeline for a directory.
     *
     * @param directoryId - The directory to build the pipeline for
     * @returns A fully compiled ExecutablePipeline ready for execution
     */
    build(directoryId?: string): ExecutablePipeline {
        this.logger.debug(`Building pipeline for directory: ${directoryId || 'global'}`);

        // 1. Start with built-in steps
        let steps = [...BUILT_IN_STEPS];

        // 2. Initialize build context
        const buildContext: BuildContext = {
            replacements: new Map(),
            disabledSteps: new Set(),
            injections: [],
            prependSteps: [],
            appendSteps: [],
        };

        // 3. Get enabled pipeline plugins
        const plugins = this.getEnabledPipelinePlugins();
        this.logger.debug(`Found ${plugins.length} enabled pipeline plugins`);

        // 4. Process each plugin's step contributions
        for (const { registered, pipelinePlugin } of plugins) {
            this.processPluginSteps(pipelinePlugin, registered.plugin.id, buildContext);
        }

        // 5. Apply modifications in order
        // 5a. Apply replacements (Task 3.5)
        steps = this.applyReplacements(steps, buildContext.replacements);

        // 5b. Apply disabling (Task 3.7)
        steps = this.applyDisabling(steps, buildContext.disabledSteps);

        // 5c. Apply injections - before/after (Task 3.6)
        steps = this.applyInjections(steps, buildContext.injections);

        // 5d. Apply prepend/append (Task 3.8)
        steps = this.applyPrependAppend(steps, buildContext.prependSteps, buildContext.appendSteps);

        // 6. Topological sort to respect dependencies
        const orderedSteps = this.topologicalSort(steps);

        // 7. Identify parallel groups
        const groups = this.identifyParallelGroups(orderedSteps);

        // 8. Build executor map
        const executorMap = this.buildExecutorMap(
            orderedSteps,
            buildContext.replacements,
            buildContext.injections,
            buildContext.prependSteps,
            buildContext.appendSteps,
        );

        // 9. Create the executable pipeline
        const pipeline: ExecutablePipeline = {
            ...createExecutablePipeline('standard'),
            steps: orderedSteps,
            groups,
            executorMap,
            replacedSteps: new Map(
                Array.from(buildContext.replacements.entries()).map(([id, { step }]) => [
                    id,
                    step.id,
                ]),
            ),
            disabledSteps: buildContext.disabledSteps,
            injectedSteps: new Set([
                ...buildContext.injections.map((i) => i.step.id),
                ...buildContext.prependSteps.map((p) => p.step.id),
                ...buildContext.appendSteps.map((a) => a.step.id),
            ]),
            estimatedDuration: this.calculateEstimatedDuration(orderedSteps),
        };

        this.logger.log(
            `Built pipeline with ${pipeline.steps.length} steps, ` +
                `${pipeline.groups.length} parallel groups, ` +
                `${pipeline.replacedSteps.size} replacements, ` +
                `${pipeline.disabledSteps.size} disabled`,
        );

        return pipeline;
    }

    /**
     * Get enabled plugins that provide pipeline steps
     */
    private getEnabledPipelinePlugins(): Array<{
        registered: RegisteredPlugin;
        pipelinePlugin: IPipelineStepPlugin;
    }> {
        const result: Array<{
            registered: RegisteredPlugin;
            pipelinePlugin: IPipelineStepPlugin;
        }> = [];

        // Get all enabled plugins with pipeline-step capability
        const pluginsWithCapability = this.registry.getByCapability('pipeline-step');

        for (const registered of pluginsWithCapability) {
            // Only include enabled plugins
            if (registered.state !== 'enabled') {
                continue;
            }

            // Verify it implements IPipelineStepPlugin
            if (isPipelineStepPlugin(registered.plugin)) {
                result.push({
                    registered,
                    pipelinePlugin: registered.plugin,
                });
            }
        }

        return result;
    }

    /**
     * Process steps from a plugin and categorize them by position type
     */
    private processPluginSteps(
        plugin: IPipelineStepPlugin,
        pluginId: string,
        context: BuildContext,
    ): void {
        // Get step definition (single step) or check for multi-step support
        const stepDef = plugin.getStepDefinition();

        // Process the step's position
        this.processStepPosition(stepDef, pluginId, context);
    }

    /**
     * Process a step's position and add it to the appropriate collection
     */
    private processStepPosition(
        step: PipelineStepDefinition,
        pluginId: string,
        context: BuildContext,
    ): void {
        const position = step.position;

        switch (position.type) {
            case 'replace':
                // Task 3.5: Step replacement
                if (context.replacements.has(position.stepId)) {
                    this.logger.warn(
                        `Multiple plugins trying to replace step "${position.stepId}". ` +
                            `Using replacement from plugin "${pluginId}"`,
                    );
                }
                context.replacements.set(position.stepId, { step, pluginId });
                this.logger.debug(
                    `Plugin "${pluginId}" replaces step "${position.stepId}" with "${step.id}"`,
                );
                break;

            case 'before':
            case 'after':
                // Task 3.6: Step injection
                context.injections.push({ step, position, pluginId });
                this.logger.debug(
                    `Plugin "${pluginId}" injects step "${step.id}" ${position.type} "${position.stepId}"`,
                );
                break;

            case 'first':
                // Task 3.8: Prepend
                context.prependSteps.push({ step, pluginId });
                this.logger.debug(`Plugin "${pluginId}" prepends step "${step.id}"`);
                break;

            case 'last':
                // Task 3.8: Append
                context.appendSteps.push({ step, pluginId });
                this.logger.debug(`Plugin "${pluginId}" appends step "${step.id}"`);
                break;

            default:
                this.logger.warn(`Unknown position type for step "${step.id}"`);
        }
    }

    /**
     *
     * When a step is replaced, the replacement step takes on the original step's ID
     * for dependency resolution purposes. This ensures that other steps that depend
     * on the original step will still work correctly.
     */
    private applyReplacements(
        steps: PipelineStepDefinition[],
        replacements: Map<string, { step: PipelineStepDefinition; pluginId: string }>,
    ): PipelineStepDefinition[] {
        return steps.map((step) => {
            const replacement = replacements.get(step.id);
            if (replacement) {
                this.logger.debug(`Replacing step "${step.id}" with "${replacement.step.id}"`);
                // The replacement step takes on the original step's ID for dependency resolution
                // but we track the original replacement step ID in the replacedSteps map
                return {
                    ...replacement.step,
                    // Keep the original step's ID so dependencies still work
                    id: step.id,
                    // Inherit dependencies if replacement doesn't specify them
                    dependencies: replacement.step.dependencies?.length
                        ? replacement.step.dependencies
                        : step.dependencies,
                    // Inherit provides if replacement doesn't specify them
                    provides: replacement.step.provides?.length
                        ? replacement.step.provides
                        : step.provides,
                };
            }
            return step;
        });
    }

    /**
     */
    private applyDisabling(
        steps: PipelineStepDefinition[],
        disabledSteps: Set<string>,
    ): PipelineStepDefinition[] {
        return steps.filter((step) => {
            if (disabledSteps.has(step.id)) {
                this.logger.debug(`Disabling step "${step.id}"`);
                return false;
            }
            return true;
        });
    }

    /**
     */
    private applyInjections(
        steps: PipelineStepDefinition[],
        injections: InjectedStep[],
    ): PipelineStepDefinition[] {
        const result = [...steps];

        // Group injections by target step for efficiency
        const beforeInjections = new Map<string, PipelineStepDefinition[]>();
        const afterInjections = new Map<string, PipelineStepDefinition[]>();

        for (const injection of injections) {
            const targetId =
                injection.position.type === 'before' || injection.position.type === 'after'
                    ? injection.position.stepId
                    : null;

            if (!targetId) continue;

            if (injection.position.type === 'before') {
                if (!beforeInjections.has(targetId)) {
                    beforeInjections.set(targetId, []);
                }
                beforeInjections.get(targetId)!.push(injection.step);
            } else {
                if (!afterInjections.has(targetId)) {
                    afterInjections.set(targetId, []);
                }
                afterInjections.get(targetId)!.push(injection.step);
            }
        }

        // Apply injections by walking through steps and inserting
        const finalResult: PipelineStepDefinition[] = [];

        for (const step of result) {
            // Insert "before" steps
            const beforeSteps = beforeInjections.get(step.id);
            if (beforeSteps) {
                finalResult.push(...beforeSteps);
            }

            // Add the original step
            finalResult.push(step);

            // Insert "after" steps
            const afterSteps = afterInjections.get(step.id);
            if (afterSteps) {
                finalResult.push(...afterSteps);
            }
        }

        return finalResult;
    }

    /**
     */
    private applyPrependAppend(
        steps: PipelineStepDefinition[],
        prependSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
        appendSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
    ): PipelineStepDefinition[] {
        return [...prependSteps.map((p) => p.step), ...steps, ...appendSteps.map((a) => a.step)];
    }

    /**
     * Topological sort of steps based on dependencies.
     * Uses Kahn's algorithm for cycle detection.
     */
    private topologicalSort(steps: PipelineStepDefinition[]): PipelineStepDefinition[] {
        const stepMap = new Map(steps.map((s) => [s.id, s]));
        const inDegree = new Map<string, number>();
        const graph = new Map<string, Set<string>>();

        // Initialize in-degree and adjacency list
        for (const step of steps) {
            inDegree.set(step.id, 0);
            graph.set(step.id, new Set());
        }

        // Build the graph
        for (const step of steps) {
            if (step.dependencies) {
                for (const dep of step.dependencies) {
                    // Only count dependencies that exist in our step set
                    if (stepMap.has(dep.stepId)) {
                        graph.get(dep.stepId)!.add(step.id);
                        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
                    } else if (dep.required) {
                        throw new MissingDependencyError(step.id, dep.stepId);
                    }
                }
            }
        }

        // Find all nodes with no incoming edges
        const queue: string[] = [];
        for (const [stepId, degree] of inDegree) {
            if (degree === 0) {
                queue.push(stepId);
            }
        }

        const sorted: PipelineStepDefinition[] = [];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (visited.has(current)) continue;
            visited.add(current);

            const step = stepMap.get(current);
            if (step) {
                sorted.push(step);
            }

            // Process dependents
            for (const dependent of graph.get(current) || []) {
                const newDegree = (inDegree.get(dependent) || 0) - 1;
                inDegree.set(dependent, newDegree);

                if (newDegree === 0 && !visited.has(dependent)) {
                    queue.push(dependent);
                }
            }
        }

        // Check for cycles
        if (sorted.length !== steps.length) {
            const remaining = steps.filter((s) => !visited.has(s.id)).map((s) => s.id);
            throw new CircularDependencyError(
                remaining,
                `Circular dependency detected among steps: ${remaining.join(', ')}`,
            );
        }

        return sorted;
    }

    /**
     * Identify groups of steps that can run in parallel.
     * Steps with the same set of completed dependencies can run together.
     */
    private identifyParallelGroups(steps: PipelineStepDefinition[]): ParallelGroup[] {
        const groups: ParallelGroup[] = [];
        const completedSteps = new Set<string>();
        let currentGroup: string[] = [];
        let groupIndex = 0;

        for (const step of steps) {
            // Check if all dependencies are complete
            const dependenciesComplete =
                !step.dependencies ||
                step.dependencies.every((d) => !d.required || completedSteps.has(d.stepId));

            if (!dependenciesComplete) {
                // Flush current group and start new one
                if (currentGroup.length > 0) {
                    groups.push(this.createParallelGroup(groupIndex++, currentGroup, steps));
                    currentGroup.forEach((id) => completedSteps.add(id));
                    currentGroup = [];
                }
            }

            // Check if step can be parallelized
            if (step.parallelizable && dependenciesComplete) {
                currentGroup.push(step.id);
            } else {
                // Non-parallelizable step - flush and add as single-step group
                if (currentGroup.length > 0) {
                    groups.push(this.createParallelGroup(groupIndex++, currentGroup, steps));
                    currentGroup.forEach((id) => completedSteps.add(id));
                    currentGroup = [];
                }
                groups.push(this.createParallelGroup(groupIndex++, [step.id], steps));
                completedSteps.add(step.id);
            }
        }

        // Flush remaining
        if (currentGroup.length > 0) {
            groups.push(this.createParallelGroup(groupIndex++, currentGroup, steps));
        }

        return groups;
    }

    /**
     * Create a parallel group
     */
    private createParallelGroup(
        index: number,
        stepIds: string[],
        steps: PipelineStepDefinition[],
    ): ParallelGroup {
        const groupSteps = steps.filter((s) => stepIds.includes(s.id));
        const allRequired = groupSteps.every((s) => !s.optional);

        return {
            id: `group-${index}`,
            stepIds,
            allRequired,
            maxConcurrent: stepIds.length > 1 ? Math.min(stepIds.length, 4) : undefined,
        };
    }

    /**
     * Build the executor map for all steps
     */
    private buildExecutorMap(
        steps: PipelineStepDefinition[],
        replacements: Map<string, { step: PipelineStepDefinition; pluginId: string }>,
        injections: InjectedStep[],
        prependSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
        appendSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
    ): Map<string, StepExecutor> {
        const executorMap = new Map<string, StepExecutor>();

        // Create a lookup for plugin-provided steps
        // For replacements, we map the ORIGINAL step ID to the plugin (since the replacement
        // step takes on the original's ID in the pipeline)
        const pluginSteps = new Map<string, { pluginId: string; originalStepId: string }>();

        for (const [originalId, { step, pluginId }] of replacements) {
            // Map the original ID (which is what the step now has) to the plugin
            pluginSteps.set(originalId, { pluginId, originalStepId: step.id });
        }
        for (const injection of injections) {
            pluginSteps.set(injection.step.id, {
                pluginId: injection.pluginId,
                originalStepId: injection.step.id,
            });
        }
        for (const prepend of prependSteps) {
            pluginSteps.set(prepend.step.id, {
                pluginId: prepend.pluginId,
                originalStepId: prepend.step.id,
            });
        }
        for (const append of appendSteps) {
            pluginSteps.set(append.step.id, {
                pluginId: append.pluginId,
                originalStepId: append.step.id,
            });
        }

        for (const step of steps) {
            const pluginInfo = pluginSteps.get(step.id);

            if (pluginInfo) {
                // Plugin-provided step
                executorMap.set(step.id, {
                    type: 'plugin',
                    pluginId: pluginInfo.pluginId,
                    stepId: pluginInfo.originalStepId,
                });
            } else if (isBuiltInStep(step.id)) {
                // Built-in step
                executorMap.set(step.id, {
                    type: 'builtin',
                    serviceId: step.id,
                });
            } else {
                // Unknown step - should not happen
                this.logger.warn(`Unknown step "${step.id}" - no executor assigned`);
            }
        }

        return executorMap;
    }

    /**
     * Calculate estimated total duration
     */
    private calculateEstimatedDuration(steps: PipelineStepDefinition[]): number {
        return steps.reduce((total, step) => {
            return total + (step.estimatedDuration || 10) * 1000; // Convert to ms
        }, 0);
    }

    /**
     * Disable a step by ID.
     * This is used when plugins request disabling of built-in steps.
     */
    disableStep(stepId: string, context: BuildContext): void {
        context.disabledSteps.add(stepId);
        this.logger.debug(`Step "${stepId}" marked for disabling`);
    }

    /**
     * Get the current built-in steps (for testing/inspection)
     */
    getBuiltInSteps(): PipelineStepDefinition[] {
        return [...BUILT_IN_STEPS];
    }
}
