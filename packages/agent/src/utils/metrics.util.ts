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
 *
 * **Mutation semantics.** Despite the "utility" name this function
 * MUTATES `metrics` rather than returning a new value — pipeline
 * step callers thread the same accumulator through multiple AI
 * calls and read it at step end. `undefined` metrics is a no-op
 * (allows callers to skip the null-check).
 *
 * **Falsy guards.** `usage.totalTokens === 0` or `cost === 0` are
 * skipped because `if (usage?.totalTokens)` and `if (cost)` both
 * fail on 0. Acceptable — a zero-token / zero-cost call is just
 * noise — but it means the accumulator counts NaN as zero
 * silently (NaN is falsy).
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

/**
 * Pull the rolled-up token / cost totals out of a pipeline-level
 * `PipelineMetrics`, falling back to per-step sums if the pipeline
 * didn't report explicit totals.
 *
 * **Asymmetric precedence between tokens and cost** worth knowing:
 *
 *   - **Tokens:** if `tokenUsage.total.totalTokens` is *any* number
 *     (including 0), it wins over the step-sum. A pipeline that
 *     reports `totalTokens: 0` therefore reports 0, not the sum.
 *   - **Cost:** explicit `totalCost` only wins when it's **> 0**.
 *     A pipeline reporting `totalCost: 0` falls through to the
 *     step-sum. Deliberate — cost can be unknown (omitted as 0)
 *     while step-level cost estimates are still meaningful, but
 *     tokens are always knowable.
 *
 * **Plugins must surface step-level numbers in `step.custom`** under
 * the keys `totalTokens` / `totalCost` for the fallback sum to find
 * them. Plugins that put them anywhere else silently contribute 0.
 *
 * **Return omits zero keys.** `{ total_tokens_used: 0 }` becomes
 * `{}` — callers can't distinguish "no usage recorded" from
 * "literally zero tokens". For most downstream uses (cost reports,
 * dashboards) that's the right call, but it matters for assertions
 * in tests.
 */
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
