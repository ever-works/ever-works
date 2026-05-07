import { describe, it, expect } from 'vitest';
import {
	ItemsGeneratorStep,
	getStepText,
	getStepProgress,
	getDynamicStepText,
	getDynamicStepProgress,
	getItemsProcessedText
} from '../generator-steps.js';

describe('getStepText', () => {
	it('returns a human-readable label for each enum value', () => {
		expect(getStepText(ItemsGeneratorStep.PROMPT_PROCESSING)).toBe('Processing your prompt');
		expect(getStepText(ItemsGeneratorStep.WEB_SEARCH)).toBe('Searching the web');
		expect(getStepText(ItemsGeneratorStep.MARKDOWN_GENERATION)).toBe('Generating markdown content');
	});

	it('falls back to "Processing" for unknown values', () => {
		expect(getStepText('unknown-step' as ItemsGeneratorStep)).toBe('Processing');
	});
});

describe('getStepProgress', () => {
	it('returns 0 for unknown step', () => {
		expect(getStepProgress('unknown' as ItemsGeneratorStep)).toBe(0);
	});

	it('returns a percentage in [1, 100] for known steps', () => {
		const first = getStepProgress(ItemsGeneratorStep.PROMPT_COMPARISON);
		const last = getStepProgress(ItemsGeneratorStep.MARKDOWN_GENERATION);
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThanOrEqual(100);
		expect(last).toBe(100);
		expect(last).toBeGreaterThan(first);
	});
});

describe('getDynamicStepText', () => {
	it('prefers stepName when present', () => {
		expect(getDynamicStepText({ stepName: 'Custom step' })).toBe('Custom step');
		expect(getDynamicStepText({ stepName: 'Custom step', step: ItemsGeneratorStep.WEB_SEARCH })).toBe(
			'Custom step'
		);
	});

	it('falls back to enum lookup when only step is set and known', () => {
		expect(getDynamicStepText({ step: ItemsGeneratorStep.WEB_SEARCH })).toBe('Searching the web');
	});

	it('returns the raw step value when enum lookup returns the generic fallback', () => {
		expect(getDynamicStepText({ step: 'agent-pipeline-custom' })).toBe('agent-pipeline-custom');
	});

	it('returns "Processing" when neither stepName nor step is set', () => {
		expect(getDynamicStepText({})).toBe('Processing');
	});
});

describe('getDynamicStepProgress', () => {
	it('uses the explicit progress field when provided', () => {
		expect(getDynamicStepProgress({ progress: 42.6 })).toBe(43);
		expect(getDynamicStepProgress({ progress: 0 })).toBe(0);
	});

	it('uses stepIndex/totalSteps when progress is absent', () => {
		expect(getDynamicStepProgress({ stepIndex: 0, totalSteps: 4 })).toBe(25);
		expect(getDynamicStepProgress({ stepIndex: 3, totalSteps: 4 })).toBe(100);
	});

	it('ignores stepIndex when totalSteps is 0 to avoid divide-by-zero', () => {
		expect(getDynamicStepProgress({ stepIndex: 1, totalSteps: 0 })).toBe(0);
	});

	it('falls back to enum-based progress for known steps', () => {
		const direct = getStepProgress(ItemsGeneratorStep.MARKDOWN_GENERATION);
		expect(getDynamicStepProgress({ step: ItemsGeneratorStep.MARKDOWN_GENERATION })).toBe(direct);
	});

	it('returns 0 when nothing is provided', () => {
		expect(getDynamicStepProgress({})).toBe(0);
	});
});

describe('getItemsProcessedText', () => {
	it('formats the count when itemsProcessed > 0', () => {
		expect(getItemsProcessedText({ itemsProcessed: 1 })).toBe('1 items');
		expect(getItemsProcessedText({ itemsProcessed: 27 })).toBe('27 items');
	});

	it('returns undefined when itemsProcessed is 0 or missing', () => {
		expect(getItemsProcessedText({ itemsProcessed: 0 })).toBeUndefined();
		expect(getItemsProcessedText({})).toBeUndefined();
	});
});
