import type {
	PluginContext,
	PluginSettings,
	PipelineState,
	StepState,
	PipelineProgressCallback,
	PipelineResult,
	StepStatus
} from '@ever-works/plugin';
import { buildCancelledPipelineResult, buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';
import type { AgentPipelineStepId, AgentPipelineMetrics, TokenUsageBreakdown } from '../types.js';
import { AGENT_PIPELINE_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export function initializeState(): PipelineState<AgentPipelineStepId> {
	const steps = new Map<AgentPipelineStepId, StepState<AgentPipelineStepId>>();
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
	state: PipelineState<AgentPipelineStepId>,
	stepId: AgentPipelineStepId,
	status: StepStatus,
	error?: string
): PipelineState<AgentPipelineStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) return state;

	const now = Date.now();
	const updated: StepState<AgentPipelineStepId> = {
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
		currentStep: status === 'running' ? stepId : state.currentStep === stepId ? undefined : state.currentStep,
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
		totalSteps: AGENT_PIPELINE_STEP_IDS.length,
		currentStepName: stepName
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
	tokenUsage?: TokenUsageBreakdown
): AgentPipelineMetrics {
	const metrics: AgentPipelineMetrics = { startTime, duration, itemsProcessed: itemCount, steps: {} };
	if (tokenUsage) {
		metrics.tokenUsage = tokenUsage;
	}
	return metrics;
}

export function finalizeCompletedState(state: PipelineState<AgentPipelineStepId>): PipelineState<AgentPipelineStepId> {
	return {
		...state,
		isRunning: false,
		isCancelled: false,
		currentStep: undefined,
		completedAt: Date.now()
	};
}

export function buildErrorResult(
	state: PipelineState<AgentPipelineStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<AgentPipelineStepId> } {
	let currentState = state ?? initializeState();

	if (currentState) {
		for (const [stepId, stepState] of currentState.steps) {
			if (stepState.status === 'running') {
				currentState = updateStepState(currentState, stepId, 'failed', error.message);
				break;
			}
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
			totalSteps: AGENT_PIPELINE_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<AgentPipelineStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<AgentPipelineStepId> } {
	let currentState = state ?? initializeState();

	currentState = {
		...currentState,
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
			totalSteps: AGENT_PIPELINE_STEP_IDS.length,
			state: currentState
		})
	};
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
