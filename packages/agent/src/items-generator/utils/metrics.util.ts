import { TokenUsage } from '../../ai';

export type MetricsAccumulator = {
    total_tokens_used?: number;
    total_cost?: number;
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
