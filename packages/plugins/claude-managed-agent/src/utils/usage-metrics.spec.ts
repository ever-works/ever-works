import { describe, expect, it } from 'vitest';

import type { ManagedSessionRunResult, ManagedSessionTokenUsage } from '../types.js';
import { buildManagedAgentMetrics, toManagedSessionTokenUsage } from './usage-metrics.js';

function tokens(overrides: Partial<ManagedSessionTokenUsage> = {}): ManagedSessionTokenUsage {
	const base = {
		inputTokens: 100,
		outputTokens: 50,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		...overrides
	};

	return {
		...base,
		totalTokens:
			overrides.totalTokens ??
			base.inputTokens + base.outputTokens + base.cacheCreationInputTokens + base.cacheReadInputTokens
	};
}

function session(overrides: Partial<ManagedSessionRunResult> = {}): ManagedSessionRunResult {
	return {
		id: 'variant-1',
		status: 'completed',
		sessionId: 'session_1',
		tokens: tokens(),
		costUsd: 1.25,
		...overrides
	};
}

describe('buildManagedAgentMetrics', () => {
	it('writes the token/cost totals at the metrics root, not inside custom', () => {
		const metrics = buildManagedAgentMetrics({
			startTime: 1000,
			duration: 500,
			itemCount: 7,
			sessions: [session()]
		});

		expect(metrics.tokenUsage).toEqual({ total: { totalTokens: 150 } });
		expect(metrics.totalCost).toBe(1.25);
		// The platform seam never reads `custom` — anything there is debug-only.
		expect(metrics.custom).not.toHaveProperty('tokenUsage');
		expect(metrics.custom).not.toHaveProperty('totalCost');
		expect(metrics.startTime).toBe(1000);
		expect(metrics.duration).toBe(500);
		expect(metrics.itemsProcessed).toBe(7);
		expect(metrics.steps).toEqual({});
	});

	it('sums tokens and cost across sessions and keeps a per-session breakdown', () => {
		const metrics = buildManagedAgentMetrics({
			startTime: 0,
			duration: 1,
			itemCount: 3,
			sessions: [
				session({ id: 'variant-1', sessionId: 's1' }),
				session({ id: 'variant-2', sessionId: 's2', costUsd: 0.75 }),
				session({
					id: 'variant-3',
					sessionId: 's3',
					tokens: tokens({ inputTokens: 10, outputTokens: 5 }),
					costUsd: 0.5
				})
			]
		});

		expect(metrics.tokenUsage?.total.totalTokens).toBe(150 + 150 + 15);
		expect(metrics.totalCost).toBe(2.5);
		expect(metrics.custom?.usage).toEqual({
			inputTokens: 210,
			outputTokens: 105,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0
		});
		expect(metrics.custom?.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
	});

	it('keeps failed sessions in the breakdown without contributing usage', () => {
		const metrics = buildManagedAgentMetrics({
			startTime: 0,
			duration: 1,
			itemCount: 1,
			sessions: [
				session(),
				{ id: 'variant-2', status: 'failed', sessionId: 's2', error: 'budget exhausted' },
				{ id: 'variant-3', status: 'cancelled' }
			]
		});

		expect(metrics.tokenUsage?.total.totalTokens).toBe(150);
		expect(metrics.totalCost).toBe(1.25);
		expect(metrics.custom?.sessions).toHaveLength(3);
		expect(metrics.custom?.sessions[1]).toEqual({
			id: 'variant-2',
			status: 'failed',
			sessionId: 's2',
			tokens: undefined,
			costUsd: undefined,
			error: 'budget exhausted'
		});
	});

	it('omits both totals when no session reported usage', () => {
		const metrics = buildManagedAgentMetrics({
			startTime: 0,
			duration: 1,
			itemCount: 0,
			sessions: [{ id: 'variant-1', status: 'failed', error: 'boom' }]
		});

		expect(metrics.tokenUsage).toBeUndefined();
		expect(metrics.totalCost).toBeUndefined();
	});

	it('rounds away float noise from summed per-session costs', () => {
		const metrics = buildManagedAgentMetrics({
			startTime: 0,
			duration: 1,
			itemCount: 0,
			sessions: [
				session({ id: 'a', costUsd: 0.1, tokens: undefined }),
				session({ id: 'b', costUsd: 0.2, tokens: undefined })
			]
		});

		expect(metrics.totalCost).toBe(0.3);
	});

	// Regression: cached input tokens are billed but are reported by the
	// sessions API OUTSIDE `input_tokens`. Dropping them made
	// `tokenUsage.total.totalTokens` — the only token field the platform's
	// extractPipelineUsageMetrics reads — under-report cache-heavy managed
	// agent runs by orders of magnitude.
	it('counts cached input tokens in the root total and the custom breakdown', () => {
		const metrics = buildManagedAgentMetrics({
			startTime: 0,
			duration: 1,
			itemCount: 1,
			sessions: [
				session({
					tokens: tokens({
						inputTokens: 1200,
						outputTokens: 800,
						cacheCreationInputTokens: 24000,
						cacheReadInputTokens: 640000
					})
				})
			]
		});

		expect(metrics.tokenUsage).toEqual({ total: { totalTokens: 666000 } });
		expect(metrics.custom?.usage).toEqual({
			inputTokens: 1200,
			outputTokens: 800,
			cacheCreationInputTokens: 24000,
			cacheReadInputTokens: 640000
		});
	});
});

describe('toManagedSessionTokenUsage', () => {
	it('returns undefined when the session reported no usage', () => {
		expect(toManagedSessionTokenUsage(undefined)).toBeUndefined();
	});

	it('sums every billed token class into totalTokens', () => {
		expect(
			toManagedSessionTokenUsage({
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: 700,
				cache_read_input_tokens: 9000
			})
		).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationInputTokens: 700,
			cacheReadInputTokens: 9000,
			totalTokens: 9850
		});
	});

	it('treats missing and non-numeric counters as zero', () => {
		expect(toManagedSessionTokenUsage({ input_tokens: 10 })).toEqual({
			inputTokens: 10,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
			totalTokens: 10
		});
		expect(toManagedSessionTokenUsage({ input_tokens: Number.NaN, cache_read_input_tokens: 5 })).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 5,
			totalTokens: 5
		});
	});
});
