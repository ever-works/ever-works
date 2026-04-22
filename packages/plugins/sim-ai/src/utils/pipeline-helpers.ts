import type { PipelineState, PipelineMetrics } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { SimAiStepId, SimAiPipelineMetrics } from '../types.js';
import { SIM_AI_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

const runtime = createPipelineRuntimeHelpers<SimAiStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: SIM_AI_STEP_IDS.length
});

export const initializeState = runtime.initializeState;
export const updateStepState = runtime.updateStepState;
export const reportProgress = runtime.reportProgress;
export const resolveSettings = runtime.resolveSettings;
export const finalizeCompletedState = runtime.finalizeCompletedState;
export const buildErrorResult = runtime.buildErrorResult;
export const buildCancelledResult = runtime.buildCancelledResult;

export function buildMetrics(
	startTime: number,
	duration: number,
	itemCount: number,
	simMetrics?: SimAiPipelineMetrics
): PipelineMetrics {
	return runtime.buildMetrics(startTime, duration, itemCount, simMetrics);
}
