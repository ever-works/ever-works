import { Injectable, Logger } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiProviderType } from './ai-provider.interface';
import { HumanMessage } from '@langchain/core/messages';

/**
 * Example service demonstrating how to use the multi-provider AI service
 */
@Injectable()
export class AiUsageExamplesService {
    private readonly logger = new Logger(AiUsageExamplesService.name);

    constructor(private readonly aiService: AiService) {}

    /**
     * Example: Use default provider
     */
    async useDefaultProvider(prompt: string): Promise<string> {
        if (!this.aiService.isAiConfigured()) {
            throw new Error('AI service not configured');
        }

        const llm = this.aiService.getLlm();
        const response = await llm.invoke([new HumanMessage(prompt)]);
        return response.content as string;
    }

    /**
     * Example: Use specific provider
     */
    async useSpecificProvider(prompt: string, provider: AiProviderType): Promise<string> {
        if (!this.aiService.isProviderAvailable(provider)) {
            throw new Error(`Provider ${provider} is not available`);
        }

        const llm = this.aiService.getLlmByProvider(provider);
        const response = await llm.invoke([new HumanMessage(prompt)]);
        return response.content as string;
    }

    /**
     * Example: Use cost-effective provider for bulk operations
     */
    async useCostEffectiveProvider(prompts: string[]): Promise<string[]> {
        const llm = this.aiService.createLlmWithCriteria({ preferCostEffective: true });
        const results: string[] = [];

        for (const prompt of prompts) {
            const response = await llm.invoke([new HumanMessage(prompt)]);
            results.push(response.content as string);
        }

        return results;
    }

    /**
     * Example: Use fast provider for real-time operations
     */
    async useFastProvider(prompt: string): Promise<string> {
        const llm = this.aiService.createLlmWithCriteria({ preferFast: true });
        const response = await llm.invoke([new HumanMessage(prompt)]);
        return response.content as string;
    }

    /**
     * Example: Use high-context provider for large documents
     */
    async useHighContextProvider(largePrompt: string): Promise<string> {
        const llm = this.aiService.createLlmWithCriteria({ preferHighContext: true });
        const response = await llm.invoke([new HumanMessage(largePrompt)]);
        return response.content as string;
    }

    /**
     * Example: Use different temperatures for different tasks
     */
    async useVariableTemperature() {
        // Creative task - high temperature
        const creativeLlm = this.aiService.createLlmWithTemperature(0.9);
        const creativeResponse = await creativeLlm.invoke([
            new HumanMessage('Write a creative story about AI')
        ]);

        // Analytical task - low temperature
        const analyticalLlm = this.aiService.createLlmWithTemperature(0.1);
        const analyticalResponse = await analyticalLlm.invoke([
            new HumanMessage('Analyze the pros and cons of renewable energy')
        ]);

        return {
            creative: creativeResponse.content as string,
            analytical: analyticalResponse.content as string,
        };
    }

    /**
     * Example: Provider fallback handling
     */
    async useWithFallback(prompt: string, preferredProvider: AiProviderType): Promise<{
        response: string;
        usedProvider: string;
    }> {
        try {
            // Try preferred provider first
            if (this.aiService.isProviderAvailable(preferredProvider)) {
                const llm = this.aiService.getLlmByProvider(preferredProvider);
                const response = await llm.invoke([new HumanMessage(prompt)]);
                return {
                    response: response.content as string,
                    usedProvider: preferredProvider,
                };
            }
        } catch (error) {
            this.logger.warn(`Failed to use preferred provider ${preferredProvider}: ${error.message}`);
        }

        // Fallback to default
        const llm = this.aiService.getLlm();
        const response = await llm.invoke([new HumanMessage(prompt)]);
        return {
            response: response.content as string,
            usedProvider: 'default',
        };
    }

    /**
     * Example: Get provider information
     */
    getProviderInfo() {
        const availableProviders = this.aiService.getAvailableProviders();
        const config = this.aiService.getServiceConfig();
        
        const providerInfo = availableProviders.map(provider => ({
            type: provider,
            config: this.aiService.getProviderConfig(provider),
            capabilities: this.aiService.getProviderCapabilities(provider),
            isAvailable: this.aiService.isProviderAvailable(provider),
        }));

        return {
            defaultProvider: config.defaultProvider,
            fallbackProviders: config.fallbackProviders,
            providers: providerInfo,
            recommendations: {
                costEffective: this.aiService.getCostEffectiveProvider(),
                fastest: this.aiService.getFastestProvider(),
                mostCapable: this.aiService.getMostCapableProvider(),
            },
        };
    }

    /**
     * Example: Batch processing with different providers
     */
    async batchProcessWithOptimalProviders(tasks: Array<{
        prompt: string;
        type: 'creative' | 'analytical' | 'fast' | 'cost-effective';
    }>) {
        const results = [];

        for (const task of tasks) {
            let llm;
            
            switch (task.type) {
                case 'creative':
                    llm = this.aiService.createLlmWithCriteria({ 
                        temperature: 0.9,
                        preferHighContext: true 
                    });
                    break;
                case 'analytical':
                    llm = this.aiService.createLlmWithCriteria({ 
                        temperature: 0.1,
                        preferHighContext: true 
                    });
                    break;
                case 'fast':
                    llm = this.aiService.createLlmWithCriteria({ 
                        preferFast: true 
                    });
                    break;
                case 'cost-effective':
                    llm = this.aiService.createLlmWithCriteria({ 
                        preferCostEffective: true 
                    });
                    break;
                default:
                    llm = this.aiService.getLlm();
            }

            const response = await llm.invoke([new HumanMessage(task.prompt)]);
            results.push({
                task: task.type,
                prompt: task.prompt,
                response: response.content as string,
            });
        }

        return results;
    }

    /**
     * Log current AI service status
     */
    logServiceStatus() {
        this.aiService.logProviderStats();
    }
}
