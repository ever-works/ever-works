import type { ManagedAgentPipelineMetrics, ManagedSessionRunResult, ManagedSessionUsageSummary } from '../types.js';

/**
 * Roll per-session token/cost figures into pipeline metrics (feat-cma-scale).
 *
 * `tokenUsage.total.totalTokens` and `totalCost` are written at the metrics
 * ROOT because that is where the platform reads them
 * (`extractPipelineUsageMetrics`); the per-session breakdown goes into
 * `custom` for logs and debugging only. Both totals are omitted when zero so
 * a run with no reported usage stays indistinguishable from today's
 * "no usage recorded" case rather than claiming a hard zero.
 */
export function buildManagedAgentMetrics(input: {
	startTime: number;
	duration: number;
	itemCount: number;
	sessions: ManagedSessionRunResult[];
}): ManagedAgentPipelineMetrics {
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;

	const sessions: ManagedSessionUsageSummary[] = input.sessions.map((result) => {
		inputTokens += result.tokens?.inputTokens ?? 0;
		outputTokens += result.tokens?.outputTokens ?? 0;
		costUsd += result.costUsd ?? 0;

		return {
			id: result.id,
			status: result.status,
			sessionId: result.sessionId,
			tokens: result.tokens,
			costUsd: result.costUsd,
			error: result.error
		};
	});

	const metrics: ManagedAgentPipelineMetrics = {
		startTime: input.startTime,
		duration: input.duration,
		itemsProcessed: input.itemCount,
		steps: {},
		custom: {
			usage: { inputTokens, outputTokens },
			sessions
		}
	};

	const totalTokens = inputTokens + outputTokens;
	if (totalTokens > 0) {
		metrics.tokenUsage = { total: { totalTokens } };
	}

	if (costUsd > 0) {
		// Session costs are derived from integer minor units, so summing them
		// re-introduces binary-float noise (1.5 + 1.5 + 1.5 = 4.5 exactly, but
		// 0.1 + 0.2 does not). Round back to a sane currency precision.
		metrics.totalCost = Math.round(costUsd * 1e6) / 1e6;
	}

	return metrics;
}
