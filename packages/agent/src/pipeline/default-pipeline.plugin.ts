import { Injectable, Logger } from '@nestjs/common';
import type {
    IPlugin,
    PluginContext,
    PluginCategory,
    PluginManifest,
    PluginHealthCheck,
    JsonSchema,
    ValidationResult,
    PluginSettings,
    MutableGenerationContext,
    PipelineStepDefinition,
    StepExecutionOptions,
    StepProgressCallback,
    IPipelineStepPlugin,
} from '@ever-works/plugin';
import { BUILT_IN_STEPS, BUILT_IN_STEP_SERVICE_MAP } from './built-in-steps';
import type { BuiltInStepId } from '@ever-works/plugin';

/**
 * Interface for built-in step executor services
 */
export interface IBuiltInStepExecutor {
    name: string;
    run(context: MutableGenerationContext): Promise<MutableGenerationContext>;
}

/**
 * Default Pipeline Plugin - System plugin that wraps built-in pipeline steps.
 *
 * This plugin is always enabled and provides the standard generation pipeline.
 * It acts as a bridge between the new plugin-based pipeline system and the
 * existing step services (like PromptComparisonService, DomainDetectionService, etc.)
 *
 * Key characteristics:
 * - System plugin (cannot be disabled by users)
 * - Lowest priority (plugins can replace or modify its steps)
 * - Wraps existing NestJS services as pipeline steps
 */
@Injectable()
export class DefaultPipelinePlugin implements IPlugin, IPipelineStepPlugin {
    private readonly logger = new Logger(DefaultPipelinePlugin.name);

    // IPlugin interface properties
    readonly id = 'default-pipeline';
    readonly name = 'Default Pipeline';
    readonly version = '1.0.0';
    readonly category: PluginCategory = 'pipeline';
    readonly capabilities: readonly string[] = ['pipeline-step'];
    readonly settingsSchema: JsonSchema = {
        type: 'object',
        properties: {},
    };

    /**
     * Marks this as a system plugin that cannot be disabled
     */
    readonly systemPlugin = true;

    /**
     * Map of step ID to the service that executes it
     */
    private stepExecutors = new Map<string, IBuiltInStepExecutor>();

    private context?: PluginContext;

    /**
     * Register a built-in step executor service
     */
    registerStepExecutor(stepId: BuiltInStepId, executor: IBuiltInStepExecutor): void {
        this.stepExecutors.set(stepId, executor);
        this.logger.debug(`Registered executor for step: ${stepId}`);
    }

    /**
     * Register multiple step executors at once
     */
    registerStepExecutors(executors: Map<BuiltInStepId, IBuiltInStepExecutor>): void {
        for (const [stepId, executor] of executors) {
            this.registerStepExecutor(stepId, executor);
        }
    }

    /**
     * Check if an executor is registered for a step
     */
    hasExecutor(stepId: string): boolean {
        return this.stepExecutors.has(stepId);
    }

    /**
     * Get the service name for a built-in step
     */
    getServiceName(stepId: BuiltInStepId): string | undefined {
        return BUILT_IN_STEP_SERVICE_MAP[stepId];
    }

    // ============================================================================
    // IPipelineStepPlugin interface
    // ============================================================================

    /**
     * Get step definitions for all built-in steps
     */
    getStepDefinition(): PipelineStepDefinition {
        // This returns the first step - in practice, getStepDefinitions is used
        return BUILT_IN_STEPS[0];
    }

    /**
     * Get all step definitions provided by this plugin
     */
    getStepDefinitions(): PipelineStepDefinition[] {
        return [...BUILT_IN_STEPS];
    }

    /**
     * Execute a pipeline step
     */
    async execute(
        context: MutableGenerationContext,
        options?: StepExecutionOptions,
        onProgress?: StepProgressCallback,
    ): Promise<MutableGenerationContext> {
        // This method is called when the pipeline executes a specific step
        // The stepId should be passed through options.settings.stepId
        const stepId = options?.settings?.stepId as string;

        if (!stepId) {
            throw new Error('DefaultPipelinePlugin.execute() requires stepId in options.settings');
        }

        return this.executeStep(stepId, context, options, onProgress);
    }

    /**
     * Execute a specific step by ID
     */
    async executeStep(
        stepId: string,
        context: MutableGenerationContext,
        options?: StepExecutionOptions,
        onProgress?: StepProgressCallback,
    ): Promise<MutableGenerationContext> {
        const executor = this.stepExecutors.get(stepId);

        if (!executor) {
            const serviceName = BUILT_IN_STEP_SERVICE_MAP[stepId as BuiltInStepId];
            throw new Error(
                `No executor registered for step "${stepId}". ` +
                    `Expected service: ${serviceName || 'unknown'}`,
            );
        }

        // Report progress start
        if (onProgress) {
            onProgress({
                percent: 0,
                message: `Starting ${executor.name}`,
            });
        }

        // Check for cancellation
        if (options?.signal?.aborted) {
            throw new Error(`Step "${stepId}" was cancelled before execution`);
        }

        try {
            const result = await executor.run(context);

            // Report progress complete
            if (onProgress) {
                onProgress({
                    percent: 100,
                    message: `Completed ${executor.name}`,
                });
            }

            return result;
        } catch (error) {
            this.logger.error(`Step "${stepId}" failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Check if a step can be skipped (built-in steps use shouldStop flag)
     */
    async canSkip(context: MutableGenerationContext): Promise<boolean> {
        return context.shouldStop === true;
    }

    /**
     * Validate that a step can run
     */
    async validate(context: MutableGenerationContext): Promise<{ valid: boolean; error?: string }> {
        if (context.shouldStop) {
            return { valid: false, error: 'Pipeline stopped' };
        }
        return { valid: true };
    }

    // ============================================================================
    // IPlugin lifecycle interface
    // ============================================================================

    async onLoad(context: PluginContext): Promise<void> {
        this.context = context;
        this.logger.log('Default Pipeline Plugin loaded');
    }

    async onEnable(_context: PluginContext): Promise<void> {
        this.logger.log('Default Pipeline Plugin enabled');
    }

    async onDisable(_context: PluginContext): Promise<void> {
        // System plugins should not be disabled, but handle gracefully
        this.logger.warn('Attempted to disable system plugin - this should not happen');
    }

    async onUnload(): Promise<void> {
        this.stepExecutors.clear();
        this.context = undefined;
        this.logger.log('Default Pipeline Plugin unloaded');
    }

    async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
        return { valid: true };
    }

    async healthCheck(): Promise<PluginHealthCheck> {
        const registeredSteps = this.stepExecutors.size;
        const totalSteps = BUILT_IN_STEPS.length;
        const allRegistered = registeredSteps === totalSteps;

        const missingSteps = BUILT_IN_STEPS.filter((s) => !this.stepExecutors.has(s.id)).map(
            (s) => s.id,
        );

        return {
            status: allRegistered ? 'healthy' : 'degraded',
            message: allRegistered
                ? `All ${totalSteps} built-in steps registered`
                : `Only ${registeredSteps}/${totalSteps} steps registered`,
            checkedAt: Date.now(),
            checks: missingSteps.map((stepId) => ({
                name: `step-${stepId}`,
                status: 'unhealthy' as const,
                message: `Missing executor for step: ${stepId}`,
                data: { stepId },
            })),
        };
    }

    getManifest(): PluginManifest {
        return {
            id: this.id,
            name: this.name,
            version: this.version,
            description: 'System plugin providing the default generation pipeline',
            category: this.category,
            capabilities: [...this.capabilities],
            author: { name: 'Ever Works Team' },
            license: 'MIT',
            builtIn: true,
        };
    }
}
