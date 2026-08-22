import type { PluginSettings, PipelineState } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';
import type { ClaudeAuthMode } from './subprocess-env.js';
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

/**
 * Decide which credential this agent authenticates with.
 *
 * `authMode` pins the choice. An explicit mode resolves its own credential
 * first; when that credential is missing we fall back only *away* from
 * per-token billing, never toward it. An agent pinned to `subscription` that
 * quietly ran on an API key would bill the Console org for work the operator
 * expected their Claude plan to cover — no error, just an unexpected invoice —
 * so `subscription` fails closed rather than degrading. The reverse is
 * harmless (it costs plan quota, not money), so `api-key` may degrade to the
 * subscription token. An unset `authMode` keeps the historical inference
 * (OAuth token wins when both are present) so existing plugin configurations
 * keep working unchanged.
 */
export function resolveAuthMode(settings: PluginSettings): ClaudeAuthMode | undefined {
	const mode = settings.authMode;
	return mode === 'subscription' || mode === 'api-key' ? mode : undefined;
}

export function resolveAuthEnv(settings: PluginSettings): Record<string, string> {
	const oauthToken = settings.oauthToken as string | undefined;
	const apiKey = settings.apiKey as string | undefined;
	const authMode = resolveAuthMode(settings);

	if (authMode === 'subscription') {
		return oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {};
	}
	if (authMode === 'api-key' && apiKey) {
		return { ANTHROPIC_API_KEY: apiKey };
	}

	if (oauthToken) {
		return { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
	}
	if (apiKey) {
		return { ANTHROPIC_API_KEY: apiKey };
	}
	return {};
}

/**
 * The mode a resolved auth env actually represents, for pinning
 * `buildSubprocessEnv` and for recording on the run which credential served it.
 */
export function authModeForEnv(authEnv: Record<string, string>): ClaudeAuthMode | undefined {
	if (authEnv.CLAUDE_CODE_OAUTH_TOKEN) return 'subscription';
	if (authEnv.ANTHROPIC_API_KEY) return 'api-key';
	return undefined;
}
