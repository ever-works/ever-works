import type { PluginSettings, PipelineState } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { GeminiStepId } from '../types.js';
import { GEMINI_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

function getUsableSecret(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed.includes('••••')) {
		return undefined;
	}

	return trimmed;
}

const runtime = createPipelineRuntimeHelpers<GeminiStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: GEMINI_STEP_IDS.length
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

export function resolveAuthEnv(settings: PluginSettings): Record<string, string> {
	const apiKey = getUsableSecret(settings.apiKey);
	return apiKey ? { GEMINI_API_KEY: apiKey } : {};
}
