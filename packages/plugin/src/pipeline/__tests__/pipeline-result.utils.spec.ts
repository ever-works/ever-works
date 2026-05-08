import { describe, expect, it } from 'vitest';
import {
	buildCancelledPipelineResult,
	buildErrorPipelineResult,
	buildSuccessPipelineResult,
	createEmptyPipelineOutputs
} from '../pipeline-result.utils.js';
import type { PipelineOutputs } from '../../contracts/capabilities/pipeline-plugin.interface.js';

describe('createEmptyPipelineOutputs', () => {
	it('returns the five output arrays empty', () => {
		const outputs = createEmptyPipelineOutputs();
		expect(outputs).toEqual({
			items: [],
			categories: [],
			tags: [],
			collections: [],
			brands: []
		});
	});

	it('returns a fresh object on each call (no shared reference)', () => {
		const a = createEmptyPipelineOutputs();
		const b = createEmptyPipelineOutputs();
		expect(a).not.toBe(b);
		expect(a.items).not.toBe(b.items);
	});

	it('does NOT include domainAnalysis or extra by default', () => {
		const outputs = createEmptyPipelineOutputs();
		expect((outputs as unknown as { domainAnalysis?: unknown }).domainAnalysis).toBeUndefined();
		expect((outputs as unknown as { extra?: unknown }).extra).toBeUndefined();
	});
});

describe('buildSuccessPipelineResult', () => {
	const populatedOutputs: PipelineOutputs = {
		items: [{ name: 'A', slug: 'a' } as never],
		categories: [],
		tags: [],
		collections: [],
		brands: []
	};

	it('marks success=true and forwards outputs', () => {
		const result = buildSuccessPipelineResult(populatedOutputs, {
			duration: 1234,
			stepsCompleted: 5,
			totalSteps: 5
		});
		expect(result.success).toBe(true);
		expect(result.outputs).toBe(populatedOutputs);
		expect(result.duration).toBe(1234);
		expect(result.stepsCompleted).toBe(5);
		expect(result.totalSteps).toBe(5);
	});

	it('forwards optional state/metrics/warnings when provided', () => {
		const state = { foo: 'bar' } as unknown as Parameters<typeof buildSuccessPipelineResult>[1]['state'];
		const metrics = { totalDuration: 1234 } as unknown as Parameters<
			typeof buildSuccessPipelineResult
		>[1]['metrics'];
		const warnings = ['slow-step'] as readonly string[];

		const result = buildSuccessPipelineResult(populatedOutputs, {
			duration: 10,
			stepsCompleted: 1,
			totalSteps: 1,
			state,
			metrics,
			warnings
		});

		expect(result.state).toBe(state);
		expect(result.metrics).toBe(metrics);
		expect(result.warnings).toBe(warnings);
		expect(result.error).toBeUndefined();
		expect(result.failedStep).toBeUndefined();
	});

	it('omits state/metrics/warnings when not provided', () => {
		const result = buildSuccessPipelineResult(populatedOutputs, {
			duration: 1,
			stepsCompleted: 1,
			totalSteps: 1
		});
		expect(result.state).toBeUndefined();
		expect(result.metrics).toBeUndefined();
		expect(result.warnings).toBeUndefined();
	});
});

describe('buildErrorPipelineResult', () => {
	it('marks success=false, defaults outputs to empty when omitted', () => {
		const err = new Error('boom');
		const result = buildErrorPipelineResult(err, {
			duration: 50,
			stepsCompleted: 1,
			totalSteps: 3
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe(err);
		expect(result.outputs).toEqual(createEmptyPipelineOutputs());
		expect(result.duration).toBe(50);
		expect(result.stepsCompleted).toBe(1);
		expect(result.totalSteps).toBe(3);
		expect(result.failedStep).toBeUndefined();
	});

	it('accepts a string error and a custom failedStep', () => {
		const result = buildErrorPipelineResult('something broke', {
			duration: 0,
			stepsCompleted: 0,
			totalSteps: 1,
			failedStep: 'plan'
		});
		expect(result.error).toBe('something broke');
		expect(result.failedStep).toBe('plan');
	});

	it('preserves caller-supplied partial outputs (does NOT override with empty)', () => {
		const partial: PipelineOutputs = {
			items: [{ name: 'X' } as never],
			categories: [],
			tags: [],
			collections: [],
			brands: []
		};
		const result = buildErrorPipelineResult(new Error('partial fail'), {
			duration: 10,
			stepsCompleted: 1,
			totalSteps: 2,
			outputs: partial
		});
		expect(result.outputs).toBe(partial);
	});

	it('forwards state/metrics/warnings to the error result', () => {
		const result = buildErrorPipelineResult('e', {
			duration: 1,
			stepsCompleted: 0,
			totalSteps: 1,
			state: { x: 1 } as unknown as Parameters<typeof buildErrorPipelineResult>[1]['state'],
			metrics: { totalDuration: 1 } as unknown as Parameters<typeof buildErrorPipelineResult>[1]['metrics'],
			warnings: ['w']
		});
		expect(result.state).toEqual({ x: 1 });
		expect(result.warnings).toEqual(['w']);
	});
});

describe('buildCancelledPipelineResult', () => {
	it('returns an error result with the literal "Pipeline cancelled" message', () => {
		const result = buildCancelledPipelineResult({
			duration: 5,
			stepsCompleted: 2,
			totalSteps: 4
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe('Pipeline cancelled');
		expect(result.duration).toBe(5);
		expect(result.stepsCompleted).toBe(2);
		expect(result.totalSteps).toBe(4);
	});

	it('defaults outputs to empty when not provided', () => {
		const result = buildCancelledPipelineResult({
			duration: 0,
			stepsCompleted: 0,
			totalSteps: 0
		});
		expect(result.outputs).toEqual(createEmptyPipelineOutputs());
	});

	it('preserves partial outputs when caller provides them', () => {
		const partial: PipelineOutputs = {
			items: [],
			categories: [{ name: 'C' } as never],
			tags: [],
			collections: [],
			brands: []
		};
		const result = buildCancelledPipelineResult({
			duration: 0,
			stepsCompleted: 0,
			totalSteps: 0,
			outputs: partial
		});
		expect(result.outputs).toBe(partial);
	});
});
