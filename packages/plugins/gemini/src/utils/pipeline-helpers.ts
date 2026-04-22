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
	const authMode = settings.authMode as string | undefined;
	const apiKey = getUsableSecret(settings.apiKey);
	const googleApiKey = getUsableSecret(settings.googleApiKey);
	const project = settings.googleCloudProject as string | undefined;
	const location = settings.googleCloudLocation as string | undefined;

	if (authMode === 'api-key' && apiKey) {
		return { GEMINI_API_KEY: apiKey };
	}

	if (authMode === 'vertex') {
		const env: Record<string, string> = {
			GOOGLE_GENAI_USE_VERTEXAI: 'true'
		};

		if (googleApiKey) env.GOOGLE_API_KEY = googleApiKey;
		if (project) env.GOOGLE_CLOUD_PROJECT = project;
		if (location) env.GOOGLE_CLOUD_LOCATION = location;
		return env;
	}

	return {};
}
