import {
    TaskComplexity,
    ModelTier,
    ModelConfig,
    ModelRouterConfig,
} from './model-router.interface';
import { config } from '@src/config';

export const DEFAULT_COMPLEXITY_TO_TIER: Record<TaskComplexity, ModelTier> = {
    [TaskComplexity.SIMPLE]: ModelTier.ECONOMY,
    [TaskComplexity.MEDIUM]: ModelTier.STANDARD,
    [TaskComplexity.COMPLEX]: ModelTier.PREMIUM,
};

export const TIER_ESCALATION_ORDER: ModelTier[] = [
    ModelTier.ECONOMY,
    ModelTier.STANDARD,
    ModelTier.PREMIUM,
];

function getDefaultProviderConfig(): ModelConfig {
    const defaultProvider = config.ai.getDefaultProvider();

    const providerConfigs: Record<string, () => string> = {
        openai: () => config.ai.openAi.getModel(),
        openrouter: () => config.ai.openRouter.getModel(),
        google: () => config.ai.google.getModel(),
        anthropic: () => config.ai.anthropic.getModel(),
        groq: () => config.ai.groq.getModel(),
        ollama: () => config.ai.ollama.getModel(),
        custom: () => config.ai.custom.getModel(),
    };

    const getModel = providerConfigs[defaultProvider];
    const model = getModel ? getModel() : 'gpt-4o';

    return { provider: defaultProvider, model };
}

export function loadModelRouterConfig(): ModelRouterConfig {
    const routingConfig = config.ai.routing;

    const enabled = routingConfig.isEnabled();
    const autoEscalation = routingConfig.isAutoEscalationEnabled();
    const logDecisions = routingConfig.isLoggingEnabled();

    const economyProvider = routingConfig.getEconomyProvider();
    const economyModel = routingConfig.getEconomyModel();

    const standardProvider = routingConfig.getStandardProvider();
    const standardModel = routingConfig.getStandardModel();

    const premiumProvider = routingConfig.getPremiumProvider();
    const premiumModel = routingConfig.getPremiumModel();

    // Fall back to default provider config if tier not configured
    const defaultConfig = getDefaultProviderConfig();

    const tierConfigs: Record<ModelTier, ModelConfig[]> = {
        [ModelTier.ECONOMY]: [
            economyProvider && economyModel
                ? { provider: economyProvider, model: economyModel }
                : defaultConfig,
        ],
        [ModelTier.STANDARD]: [
            standardProvider && standardModel
                ? { provider: standardProvider, model: standardModel }
                : defaultConfig,
        ],
        [ModelTier.PREMIUM]: [
            premiumProvider && premiumModel
                ? { provider: premiumProvider, model: premiumModel }
                : defaultConfig,
        ],
    };

    return {
        enabled,
        complexityToTier: { ...DEFAULT_COMPLEXITY_TO_TIER },
        tierConfigs,
        autoEscalationEnabled: autoEscalation,
        logRoutingDecisions: logDecisions,
    };
}
