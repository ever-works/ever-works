import type {
	PluginContext,
	PluginSettings,
	PipelineState,
	StepState,
	PipelineProgressCallback,
	PipelineResult,
	PipelineMetrics,
	StepStatus
} from '@ever-works/plugin';
import { buildCancelledPipelineResult, buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';
import type { ClaudeCodeStepId } from '../types.js';
import { CLAUDE_CODE_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export function initializeState(): PipelineState<ClaudeCodeStepId> {
	const steps = new Map<ClaudeCodeStepId, StepState<ClaudeCodeStepId>>();
	for (const def of STEP_DEFINITIONS) {
		steps.set(def.id, { definition: def, status: 'pending' });
	}

	return {
		steps,
		completedSteps: [],
		failedSteps: [],
		isRunning: true,
		isCancelled: false,
		startedAt: Date.now()
	};
}

export function updateStepState(
	state: PipelineState<ClaudeCodeStepId>,
	stepId: ClaudeCodeStepId,
	status: StepStatus,
	error?: string
): PipelineState<ClaudeCodeStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) return state;

	const now = Date.now();
	const updated: StepState<ClaudeCodeStepId> = {
		...existing,
		status,
		startedAt: status === 'running' ? now : existing.startedAt,
		completedAt: status === 'completed' || status === 'failed' ? now : undefined,
		error: error ?? existing.error
	};

	const steps = new Map(state.steps);
	steps.set(stepId, updated);

	const completedSteps = status === 'completed' ? [...state.completedSteps, stepId] : state.completedSteps;

	const failedSteps = status === 'failed' ? [...state.failedSteps, stepId] : state.failedSteps;

	return {
		...state,
		steps,
		currentStep: status === 'running' ? stepId : state.currentStep,
		completedSteps,
		failedSteps
	};
}

export function reportProgress(
	onProgress: PipelineProgressCallback | undefined,
	stepIndex: number,
	percent: number,
	stepName: string
): void {
	onProgress?.({
		percent,
		currentStepIndex: stepIndex,
		totalSteps: CLAUDE_CODE_STEP_IDS.length,
		currentStepName: stepName
	});
}

/**
 * Report item-level progress during the "Generate Items" step.
 * Maps newItemCount / targetItems linearly to the 30–83% range,
 * leaving a gap before step 4 (Collect Results at 85%).
 */
export function reportItemProgress(
	onProgress: PipelineProgressCallback | undefined,
	newItemCount: number,
	targetItems: number,
	stepIndex: number
): void {
	const ratio = newItemCount / Math.max(targetItems, 1);
	const percent = Math.min(30 + Math.round(ratio * 53), 83);

	onProgress?.({
		percent,
		currentStepIndex: stepIndex,
		totalSteps: CLAUDE_CODE_STEP_IDS.length,
		currentStepName: 'Generate Items',
		message: `${newItemCount} items generated`,
		itemsProcessed: newItemCount
	});
}

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

export function buildMetrics(startTime: number, duration: number, itemCount: number): PipelineMetrics {
	return {
		startTime,
		duration,
		itemsProcessed: itemCount,
		steps: {}
	};
}

export function buildErrorResult(
	state: PipelineState<ClaudeCodeStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<ClaudeCodeStepId> } {
	let currentState = state ?? initializeState();

	for (const [stepId, stepState] of currentState.steps) {
		if (stepState.status === 'running') {
			currentState = updateStepState(currentState, stepId, 'failed', error.message);
			break;
		}
	}

	return {
		state: currentState,
		result: buildErrorPipelineResult(error, {
			outputs: createEmptyPipelineOutputs(),
			duration: Date.now() - startTime,
			stepsCompleted: currentState.completedSteps.length,
			totalSteps: CLAUDE_CODE_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<ClaudeCodeStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<ClaudeCodeStepId> } {
	let currentState = state ?? initializeState();

	currentState = {
		...currentState,
		isRunning: false,
		isCancelled: true,
		completedAt: Date.now()
	};

	return {
		state: currentState,
		result: buildCancelledPipelineResult({
			outputs: createEmptyPipelineOutputs(),
			duration: Date.now() - startTime,
			stepsCompleted: currentState.completedSteps.length,
			totalSteps: CLAUDE_CODE_STEP_IDS.length,
			state: currentState
		})
	};
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
