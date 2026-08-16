import type {
	ManagedAgentPipelineMetrics,
	ManagedAgentsUsage,
	ManagedSessionRunResult,
	ManagedSessionTokenUsage,
	ManagedSessionUsageSummary
} from '../types.js';

function readCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Map a sessions-API `usage` object onto the plugin's token-usage shape.
 *
 * Single seam for BOTH session paths (fan-out and the single-session
 * pipeline run) so they can never disagree about what `totalTokens` counts.
 *
 * `cache_creation_input_tokens` / `cache_read_input_tokens` are billed input
 * tokens that Anthropic reports OUTSIDE `input_tokens`. Leaving them out of
 * `totalTokens` under-reports cache-heavy managed-agent runs by orders of
 * magnitude in `tokenUsage.total.totalTokens` — the one field the platform's
 * `extractPipelineUsageMetrics` actually reads.
 */
export function toManagedSessionTokenUsage(
	usage: ManagedAgentsUsage | undefined
): ManagedSessionTokenUsage | undefined {
	if (!usage) {
		return undefined;
	}

	const inputTokens = readCount(usage.input_tokens);
	const outputTokens = readCount(usage.output_tokens);
	const cacheCreationInputTokens = readCount(usage.cache_creation_input_tokens);
	const cacheReadInputTokens = readCount(usage.cache_read_input_tokens);

	return {
		inputTokens,
		outputTokens,
		cacheCreationInputTokens,
		cacheReadInputTokens,
		totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
	};
}

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
	let cacheCreationInputTokens = 0;
	let cacheReadInputTokens = 0;
	let costUsd = 0;

	const sessions: ManagedSessionUsageSummary[] = input.sessions.map((result) => {
		inputTokens += result.tokens?.inputTokens ?? 0;
		outputTokens += result.tokens?.outputTokens ?? 0;
		cacheCreationInputTokens += result.tokens?.cacheCreationInputTokens ?? 0;
		cacheReadInputTokens += result.tokens?.cacheReadInputTokens ?? 0;
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
			usage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
			sessions
		}
	};

	const totalTokens = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
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
