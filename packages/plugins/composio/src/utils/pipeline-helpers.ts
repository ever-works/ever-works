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
import type { ComposioStepId, ComposioPipelineMetrics } from '../types.js';
import { COMPOSIO_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export function initializeState(): PipelineState<ComposioStepId> {
	const steps = new Map<ComposioStepId, StepState<ComposioStepId>>();
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
	state: PipelineState<ComposioStepId>,
	stepId: ComposioStepId,
	status: StepStatus,
	error?: string
): PipelineState<ComposioStepId> {
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
		totalSteps: COMPOSIO_STEP_IDS.length,
		currentStepName: stepName,
		message
	});
}

/** Merges user and work-level settings (work overrides user). */
export async function resolveSettings(
	context: PluginContext | null,
	userId: string,
	workId: string
): Promise<PluginSettings> {
	if (!context) return {};

	try {
		const [userSettings, workSettings] = await Promise.all([
			context.getSettings('user', userId),
			context.getSettings('work', workId)
		]);

		// Spread into a fresh object — `context.getSettings()` may return a
		// shared cache reference, and mutating it in place would leak work-level
		// overrides into subsequent reads for the same user.
		const merged: PluginSettings = { ...userSettings };
		for (const key in workSettings) {
			if (workSettings[key] !== undefined && workSettings[key] !== null) {
				merged[key] = workSettings[key];
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
	composioMetrics?: ComposioPipelineMetrics
): PipelineMetrics {
	return {
		startTime,
		duration,
		itemsProcessed: itemCount,
		steps: {},
		...(composioMetrics ? { custom: composioMetrics } : {})
	};
}

export function buildErrorResult(
	state: PipelineState<ComposioStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<ComposioStepId> } {
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
			totalSteps: COMPOSIO_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<ComposioStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<ComposioStepId> } {
	const currentState: PipelineState<ComposioStepId> = {
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
			totalSteps: COMPOSIO_STEP_IDS.length,
			state: currentState
		})
	};
}
