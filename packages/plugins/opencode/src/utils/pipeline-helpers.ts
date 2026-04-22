import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { OpenCodeStepId } from '../types.js';
import { OPENCODE_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

const runtime = createPipelineRuntimeHelpers<OpenCodeStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: OPENCODE_STEP_IDS.length
});

export const initializeState = runtime.initializeState;
export const updateStepState = runtime.updateStepState;
export const reportProgress = runtime.reportProgress;
export const reportItemProgress = runtime.reportItemProgress;
export const resolveSettings = runtime.resolveSettings;
export const buildMetrics = runtime.buildMetrics;
export const finalizeCompletedState = runtime.finalizeCompletedState;
export const buildErrorResult = runtime.buildErrorResult;
export const buildCancelledResult = runtime.buildCancelledResult;
export const delay = runtime.delay;
