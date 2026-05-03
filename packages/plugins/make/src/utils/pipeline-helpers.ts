import type { PipelineMetrics } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { MakeStepId, MakePipelineMetrics } from '../types.js';
import { MAKE_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

const runtime = createPipelineRuntimeHelpers<MakeStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: MAKE_STEP_IDS.length
});

export const initializeState = runtime.initializeState;
export const updateStepState = runtime.updateStepState;
export const reportProgress = runtime.reportProgress;
export const resolveSettings = runtime.resolveSettings;
export const finalizeCompletedState = runtime.finalizeCompletedState;
export const buildErrorResult = runtime.buildErrorResult;
export const buildCancelledResult = runtime.buildCancelledResult;

/**
 * Merges user and work-level settings (work overrides user).
 *
 * Returns a fresh object rather than mutating either input, so the plugin
 * context is free to cache the original settings objects without risk of
 * cross-work contamination on subsequent calls. Only own, non-nullish
 * work properties override user values.
 */
export function buildMetrics(
	startTime: number,
	duration: number,
	itemCount: number,
	makeMetrics?: MakePipelineMetrics
): PipelineMetrics {
	return runtime.buildMetrics(startTime, duration, itemCount, makeMetrics);
}
