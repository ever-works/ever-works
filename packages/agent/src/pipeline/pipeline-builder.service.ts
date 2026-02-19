import { Injectable, Logger } from '@nestjs/common';
import type {
    PipelineStepDefinition,
    StepPosition,
    ExecutablePipeline,
    ParallelGroup,
    StepExecutor,
    IPipelinePlugin,
    IPipelineModifierPlugin,
} from '@ever-works/plugin';
import { isPipelineModifierPlugin, PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import {
    PluginRegistryService,
    RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';

/**
 * Create an empty executable pipeline
 * @param source - The source of the pipeline (plugin ID)
 */
function createExecutablePipeline(source: string = 'standard'): ExecutablePipeline {
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
 * Service for building executable pipelines from pipeline plugin steps and modifier contributions.
 *
 */
@Injectable()
export class PipelineBuilderService {
    private readonly logger = new Logger(PipelineBuilderService.name);

    constructor(private readonly registry: PluginRegistryService) {}

    /**
     * Build an executable pipeline for a directory.
     *
     * @param pipeline - The resolved pipeline plugin instance
     * @param directoryId - The directory to build the pipeline for
     * @param userId - Optional user ID for user-level plugin resolution
     * @returns A fully compiled ExecutablePipeline ready for execution
     */
    async build(
        pipeline: IPipelinePlugin,
        directoryId?: string,
        userId?: string,
    ): Promise<ExecutablePipeline> {
        this.logger.debug(
            `Building pipeline for directory: ${directoryId || 'global'} using pipeline: ${pipeline.id}`,
        );

        // 1. Start with steps from the resolved pipeline plugin
        let steps: PipelineStepDefinition[] = [...pipeline.getStepDefinitions()];

        // 2. Initialize build context
        const buildContext: BuildContext = {
            replacements: new Map(),
            disabledSteps: new Set(),
            injections: [],
            prependSteps: [],
            appendSteps: [],
        };

        // 3. Get enabled modifier plugins (with directory-scoped filtering)
        const modifiers = await this.getEnabledModifierPlugins(pipeline.id, directoryId, userId);
        this.logger.debug(`Found ${modifiers.length} enabled modifier plugins`);

        // 4. Process each modifier's step contributions
        for (const { registered, modifierPlugin } of modifiers) {
            this.processModifierSteps(modifierPlugin, registered.plugin.id, buildContext);
        }

        // 5. Apply modifications in order
        steps = this.applyReplacements(steps, buildContext.replacements);
        steps = this.applyDisabling(steps, buildContext.disabledSteps);
        steps = this.applyInjections(steps, buildContext.injections);
        steps = this.applyPrependAppend(steps, buildContext.prependSteps, buildContext.appendSteps);

        // 5e. Check for duplicate step IDs
        this.checkForDuplicateStepIds(steps);

        // 6. Topological sort to respect dependencies
        const orderedSteps = this.topologicalSort(steps);

        // 7. Identify parallel groups
        const groups = this.identifyParallelGroups(orderedSteps);

        // 8. Build executor map
        const executorMap = this.buildExecutorMap(
            orderedSteps,
            pipeline,
            buildContext.replacements,
            buildContext.injections,
            buildContext.prependSteps,
            buildContext.appendSteps,
        );

        // 9. Create the executable pipeline
        const result: ExecutablePipeline = {
            ...createExecutablePipeline(pipeline.id),
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
            `Built pipeline with ${result.steps.length} steps, ` +
                `${result.groups.length} parallel groups, ` +
                `${result.replacedSteps.size} replacements, ` +
                `${result.disabledSteps.size} disabled`,
        );

        return result;
    }

    private checkForDuplicateStepIds(steps: PipelineStepDefinition[]): void {
        const ids = new Set<string>();
        for (const step of steps) {
            if (ids.has(step.id)) {
                throw new Error(
                    `Duplicate step ID detected: "${step.id}". Step IDs must be unique.`,
                );
            }
            ids.add(step.id);
        }
    }

    /**
     * Get enabled modifier plugins that target the given pipeline.
     */
    private async getEnabledModifierPlugins(
        pipelineId: string,
        directoryId?: string,
        userId?: string,
    ): Promise<
        Array<{
            registered: RegisteredPlugin;
            modifierPlugin: IPipelineModifierPlugin;
        }>
    > {
        const result: Array<{
            registered: RegisteredPlugin;
            modifierPlugin: IPipelineModifierPlugin;
        }> = [];

        const pluginsWithCapability = this.registry.getByCapability(
            PLUGIN_CAPABILITIES.PIPELINE_MODIFIER,
        );

        for (const registered of pluginsWithCapability) {
            if (registered.state !== 'loaded') continue;

            const isEnabled = await this.registry.isPluginEnabledForScope(
                registered.plugin.id,
                directoryId,
                userId,
            );
            if (!isEnabled) continue;

            if (!isPipelineModifierPlugin(registered.plugin)) continue;

            // Check targetPipelines
            const targets =
                registered.plugin.targetPipelines ?? registered.manifest.targetPipelines;
            if (!targets?.includes(pipelineId) && !targets?.includes('*')) continue;

            result.push({
                registered,
                modifierPlugin: registered.plugin,
            });
        }

        return result;
    }

    private processModifierSteps(
        modifier: IPipelineModifierPlugin,
        pluginId: string,
        context: BuildContext,
    ): void {
        if (modifier.getStepDefinitions) {
            const stepDefs = modifier.getStepDefinitions();
            for (const stepDef of stepDefs) {
                this.processStepPosition(stepDef, pluginId, context);
            }
        } else {
            const stepDef = modifier.getStepDefinition?.();
            if (stepDef) {
                this.processStepPosition(stepDef, pluginId, context);
            }
        }
    }

    private processStepPosition(
        step: PipelineStepDefinition,
        pluginId: string,
        context: BuildContext,
    ): void {
        const position = step.position;

        switch (position.type) {
            case 'replace':
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
                context.injections.push({ step, position, pluginId });
                this.logger.debug(
                    `Plugin "${pluginId}" injects step "${step.id}" ${position.type} "${position.stepId}"`,
                );
                break;

            case 'disable':
                this.disableStep(position.stepId, context);
                this.logger.debug(`Plugin "${pluginId}" disables step "${position.stepId}"`);
                break;

            case 'first':
                context.prependSteps.push({ step, pluginId });
                this.logger.debug(`Plugin "${pluginId}" prepends step "${step.id}"`);
                break;

            case 'last':
                context.appendSteps.push({ step, pluginId });
                this.logger.debug(`Plugin "${pluginId}" appends step "${step.id}"`);
                break;

            default:
                this.logger.warn(`Unknown position type for step "${step.id}"`);
        }
    }

    private applyReplacements(
        steps: PipelineStepDefinition[],
        replacements: Map<string, { step: PipelineStepDefinition; pluginId: string }>,
    ): PipelineStepDefinition[] {
        return steps.map((step) => {
            const replacement = replacements.get(step.id);
            if (replacement) {
                this.logger.debug(`Replacing step "${step.id}" with "${replacement.step.id}"`);
                return {
                    ...replacement.step,
                    id: step.id,
                    dependencies: replacement.step.dependencies?.length
                        ? replacement.step.dependencies
                        : step.dependencies,
                    provides: replacement.step.provides?.length
                        ? replacement.step.provides
                        : step.provides,
                };
            }
            return step;
        });
    }

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

    private applyInjections(
        steps: PipelineStepDefinition[],
        injections: InjectedStep[],
    ): PipelineStepDefinition[] {
        const result = [...steps];

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

        const finalResult: PipelineStepDefinition[] = [];

        for (const step of result) {
            const beforeSteps = beforeInjections.get(step.id);
            if (beforeSteps) {
                finalResult.push(...beforeSteps);
            }

            finalResult.push(step);

            const afterSteps = afterInjections.get(step.id);
            if (afterSteps) {
                finalResult.push(...afterSteps);
            }
        }

        return finalResult;
    }

    private applyPrependAppend(
        steps: PipelineStepDefinition[],
        prependSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
        appendSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
    ): PipelineStepDefinition[] {
        return [...prependSteps.map((p) => p.step), ...steps, ...appendSteps.map((a) => a.step)];
    }

    private topologicalSort(steps: PipelineStepDefinition[]): PipelineStepDefinition[] {
        const stepMap = new Map(steps.map((s) => [s.id, s]));
        const inDegree = new Map<string, number>();
        const graph = new Map<string, Set<string>>();

        for (const step of steps) {
            inDegree.set(step.id, 0);
            graph.set(step.id, new Set());
        }

        for (const step of steps) {
            if (step.dependencies) {
                for (const dep of step.dependencies) {
                    if (stepMap.has(dep.stepId)) {
                        graph.get(dep.stepId)!.add(step.id);
                        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
                    } else if (dep.required) {
                        throw new MissingDependencyError(step.id, dep.stepId);
                    }
                }
            }
        }

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

            for (const dependent of graph.get(current) || []) {
                const newDegree = (inDegree.get(dependent) || 0) - 1;
                inDegree.set(dependent, newDegree);

                if (newDegree === 0 && !visited.has(dependent)) {
                    queue.push(dependent);
                }
            }
        }

        if (sorted.length !== steps.length) {
            const remainingSteps = steps.filter((s) => !visited.has(s.id));
            const cycle = this.findCycle(remainingSteps, graph);
            const cycleMessage =
                cycle.length > 0 ? cycle.join(' -> ') : remainingSteps.map((s) => s.id).join(', ');

            throw new CircularDependencyError(
                remainingSteps.map((s) => s.id),
                `Circular dependency detected among steps: ${cycleMessage}`,
            );
        }

        return sorted;
    }

    private findCycle(nodes: PipelineStepDefinition[], graph: Map<string, Set<string>>): string[] {
        const visited = new Set<string>();
        const recursionStack = new Set<string>();
        const cycle: string[] = [];

        const dfs = (nodeId: string): boolean => {
            visited.add(nodeId);
            recursionStack.add(nodeId);

            const dependents = graph.get(nodeId) || new Set();
            for (const dependent of dependents) {
                if (!nodes.some((n) => n.id === dependent)) continue;

                if (!visited.has(dependent)) {
                    if (dfs(dependent)) {
                        cycle.push(nodeId);
                        return true;
                    }
                } else if (recursionStack.has(dependent)) {
                    cycle.push(dependent);
                    cycle.push(nodeId);
                    return true;
                }
            }

            recursionStack.delete(nodeId);
            return false;
        };

        for (const node of nodes) {
            if (!visited.has(node.id)) {
                if (dfs(node.id)) {
                    return cycle.reverse();
                }
            }
        }

        return [];
    }

    private identifyParallelGroups(steps: PipelineStepDefinition[]): ParallelGroup[] {
        const groups: ParallelGroup[] = [];
        const completedSteps = new Set<string>();
        let currentGroup: string[] = [];
        let groupIndex = 0;
        const DEFAULT_CONCURRENCY = 4;

        for (const step of steps) {
            const dependenciesComplete =
                !step.dependencies ||
                step.dependencies.every((d) => !d.required || completedSteps.has(d.stepId));

            if (!dependenciesComplete) {
                if (currentGroup.length > 0) {
                    groups.push(
                        this.createParallelGroup(
                            groupIndex++,
                            currentGroup,
                            steps,
                            DEFAULT_CONCURRENCY,
                        ),
                    );
                    currentGroup.forEach((id) => completedSteps.add(id));
                    currentGroup = [];
                }
            }

            if (step.parallelizable && dependenciesComplete) {
                currentGroup.push(step.id);
            } else {
                if (currentGroup.length > 0) {
                    groups.push(
                        this.createParallelGroup(
                            groupIndex++,
                            currentGroup,
                            steps,
                            DEFAULT_CONCURRENCY,
                        ),
                    );
                    currentGroup.forEach((id) => completedSteps.add(id));
                    currentGroup = [];
                }
                groups.push(
                    this.createParallelGroup(groupIndex++, [step.id], steps, DEFAULT_CONCURRENCY),
                );
                completedSteps.add(step.id);
            }
        }

        if (currentGroup.length > 0) {
            groups.push(
                this.createParallelGroup(groupIndex++, currentGroup, steps, DEFAULT_CONCURRENCY),
            );
        }

        return groups;
    }

    private createParallelGroup(
        index: number,
        stepIds: string[],
        steps: PipelineStepDefinition[],
        concurrencyLimit: number,
    ): ParallelGroup {
        const groupSteps = steps.filter((s) => stepIds.includes(s.id));
        const allRequired = groupSteps.every((s) => !s.optional);

        return {
            id: `group-${index}`,
            stepIds,
            allRequired,
            maxConcurrent:
                stepIds.length > 1 ? Math.min(stepIds.length, concurrencyLimit) : undefined,
        };
    }

    /**
     * Build the executor map for all steps.
     * Uses the pipeline's isValidStepId to determine builtin vs plugin steps.
     */
    private buildExecutorMap(
        steps: PipelineStepDefinition[],
        pipeline: IPipelinePlugin,
        replacements: Map<string, { step: PipelineStepDefinition; pluginId: string }>,
        injections: InjectedStep[],
        prependSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
        appendSteps: Array<{ step: PipelineStepDefinition; pluginId: string }>,
    ): Map<string, StepExecutor> {
        const executorMap = new Map<string, StepExecutor>();

        const pluginSteps = new Map<string, { pluginId: string; originalStepId: string }>();

        for (const [originalId, { step, pluginId }] of replacements) {
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
                executorMap.set(step.id, {
                    type: 'plugin',
                    pluginId: pluginInfo.pluginId,
                    stepId: pluginInfo.originalStepId,
                });
            } else if (pipeline.isValidStepId?.(step.id) ?? true) {
                executorMap.set(step.id, {
                    type: 'builtin',
                    serviceId: step.id,
                    pluginId: pipeline.id,
                });
            } else {
                this.logger.warn(`Unknown step "${step.id}" - no executor assigned`);
            }
        }

        return executorMap;
    }

    private calculateEstimatedDuration(steps: PipelineStepDefinition[]): number {
        return steps.reduce((total, step) => {
            return total + (step.estimatedDuration || 10) * 1000;
        }, 0);
    }

    disableStep(stepId: string, context: BuildContext): void {
        context.disabledSteps.add(stepId);
        this.logger.debug(`Step "${stepId}" marked for disabling`);
    }

    /**
     * Get the current built-in steps from a pipeline plugin (for testing/inspection)
     */
    getBuiltInSteps(pipeline: IPipelinePlugin): readonly PipelineStepDefinition[] {
        return pipeline.getStepDefinitions();
    }
}
