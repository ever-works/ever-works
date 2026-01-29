import { Injectable, Logger } from '@nestjs/common';
import type {
    MutableGenerationContext,
    BuiltInStepId,
    StepExecutionOptions,
    StepProgressCallback,
} from '@ever-works/plugin';
import type { IBuiltInStepExecutor } from './default-pipeline.plugin';
import { TypedGenerationContext } from './generation-context';
import { BUILT_IN_STEP_SERVICE_MAP } from './built-in-steps';

/**
 * Interface for services that can be registered with the adapter.
 * This matches the legacy IPipelineStep interface.
 */
export interface ILegacyPipelineStep {
    name: string;
    run(context: MutableGenerationContext): Promise<MutableGenerationContext>;
}

/**
 * Service that adapts legacy step services to the new plugin-based pipeline system.
 *
 * This adapter bridges between:
 * - Legacy step services: `{ name, run(context) }` interface
 * - New plugin system: `IPipelineStepPlugin.execute()` with typed context
 */
@Injectable()
export class StepAdapterService {
    private readonly logger = new Logger(StepAdapterService.name);

    /**
     * Map of step ID to the service that executes it
     */
    private readonly serviceMap = new Map<BuiltInStepId, ILegacyPipelineStep>();

    /**
     * Register a legacy step service
     * @param stepId - The built-in step ID
     * @param service - The service instance implementing ILegacyPipelineStep
     */
    registerService(stepId: BuiltInStepId, service: ILegacyPipelineStep): void {
        if (this.serviceMap.has(stepId)) {
            this.logger.warn(`Overwriting existing service for step: ${stepId}`);
        }
        this.serviceMap.set(stepId, service);
        this.logger.debug(`Registered service "${service.name}" for step: ${stepId}`);
    }

    /**
     * Register multiple services at once
     * @param services - Map of step ID to service
     */
    registerServices(services: Map<BuiltInStepId, ILegacyPipelineStep>): void {
        for (const [stepId, service] of services) {
            this.registerService(stepId, service);
        }
    }

    /**
     * Check if a service is registered for a step
     * @param stepId - The step ID to check
     */
    hasService(stepId: string): boolean {
        return this.serviceMap.has(stepId as BuiltInStepId);
    }

    /**
     * Get the registered service for a step
     * @param stepId - The step ID
     */
    getService(stepId: BuiltInStepId): ILegacyPipelineStep | undefined {
        return this.serviceMap.get(stepId);
    }

    /**
     * Get all registered step IDs
     */
    getRegisteredStepIds(): BuiltInStepId[] {
        return Array.from(this.serviceMap.keys());
    }

    /**
     * Get the expected service name for a step ID
     */
    getExpectedServiceName(stepId: BuiltInStepId): string | undefined {
        return BUILT_IN_STEP_SERVICE_MAP[stepId];
    }

    /**
     * Execute a step using its registered service
     *
     * @param stepId - The step ID to execute
     * @param context - The typed generation context
     * @param options - Execution options
     * @param onProgress - Progress callback
     * @returns The modified context
     */
    async executeStep(
        stepId: BuiltInStepId,
        context: TypedGenerationContext,
        options?: StepExecutionOptions,
        onProgress?: StepProgressCallback,
    ): Promise<TypedGenerationContext> {
        const service = this.serviceMap.get(stepId);

        if (!service) {
            const expectedService = BUILT_IN_STEP_SERVICE_MAP[stepId];
            throw new Error(
                `No service registered for step "${stepId}". ` +
                    `Expected service: ${expectedService || 'unknown'}. ` +
                    `Registered steps: ${this.getRegisteredStepIds().join(', ') || 'none'}`,
            );
        }

        // Check for cancellation before execution
        if (options?.signal?.aborted) {
            throw new Error(`Step "${stepId}" was cancelled before execution`);
        }

        // Report progress start
        if (onProgress) {
            onProgress({
                percent: 0,
                message: `Starting ${service.name}`,
            });
        }

        this.logger.debug(`Executing step "${stepId}" via service "${service.name}"`);

        try {
            // The legacy services work with MutableGenerationContext, which TypedGenerationContext implements
            const result = await service.run(context);

            // If the result is already a TypedGenerationContext, return it directly
            if (result instanceof TypedGenerationContext) {
                if (onProgress) {
                    onProgress({
                        percent: 100,
                        message: `Completed ${service.name}`,
                    });
                }
                return result;
            }

            // Otherwise, convert from MutableGenerationContext to TypedGenerationContext
            const typedResult = TypedGenerationContext.fromMutableContext(result);

            if (onProgress) {
                onProgress({
                    percent: 100,
                    message: `Completed ${service.name}`,
                });
            }

            return typedResult;
        } catch (error) {
            this.logger.error(`Step "${stepId}" failed: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Create an IBuiltInStepExecutor wrapper for a step
     * This allows the step to be used with the DefaultPipelinePlugin
     *
     * @param stepId - The step ID
     */
    createExecutorWrapper(stepId: BuiltInStepId): IBuiltInStepExecutor | undefined {
        const service = this.serviceMap.get(stepId);
        if (!service) {
            return undefined;
        }

        return {
            name: service.name,
            run: (context: MutableGenerationContext) => service.run(context),
        };
    }

    /**
     * Create executor wrappers for all registered services
     */
    createAllExecutorWrappers(): Map<BuiltInStepId, IBuiltInStepExecutor> {
        const wrappers = new Map<BuiltInStepId, IBuiltInStepExecutor>();

        for (const stepId of this.serviceMap.keys()) {
            const wrapper = this.createExecutorWrapper(stepId);
            if (wrapper) {
                wrappers.set(stepId, wrapper);
            }
        }

        return wrappers;
    }

    /**
     * Clear all registered services (mainly for testing)
     */
    clear(): void {
        this.serviceMap.clear();
        this.logger.debug('Cleared all registered step services');
    }

    /**
     * Get the count of registered services
     */
    count(): number {
        return this.serviceMap.size;
    }
}
