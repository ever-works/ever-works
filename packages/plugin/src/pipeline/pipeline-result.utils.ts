import type { PipelineState } from './step-definition.types.js';
import type { PipelineMetrics } from './step-types.js';
import type { PipelineOutputs, PipelineResult } from '../contracts/capabilities/pipeline-plugin.interface.js';

export function createEmptyPipelineOutputs(): PipelineOutputs {
	return {
		items: [],
		categories: [],
		tags: [],
		collections: [],
		brands: []
	};
}

interface PipelineResultBase {
	duration: number;
	stepsCompleted: number;
	totalSteps: number;
	state?: PipelineState;
	metrics?: PipelineMetrics;
	warnings?: readonly string[];
}

export function buildSuccessPipelineResult(outputs: PipelineOutputs, base: PipelineResultBase): PipelineResult {
	return {
		success: true,
		outputs,
		duration: base.duration,
		stepsCompleted: base.stepsCompleted,
		totalSteps: base.totalSteps,
		state: base.state,
		metrics: base.metrics,
		warnings: base.warnings
	};
}

export function buildErrorPipelineResult(
	error: Error | string,
	base: PipelineResultBase & {
		failedStep?: string;
		outputs?: PipelineOutputs;
	}
): PipelineResult {
	return {
		success: false,
		outputs: base.outputs ?? createEmptyPipelineOutputs(),
		duration: base.duration,
		stepsCompleted: base.stepsCompleted,
		totalSteps: base.totalSteps,
		state: base.state,
		metrics: base.metrics,
		warnings: base.warnings,
		error,
		failedStep: base.failedStep
	};
}

export function buildCancelledPipelineResult(
	base: PipelineResultBase & {
		outputs?: PipelineOutputs;
	}
): PipelineResult {
	return buildErrorPipelineResult('Pipeline cancelled', base);
}
