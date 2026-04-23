import type { PluginSettings, PipelineState } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { ClaudeCodeStepId } from '../types.js';
import { CLAUDE_CODE_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

const runtime = createPipelineRuntimeHelpers<ClaudeCodeStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: CLAUDE_CODE_STEP_IDS.length
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
	const oauthToken = settings.oauthToken as string | undefined;
	const apiKey = settings.apiKey as string | undefined;

	if (oauthToken) {
		return { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
	}
	if (apiKey) {
		return { ANTHROPIC_API_KEY: apiKey };
	}
	return {};
}
