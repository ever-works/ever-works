import { AiProviderType } from '../ai-provider.interface';

export enum TaskComplexity {
    SIMPLE = 'simple',
    MEDIUM = 'medium',
    COMPLEX = 'complex',
}

export enum ModelTier {
    ECONOMY = 'economy',
    STANDARD = 'standard',
    PREMIUM = 'premium',
}

export interface ModelConfig {
    provider: AiProviderType;
    model: string;
    maxTokens?: number;
    temperature?: number;
}

export interface RoutingDecision {
    selectedConfig: ModelConfig;
    originalComplexity: TaskComplexity;
    escalatedFrom?: TaskComplexity;
    reason: string;
    timestamp: Date;
}

export interface RoutingOptions {
    complexity?: TaskComplexity;
    forceTier?: ModelTier;
    taskId?: string;
    autoEscalate?: boolean;
}

export interface ModelRouterConfig {
    enabled: boolean;
    complexityToTier: Record<TaskComplexity, ModelTier>;
    tierConfigs: Record<ModelTier, ModelConfig[]>;
    autoEscalationEnabled: boolean;
    logRoutingDecisions: boolean;
}

export interface CostEstimate {
    estimatedCostUsd: number;
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
}
