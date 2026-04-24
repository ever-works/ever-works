import type { PipelineOutputs, PipelineState, PluginContext, PluginSettings } from '@ever-works/plugin';
import { buildCancelledPipelineResult, createPipelineRuntimeHelpers } from '@ever-works/plugin';

import type { ClaudeManagedAgentStepId } from '../types.js';
import { CLAUDE_MANAGED_AGENT_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

const runtime = createPipelineRuntimeHelpers<ClaudeManagedAgentStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: CLAUDE_MANAGED_AGENT_STEP_IDS.length
});

const STEP_CONTEXT_BY_ID = new Map(
	STEP_DEFINITIONS.map((step, stepIndex) => [step.id, { stepIndex, stepName: step.name }])
);

export const initializeState = runtime.initializeState;
export const updateStepState = runtime.updateStepState;
export const reportProgress = runtime.reportProgress;
export const resolveSettings = runtime.resolveSettings;
export const buildMetrics = runtime.buildMetrics;
export const finalizeCompletedState = runtime.finalizeCompletedState;
export const buildErrorResult = runtime.buildErrorResult;

export function getStepProgressContext(stepId: ClaudeManagedAgentStepId): { stepIndex: number; stepName: string } {
	return STEP_CONTEXT_BY_ID.get(stepId) ?? { stepIndex: 0, stepName: stepId };
}

export function buildCancelledResult(
	state: PipelineState<ClaudeManagedAgentStepId> | null,
	startTime: number,
	outputs?: PipelineOutputs
) {
	const currentState: PipelineState<ClaudeManagedAgentStepId> = {
		...(state ?? initializeState()),
		isRunning: false,
		isCancelled: true,
		currentStep: undefined,
		completedAt: Date.now()
	};

	return {
		state: currentState,
		result: buildCancelledPipelineResult({
			outputs: outputs ?? {
				items: [],
				categories: [],
				tags: [],
				collections: [],
				brands: []
			},
			duration: Date.now() - startTime,
			stepsCompleted: currentState.completedSteps.length,
			totalSteps: CLAUDE_MANAGED_AGENT_STEP_IDS.length,
			state: currentState
		})
	};
}

export function getUsableSecret(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed.includes('••••')) {
		return undefined;
	}

	return trimmed;
}

export function getNumericSetting(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		throw new Error('Pipeline cancelled');
	}

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error('Pipeline cancelled'));
		};

		const cleanup = () => signal?.removeEventListener('abort', onAbort);

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export async function resolveManagedAgentSettings(
	context: PluginContext | null,
	userId: string,
	directoryId: string
): Promise<PluginSettings> {
	return resolveSettings(context, userId, directoryId);
}
