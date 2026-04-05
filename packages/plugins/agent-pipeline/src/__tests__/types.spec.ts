import { describe, it, expect } from 'vitest';
import {
	AGENT_PIPELINE_STEP_IDS,
	isAgentPipelineStepId,
	DEFAULT_MAX_STEPS,
	getWorkerContentBudgetRatio,
	MAX_URLS_PER_BATCH,
	MAX_CHUNK_CHARS,
	getStepsPerChunk,
	getWorkerTimeoutMs,
	BASE_STEPS_PER_CHUNK,
	MAX_STEPS_PER_CHUNK,
	STEPS_PER_ESTIMATED_ITEM,
	MODIFICATION_WORKER_MAX_STEPS,
	TokenUsageAccumulator
} from '../types';

describe('types', () => {
	describe('AGENT_PIPELINE_STEP_IDS', () => {
		it('should have 5 steps', () => {
			expect(AGENT_PIPELINE_STEP_IDS).toHaveLength(5);
		});

		it('should contain all expected step IDs', () => {
			expect(AGENT_PIPELINE_STEP_IDS).toEqual([
				'prepare-context',
				'generate-items',
				'collect-results',
				'capture-screenshots',
				'cleanup'
			]);
		});
	});

	describe('isAgentPipelineStepId', () => {
		it('should return true for valid step IDs', () => {
			expect(isAgentPipelineStepId('prepare-context')).toBe(true);
			expect(isAgentPipelineStepId('generate-items')).toBe(true);
			expect(isAgentPipelineStepId('collect-results')).toBe(true);
			expect(isAgentPipelineStepId('capture-screenshots')).toBe(true);
			expect(isAgentPipelineStepId('cleanup')).toBe(true);
		});

		it('should return false for invalid step IDs', () => {
			expect(isAgentPipelineStepId('invalid')).toBe(false);
			expect(isAgentPipelineStepId('')).toBe(false);
			expect(isAgentPipelineStepId('setup-claude-code')).toBe(false);
		});
	});

	describe('constants', () => {
		it('should return adaptive content budget ratio based on model context size', () => {
			expect(getWorkerContentBudgetRatio(8_000)).toBe(0.35);
			expect(getWorkerContentBudgetRatio(16_000)).toBe(0.35);
			expect(getWorkerContentBudgetRatio(32_000)).toBe(0.4);
			expect(getWorkerContentBudgetRatio(64_000)).toBe(0.5);
			expect(getWorkerContentBudgetRatio(128_000)).toBe(0.55);
			expect(getWorkerContentBudgetRatio(200_000)).toBe(0.55);
		});

		it('should have max URLs per batch', () => {
			expect(MAX_URLS_PER_BATCH).toBe(10);
		});

		it('should have a practical max chunk chars cap', () => {
			expect(MAX_CHUNK_CHARS).toBe(30_000);
		});

		it('should keep the default and modification worker step budgets intentionally bounded', () => {
			expect(DEFAULT_MAX_STEPS).toBe(24);
			expect(MODIFICATION_WORKER_MAX_STEPS).toBe(80);
		});
	});

	describe('getStepsPerChunk', () => {
		it('should return BASE_STEPS_PER_CHUNK for small chunks', () => {
			expect(getStepsPerChunk(1000)).toBe(BASE_STEPS_PER_CHUNK);
			expect(getStepsPerChunk(4000)).toBe(BASE_STEPS_PER_CHUNK);
		});

		it('should scale steps proportionally for medium chunks', () => {
			// 20K chars → ~100 estimated items → 100 * STEPS_PER_ESTIMATED_ITEM
			expect(getStepsPerChunk(20_000)).toBe(MAX_STEPS_PER_CHUNK);
		});

		it('should scale for large chunks within cap', () => {
			// 30K chars → ~150 estimated items → 150 * STEPS_PER_ESTIMATED_ITEM, capped
			expect(getStepsPerChunk(30_000)).toBe(MAX_STEPS_PER_CHUNK);
		});

		it('should cap at MAX_STEPS_PER_CHUNK for very large chunks', () => {
			expect(getStepsPerChunk(50_000)).toBe(MAX_STEPS_PER_CHUNK);
			expect(getStepsPerChunk(100_000)).toBe(MAX_STEPS_PER_CHUNK);
		});

		it('should expose the current scaling factor for maintainability', () => {
			expect(STEPS_PER_ESTIMATED_ITEM).toBe(2);
		});
	});

	describe('getWorkerTimeoutMs', () => {
		it('should keep worker timeouts within the bounded window', () => {
			expect(getWorkerTimeoutMs(1)).toBe(3 * 60 * 1000);
			expect(getWorkerTimeoutMs(40)).toBe(3 * 60 * 1000);
			expect(getWorkerTimeoutMs(MAX_STEPS_PER_CHUNK)).toBe(7 * 60 * 1000);
			expect(getWorkerTimeoutMs(500)).toBe(8 * 60 * 1000);
		});
	});

	describe('TokenUsageAccumulator', () => {
		it('should start with zero usage', () => {
			const acc = new TokenUsageAccumulator();
			const breakdown = acc.toBreakdown();

			expect(breakdown.parent).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
			expect(breakdown.workers).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
			expect(breakdown.total).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
		});

		it('should accumulate parent usage', () => {
			const acc = new TokenUsageAccumulator();
			acc.addParent({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
			acc.addParent({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });

			const breakdown = acc.toBreakdown();
			expect(breakdown.parent).toEqual({ inputTokens: 300, outputTokens: 150, totalTokens: 450 });
			expect(breakdown.workers).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
			expect(breakdown.total).toEqual({ inputTokens: 300, outputTokens: 150, totalTokens: 450 });
		});

		it('should accumulate worker usage', () => {
			const acc = new TokenUsageAccumulator();
			acc.addWorker({ inputTokens: 500, outputTokens: 200, totalTokens: 700 });
			acc.addWorker({ inputTokens: 300, outputTokens: 100, totalTokens: 400 });

			const breakdown = acc.toBreakdown();
			expect(breakdown.parent).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
			expect(breakdown.workers).toEqual({ inputTokens: 800, outputTokens: 300, totalTokens: 1100 });
			expect(breakdown.total).toEqual({ inputTokens: 800, outputTokens: 300, totalTokens: 1100 });
		});

		it('should combine parent and worker usage in total', () => {
			const acc = new TokenUsageAccumulator();
			acc.addParent({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
			acc.addWorker({ inputTokens: 500, outputTokens: 200, totalTokens: 700 });

			const breakdown = acc.toBreakdown();
			expect(breakdown.total).toEqual({ inputTokens: 600, outputTokens: 250, totalTokens: 850 });
		});

		it('should handle undefined fields gracefully', () => {
			const acc = new TokenUsageAccumulator();
			acc.addParent({ inputTokens: 100 });
			acc.addWorker({ outputTokens: 50 });

			const breakdown = acc.toBreakdown();
			expect(breakdown.parent).toEqual({ inputTokens: 100, outputTokens: 0, totalTokens: 0 });
			expect(breakdown.workers).toEqual({ inputTokens: 0, outputTokens: 50, totalTokens: 0 });
			expect(breakdown.total).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 0 });
		});

		it('should return immutable snapshots from toBreakdown', () => {
			const acc = new TokenUsageAccumulator();
			acc.addParent({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });

			const first = acc.toBreakdown();
			acc.addParent({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });
			const second = acc.toBreakdown();

			expect(first.parent.inputTokens).toBe(100);
			expect(second.parent.inputTokens).toBe(300);
		});
	});
});
