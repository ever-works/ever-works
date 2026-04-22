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
import type { SimAiStepId, SimAiPipelineMetrics } from '../types.js';
import { SIM_AI_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export function initializeState(): PipelineState<SimAiStepId> {
	const steps = new Map<SimAiStepId, StepState<SimAiStepId>>();
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
	state: PipelineState<SimAiStepId>,
	stepId: SimAiStepId,
	status: StepStatus,
	error?: string
): PipelineState<SimAiStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) return state;

	const now = Date.now();
	const steps = new Map(state.steps);
	const isTerminal = status === 'completed' || status === 'failed' || status === 'skipped';
	steps.set(stepId, {
		...existing,
		status,
		startedAt: status === 'running' ? now : existing.startedAt,
		completedAt: isTerminal ? now : existing.completedAt,
		error: error ?? existing.error
	});

	return {
		...state,
		steps,
		currentStep: status === 'running' ? stepId : state.currentStep === stepId ? undefined : state.currentStep,
		completedSteps:
			status === 'completed' || status === 'skipped' ? [...state.completedSteps, stepId] : state.completedSteps,
		failedSteps: status === 'failed' ? [...state.failedSteps, stepId] : state.failedSteps
	};
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
		totalSteps: SIM_AI_STEP_IDS.length,
		currentStepName: stepName,
		message
	});
}

/** Merges user and directory-level settings (directory overrides user). */
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

		const merged: PluginSettings = { ...userSettings };
		for (const key in directorySettings) {
			if (directorySettings[key] !== undefined && directorySettings[key] !== null) {
				merged[key] = directorySettings[key];
			}
		}

		return merged;
	} catch {
		return {};
	}
}

export function buildMetrics(
	startTime: number,
	duration: number,
	itemCount: number,
	simMetrics?: SimAiPipelineMetrics
): PipelineMetrics {
	return {
		startTime,
		duration,
		itemsProcessed: itemCount,
		steps: {},
		...(simMetrics ? { custom: simMetrics } : {})
	};
}

export function finalizeCompletedState(state: PipelineState<SimAiStepId>): PipelineState<SimAiStepId> {
	return {
		...state,
		isRunning: false,
		isCancelled: false,
		currentStep: undefined,
		completedAt: Date.now()
	};
}

export function buildErrorResult(
	state: PipelineState<SimAiStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<SimAiStepId> } {
	let currentState = state ?? initializeState();

	// Mark the currently running step as failed
	for (const [stepId, stepState] of currentState.steps) {
		if (stepState.status === 'running') {
			currentState = updateStepState(currentState, stepId, 'failed', error.message);
			break;
		}
	}

	currentState = {
		...currentState,
		isRunning: false,
		isCancelled: false,
		currentStep: undefined,
		completedAt: Date.now()
	};

	return {
		state: currentState,
		result: buildErrorPipelineResult(error, {
			outputs: createEmptyPipelineOutputs(),
			duration: Date.now() - startTime,
			stepsCompleted: currentState.completedSteps.length,
			totalSteps: SIM_AI_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<SimAiStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<SimAiStepId> } {
	const currentState: PipelineState<SimAiStepId> = {
		...(state ?? initializeState()),
		isRunning: false,
		isCancelled: true,
		currentStep: undefined,
		completedAt: Date.now()
	};

	return {
		state: currentState,
		result: buildCancelledPipelineResult({
			outputs: createEmptyPipelineOutputs(),
			duration: Date.now() - startTime,
			stepsCompleted: currentState.completedSteps.length,
			totalSteps: SIM_AI_STEP_IDS.length,
			state: currentState
		})
	};
}
