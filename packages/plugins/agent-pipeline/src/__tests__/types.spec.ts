import { describe, it, expect } from 'vitest';
import {
	AGENT_PIPELINE_STEP_IDS,
	isAgentPipelineStepId,
	DEFAULT_MAX_STEPS,
	getWorkerContentBudgetRatio,
	MAX_URLS_PER_BATCH
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
		it('should have reasonable default max steps', () => {
			expect(DEFAULT_MAX_STEPS).toBe(500);
		});

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
	});
});
