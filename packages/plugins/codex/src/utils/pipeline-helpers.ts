import type { PluginContext, PluginSettings, PipelineProgressCallback, PipelineResult } from '@ever-works/plugin';
import { buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';
import { CODEX_STEP_IDS } from '../types.js';

export async function resolveSettings(
	context: PluginContext | null,
	userId: string,
	directoryId: string
): Promise<PluginSettings> {
	if (!context) return {};

	try {
		const [userSettings, directorySettings] = await Promise.all([
			context.getSettings('user', userId),
			context.getSettings('directory', directoryId)
		]);

		for (const key in directorySettings) {
			if (directorySettings[key]) {
				userSettings[key] = directorySettings[key];
			}
		}

		return userSettings;
	} catch {
		return {};
	}
}

export function resolveAuthEnv(settings: PluginSettings): Record<string, string> {
	const apiKey = settings.apiKey as string | undefined;
	return apiKey ? { OPENAI_API_KEY: apiKey } : {};
}

export function reportProgress(
	onProgress: PipelineProgressCallback | undefined,
	stepIndex: number,
	percent: number,
	stepName: string,
	message?: string
): void {
	onProgress?.({
		percent,
		currentStepIndex: stepIndex,
		totalSteps: CODEX_STEP_IDS.length,
		currentStepName: stepName,
		message
	});
}

export function buildNotImplementedResult(pluginName: string, startTime: number): PipelineResult {
	return buildErrorPipelineResult(new Error(`${pluginName} execution is not implemented yet`), {
		outputs: createEmptyPipelineOutputs(),
		duration: Date.now() - startTime,
		stepsCompleted: 0,
		totalSteps: CODEX_STEP_IDS.length
	});
}
