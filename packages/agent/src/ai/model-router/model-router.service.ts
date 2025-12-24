import { Injectable, Logger } from '@nestjs/common';
import { AiProviderType } from '../ai-provider.interface';
import {
    TaskComplexity,
    ModelTier,
    ModelConfig,
    RoutingDecision,
    RoutingOptions,
    ModelRouterConfig,
    CostEstimate,
} from './model-router.interface';
import { loadModelRouterConfig, TIER_ESCALATION_ORDER } from './model-router.config';
import { getModelPricing, calculateRequestCost, ModelPricing } from './model-pricing.config';

@Injectable()
export class ModelRouterService {
    private readonly logger = new Logger(ModelRouterService.name);
    private readonly config: ModelRouterConfig;
    private availableProviders: Set<AiProviderType> = new Set();

    constructor() {
        this.config = loadModelRouterConfig();
        this.logConfiguration();
    }

    private logConfiguration(): void {
        if (!this.config.enabled) {
            this.logger.log('Model routing disabled');
            return;
        }

        const tierCount = Object.keys(this.config.tierConfigs).length;
        this.logger.log(`Model routing enabled with ${tierCount} tiers:`);

        Object.entries(this.config.tierConfigs).forEach(([tier, configs]) => {
            this.logger.log(
                `  Tier ${tier}: ${configs.map((c) => `${c.provider}/${c.model}`).join(', ')}`,
            );
        });
    }

    setAvailableProviders(providers: AiProviderType[]): void {
        this.availableProviders = new Set(providers);
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }

    route(
        options: RoutingOptions,
        defaultProvider: AiProviderType,
        defaultModel: string,
    ): RoutingDecision {
        const complexity = options.complexity;
        const forceTier = options.forceTier;

        // If routing is disabled OR no complexity specified, use default provider
        if (!this.config.enabled || (!complexity && !forceTier)) {
            return this.createDecision(
                { provider: defaultProvider, model: defaultModel },
                complexity ?? TaskComplexity.COMPLEX,
                !this.config.enabled ? 'Routing disabled' : 'No complexity specified',
            );
        }

        const targetTier = forceTier ?? this.config.complexityToTier[complexity];
        const selectedConfig = this.findAvailableModel(targetTier, defaultProvider, defaultModel);

        const decision = this.createDecision(
            selectedConfig,
            complexity,
            `Routed ${complexity} to ${selectedConfig.provider}/${selectedConfig.model}`,
        );

        if (this.config.logRoutingDecisions) {
            this.logger.debug(
                `[ROUTING] Task: ${options.taskId ?? 'unknown'} | Complexity: ${complexity} | ` +
                    `Tier: ${targetTier} | Selected: ${selectedConfig.provider}/${selectedConfig.model}`,
            );
        }

        return decision;
    }

    escalate(
        previousDecision: RoutingDecision,
        defaultProvider: AiProviderType,
        defaultModel: string,
    ): RoutingDecision | null {
        if (!this.config.autoEscalationEnabled) {
            return null;
        }

        const currentTier = this.config.complexityToTier[previousDecision.originalComplexity];
        const nextTier = this.getNextTier(currentTier);

        if (!nextTier) {
            return null;
        }

        const selectedConfig = this.findAvailableModel(nextTier, defaultProvider, defaultModel);

        // Skip escalation if the model is the same (no point retrying with identical config)
        const prevConfig = previousDecision.selectedConfig;
        if (
            selectedConfig.provider === prevConfig.provider &&
            selectedConfig.model === prevConfig.model
        ) {
            return null;
        }

        const decision = this.createDecision(
            selectedConfig,
            previousDecision.originalComplexity,
            `Escalated from ${currentTier} to ${nextTier}`,
        );
        decision.escalatedFrom = previousDecision.originalComplexity;

        return decision;
    }

    getPricing(provider: string, model: string): ModelPricing | null {
        return getModelPricing(provider, model);
    }

    estimateCost(
        provider: string,
        model: string,
        inputTokens: number,
        outputTokens: number,
    ): CostEstimate {
        const cost = calculateRequestCost(provider, model, inputTokens, outputTokens);
        return {
            estimatedCostUsd: cost,
            provider,
            model,
            inputTokens,
            outputTokens,
        };
    }

    private findAvailableModel(
        tier: ModelTier,
        defaultProvider: AiProviderType,
        defaultModel: string,
    ): ModelConfig {
        const tierConfigs = this.config.tierConfigs[tier];

        if (this.availableProviders.size === 0) {
            return tierConfigs[0] || { provider: defaultProvider, model: defaultModel };
        }

        for (const config of tierConfigs) {
            if (this.availableProviders.has(config.provider)) {
                return config;
            }
        }

        return { provider: defaultProvider, model: defaultModel };
    }

    private getNextTier(currentTier: ModelTier): ModelTier | null {
        const currentIndex = TIER_ESCALATION_ORDER.indexOf(currentTier);
        if (currentIndex >= 0 && currentIndex < TIER_ESCALATION_ORDER.length - 1) {
            return TIER_ESCALATION_ORDER[currentIndex + 1];
        }
        return null;
    }

    private createDecision(
        config: ModelConfig,
        complexity: TaskComplexity,
        reason: string,
    ): RoutingDecision {
        return {
            selectedConfig: config,
            originalComplexity: complexity,
            reason,
            timestamp: new Date(),
        };
    }
}
