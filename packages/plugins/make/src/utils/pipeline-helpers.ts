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
import type { MakeStepId, MakePipelineMetrics } from '../types.js';
import { MAKE_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export function initializeState(): PipelineState<MakeStepId> {
	const steps = new Map<MakeStepId, StepState<MakeStepId>>();
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
	state: PipelineState<MakeStepId>,
	stepId: MakeStepId,
	status: StepStatus,
	error?: string
): PipelineState<MakeStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) return state;

	const now = Date.now();
	const steps = new Map(state.steps);
	steps.set(stepId, {
		...existing,
		status,
		startedAt: status === 'running' ? now : existing.startedAt,
		completedAt: status === 'completed' || status === 'failed' ? now : undefined,
		error: error ?? existing.error
	});

	return {
		...state,
		steps,
		currentStep: status === 'running' ? stepId : state.currentStep,
		completedSteps: status === 'completed' ? [...state.completedSteps, stepId] : state.completedSteps,
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
		totalSteps: MAKE_STEP_IDS.length,
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

		for (const key in directorySettings) {
			if (directorySettings[key] !== undefined && directorySettings[key] !== null) {
				userSettings[key] = directorySettings[key];
			}
		}

		return userSettings;
	} catch {
		return {};
	}
}

export function buildMetrics(
	startTime: number,
	duration: number,
	itemCount: number,
	makeMetrics?: MakePipelineMetrics
): PipelineMetrics {
	return {
		startTime,
		duration,
		itemsProcessed: itemCount,
		steps: {},
		...(makeMetrics ? { custom: makeMetrics } : {})
	};
}

export function buildErrorResult(
	state: PipelineState<MakeStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<MakeStepId> } {
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
			totalSteps: MAKE_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<MakeStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<MakeStepId> } {
	const currentState: PipelineState<MakeStepId> = {
		...(state ?? initializeState()),
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
			totalSteps: MAKE_STEP_IDS.length,
			state: currentState
		})
	};
}
