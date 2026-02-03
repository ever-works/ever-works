import { Injectable, Logger } from '@nestjs/common';
import type {
    MutableGenerationContext,
    StepExecutionOptions,
    StepProgressCallback,
    StepExecutionContext,
    IBuiltInStepExecutor,
} from '@ever-works/plugin';
import type { BuiltInStepId } from '@ever-works/default-pipeline-plugin';
import { TypedGenerationContext } from './generation-context';

export interface ILegacyPipelineStep {
    name: string;
    run(context: MutableGenerationContext): Promise<MutableGenerationContext>;
}

/**
 * Adapts legacy step services to the plugin-based pipeline system.
 */
@Injectable()
export class StepAdapterService {
    private readonly logger = new Logger(StepAdapterService.name);
    private readonly serviceMap = new Map<BuiltInStepId, ILegacyPipelineStep>();

    registerService(stepId: BuiltInStepId, service: ILegacyPipelineStep): void {
        if (this.serviceMap.has(stepId)) {
            this.logger.warn(`Overwriting existing service for step: ${stepId}`);
        }
        this.serviceMap.set(stepId, service);
        this.logger.debug(`Registered service "${service.name}" for step: ${stepId}`);
    }

    registerServices(services: Map<BuiltInStepId, ILegacyPipelineStep>): void {
        for (const [stepId, service] of services) {
            this.registerService(stepId, service);
        }
    }

    hasService(stepId: string): boolean {
        return this.serviceMap.has(stepId as BuiltInStepId);
    }

    getService(stepId: BuiltInStepId): ILegacyPipelineStep | undefined {
        return this.serviceMap.get(stepId);
    }

    getRegisteredStepIds(): BuiltInStepId[] {
        return Array.from(this.serviceMap.keys());
    }

    async executeStep(
        stepId: BuiltInStepId,
        context: TypedGenerationContext,
        options?: StepExecutionOptions,
        onProgress?: StepProgressCallback,
    ): Promise<TypedGenerationContext> {
        const service = this.serviceMap.get(stepId);

        if (!service) {
            const registeredSteps = this.getRegisteredStepIds();
            throw new Error(
                `No executor registered for step "${stepId}". ` +
                    `Registered steps: ${registeredSteps.length > 0 ? registeredSteps.join(', ') : 'none'}`,
            );
        }

        if (options?.signal?.aborted) {
            throw new Error(`Step "${stepId}" was cancelled before execution`);
        }

        if (onProgress) {
            onProgress({
                percent: 0,
                message: `Starting ${service.name}`,
            });
        }

        this.logger.debug(`Executing step "${stepId}" via service "${service.name}"`);

        try {
            const result = await service.run(context);

            if (result instanceof TypedGenerationContext) {
                if (onProgress) {
                    onProgress({
                        percent: 100,
                        message: `Completed ${service.name}`,
                    });
                }
                return result;
            }

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

    createExecutorWrapper(stepId: BuiltInStepId): IBuiltInStepExecutor | undefined {
        const service = this.serviceMap.get(stepId);
        if (!service) {
            return undefined;
        }

        return {
            name: service.name,
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            run: (context: MutableGenerationContext, _execContext: StepExecutionContext) =>
                service.run(context),
        };
    }

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

    clear(): void {
        this.serviceMap.clear();
        this.logger.debug('Cleared all registered step services');
    }

    count(): number {
        return this.serviceMap.size;
    }
}
