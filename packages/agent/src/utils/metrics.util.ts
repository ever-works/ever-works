import type { AiFacadeTokenUsage as TokenUsage } from '@ever-works/plugin';
import type { PipelineMetrics, StepMetrics } from '@ever-works/plugin';

export type MetricsAccumulator = {
    total_tokens_used?: number;
    total_cost?: number;
};

type PipelineMetricsWithTokenUsage = PipelineMetrics & {
    tokenUsage?: {
        total?: {
            totalTokens?: number;
        };
    };
    totalCost?: number;
};

/**
 * Accumulates token usage and cost metrics from AI service calls.
 * This is a shared utility to avoid code duplication across pipeline steps.
 *
 * @param metrics The metrics object to update (mutates in place)
 * @param usage Token usage from the AI call
 * @param cost Estimated cost from the AI call
 */
export function accumulateMetrics(
    metrics: MetricsAccumulator | undefined,
    usage: TokenUsage | null | undefined,
    cost: number | null | undefined,
): void {
    if (!metrics) return;

    if (usage?.totalTokens) {
        metrics.total_tokens_used = (metrics.total_tokens_used || 0) + usage.totalTokens;
    }

    if (cost) {
        metrics.total_cost = (metrics.total_cost || 0) + cost;
    }
}

function readStepMetricNumber(
    step: StepMetrics | undefined,
    key: 'totalTokens' | 'totalCost',
): number {
    const value = step?.custom?.[key];
    return typeof value === 'number' ? value : 0;
}

export function extractPipelineUsageMetrics(
    metrics: PipelineMetrics | null | undefined,
): MetricsAccumulator {
    if (!metrics) {
        return {};
    }

    const extendedMetrics = metrics as PipelineMetricsWithTokenUsage;
    const explicitTotalTokens = extendedMetrics.tokenUsage?.total?.totalTokens;
    const explicitTotalCost = extendedMetrics.totalCost;
    const stepMetrics = Object.values(metrics.steps ?? {});

    const totalTokensFromSteps = stepMetrics.reduce(
        (sum, step) => sum + readStepMetricNumber(step, 'totalTokens'),
        0,
    );
    const totalCost = stepMetrics.reduce(
        (sum, step) => sum + readStepMetricNumber(step, 'totalCost'),
        0,
    );

    const total_tokens_used =
        typeof explicitTotalTokens === 'number' ? explicitTotalTokens : totalTokensFromSteps;
    const resolvedTotalCost =
        typeof explicitTotalCost === 'number' && explicitTotalCost > 0
            ? explicitTotalCost
            : totalCost;

    return {
        ...(total_tokens_used > 0 ? { total_tokens_used } : {}),
        ...(resolvedTotalCost > 0 ? { total_cost: resolvedTotalCost } : {}),
    };
}
