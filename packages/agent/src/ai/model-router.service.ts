import { Injectable, Logger } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiProviderType, BaseChatModel } from './ai-provider.interface';

export enum TaskComplexity {
    SIMPLE = 'simple',
    MEDIUM = 'medium',
    COMPLEX = 'complex',
}

export type ModelRoutingConfig = {
    provider?: AiProviderType;
    temperature?: number;
};

@Injectable()
export class ModelRouterService {
    private readonly logger = new Logger(ModelRouterService.name);

    constructor(private readonly aiService: AiService) {}

    /**
     * Select an LLM instance based on task complexity with sensible defaults.
     * SIMPLE → cost effective, MEDIUM → fast, COMPLEX → high context/best model.
     * Temperature can be overridden per call.
     */
    getModel(complexity: TaskComplexity, config?: ModelRoutingConfig): BaseChatModel {
        const temperature = config?.temperature;

        switch (complexity) {
            case TaskComplexity.SIMPLE:
                return this.aiService.createLlmWithCriteria({
                    preferCostEffective: true,
                    temperature,
                    providerType: config?.provider,
                });
            case TaskComplexity.MEDIUM:
                return this.aiService.createLlmWithCriteria({
                    preferFast: true,
                    temperature,
                    providerType: config?.provider,
                });
            case TaskComplexity.COMPLEX:
            default:
                return this.aiService.createLlmWithCriteria({
                    preferHighContext: true,
                    temperature,
                    providerType: config?.provider,
                });
        }
    }

    /**
     * Quality safeguard: on a failed validation, re-run with COMPLEX model if not already used.
     */
    async ensureQuality<T>(
        complexity: TaskComplexity,
        run: (llm: BaseChatModel) => Promise<T>,
        validate: (result: T) => boolean,
    ): Promise<T> {
        const initialModel = this.getModel(complexity);
        const result = await run(initialModel);

        if (validate(result) || complexity === TaskComplexity.COMPLEX) {
            return result;
        }

        this.logger.warn('Escalating to COMPLEX model after validation failure.');
        const complexModel = this.getModel(TaskComplexity.COMPLEX);
        return run(complexModel);
    }
}
