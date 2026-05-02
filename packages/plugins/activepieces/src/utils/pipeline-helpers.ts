import type { PipelineMetrics } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { ActivepiecesStepId, ActivepiecesPipelineMetrics } from '../types.js';
import { ACTIVEPIECES_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

const runtime = createPipelineRuntimeHelpers<ActivepiecesStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: ACTIVEPIECES_STEP_IDS.length
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
	flowMetrics?: ActivepiecesPipelineMetrics
): PipelineMetrics {
	return runtime.buildMetrics(startTime, duration, itemCount, flowMetrics);
}
