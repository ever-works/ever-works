import type {
	PipelineMetrics,
	PipelineProgressCallback,
	PipelineResult,
	PipelineState,
	PluginContext,
	PluginSettings,
	PipelineStepDefinition,
	StepState,
	StepStatus
} from '../../index.js';
import { buildCancelledPipelineResult, buildErrorPipelineResult, createEmptyPipelineOutputs } from '../../index.js';

export interface PipelineRuntimeHelpers<TStepId extends string> {
	readonly initializeState: () => PipelineState<TStepId>;
	readonly updateStepState: (
		state: PipelineState<TStepId>,
		stepId: TStepId,
		status: StepStatus,
		error?: string
	) => PipelineState<TStepId>;
	readonly reportProgress: (
		onProgress: PipelineProgressCallback | undefined,
		stepIndex: number,
		percent: number,
		stepName: string,
		message?: string,
		itemsProcessed?: number
	) => void;
	readonly reportItemProgress: (
		onProgress: PipelineProgressCallback | undefined,
		newItemCount: number,
		targetItems: number,
		stepIndex: number,
		stepName?: string
	) => void;
	readonly resolveSettings: typeof resolveScopedSettings;
	readonly buildMetrics: (startTime: number, duration: number, itemCount: number, custom?: object) => PipelineMetrics;
	readonly finalizeCompletedState: (state: PipelineState<TStepId>) => PipelineState<TStepId>;
	readonly buildErrorResult: (
		state: PipelineState<TStepId> | null,
		error: Error,
		startTime: number
	) => { result: PipelineResult; state: PipelineState<TStepId> };
	readonly buildCancelledResult: (
		state: PipelineState<TStepId> | null,
		startTime: number
	) => { result: PipelineResult; state: PipelineState<TStepId> };
	readonly delay: typeof delay;
}

export interface CreatePipelineRuntimeHelpersOptions<TStepId extends string> {
	readonly stepDefinitions: readonly PipelineStepDefinition<TStepId>[];
	readonly totalSteps: number;
	readonly itemProgressStepName?: string;
}

export function initializePipelineState<TStepId extends string>(
	stepDefinitions: readonly PipelineStepDefinition<TStepId>[]
): PipelineState<TStepId> {
	const steps = new Map<TStepId, StepState<TStepId>>();
	for (const def of stepDefinitions) {
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

export function updatePipelineStepState<TStepId extends string>(
	state: PipelineState<TStepId>,
	stepId: TStepId,
	status: StepStatus,
	error?: string
): PipelineState<TStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) return state;

	const now = Date.now();
	const isTerminal = status === 'completed' || status === 'failed' || status === 'skipped';
	const updated: StepState<TStepId> = {
		...existing,
		status,
		startedAt: status === 'running' ? now : existing.startedAt,
		completedAt: isTerminal ? now : existing.completedAt,
		error: error ?? existing.error
	};

	const steps = new Map(state.steps);
	steps.set(stepId, updated);

	const completedSteps =
		status === 'completed' || status === 'skipped' ? [...state.completedSteps, stepId] : state.completedSteps;
	const failedSteps = status === 'failed' ? [...state.failedSteps, stepId] : state.failedSteps;

	return {
		...state,
		steps,
		currentStep: status === 'running' ? stepId : state.currentStep === stepId ? undefined : state.currentStep,
		completedSteps,
		failedSteps
	};
}

export function reportPipelineProgress(
	onProgress: PipelineProgressCallback | undefined,
	totalSteps: number,
	stepIndex: number,
	percent: number,
	stepName: string,
	message?: string,
	itemsProcessed?: number
): void {
	onProgress?.({
		percent,
		currentStepIndex: stepIndex,
		totalSteps,
		currentStepName: stepName,
		message,
		itemsProcessed
	});
}

export function reportPipelineItemProgress(
	onProgress: PipelineProgressCallback | undefined,
	totalSteps: number,
	newItemCount: number,
	targetItems: number,
	stepIndex: number,
	stepName = 'Generate Items'
): void {
	const ratio = newItemCount / Math.max(targetItems, 1);
	const percent = Math.min(30 + Math.round(ratio * 53), 83);

	onProgress?.({
		percent,
		currentStepIndex: stepIndex,
		totalSteps,
		currentStepName: stepName,
		message: `${newItemCount} items generated`,
		itemsProcessed: newItemCount
	});
}

export async function resolveScopedSettings(
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

export function buildPipelineMetrics(
	startTime: number,
	duration: number,
	itemCount: number,
	custom?: Record<string, unknown>
): PipelineMetrics {
	return {
		startTime,
		duration,
		itemsProcessed: itemCount,
		steps: {},
		...(custom ? { custom } : {})
	};
}

export function finalizePipelineState<TStepId extends string>(state: PipelineState<TStepId>): PipelineState<TStepId> {
	return {
		...state,
		isRunning: false,
		isCancelled: false,
		currentStep: undefined,
		completedAt: Date.now()
	};
}

export function buildPipelineErrorResult<TStepId extends string>(
	state: PipelineState<TStepId> | null,
	error: Error,
	startTime: number,
	totalSteps: number,
	initializeState: () => PipelineState<TStepId>
): { result: PipelineResult; state: PipelineState<TStepId> } {
	let currentState = state ?? initializeState();

	for (const [stepId, stepState] of currentState.steps) {
		if (stepState.status === 'running') {
			currentState = updatePipelineStepState(currentState, stepId, 'failed', error.message);
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
			totalSteps,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildPipelineCancelledResult<TStepId extends string>(
	state: PipelineState<TStepId> | null,
	startTime: number,
	totalSteps: number,
	initializeState: () => PipelineState<TStepId>
): { result: PipelineResult; state: PipelineState<TStepId> } {
	const currentState: PipelineState<TStepId> = {
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
			totalSteps,
			state: currentState
		})
	};
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPipelineRuntimeHelpers<TStepId extends string>(
	options: CreatePipelineRuntimeHelpersOptions<TStepId>
): PipelineRuntimeHelpers<TStepId> {
	const initializeState = (): PipelineState<TStepId> => initializePipelineState(options.stepDefinitions);

	const updateStepState = (
		state: PipelineState<TStepId>,
		stepId: TStepId,
		status: StepStatus,
		error?: string
	): PipelineState<TStepId> => updatePipelineStepState(state, stepId, status, error);

	const reportProgress = (
		onProgress: PipelineProgressCallback | undefined,
		stepIndex: number,
		percent: number,
		stepName: string,
		message?: string,
		itemsProcessed?: number
	): void => {
		reportPipelineProgress(onProgress, options.totalSteps, stepIndex, percent, stepName, message, itemsProcessed);
	};

	const reportItemProgress = (
		onProgress: PipelineProgressCallback | undefined,
		newItemCount: number,
		targetItems: number,
		stepIndex: number,
		stepName = options.itemProgressStepName ?? 'Generate Items'
	): void => {
		reportPipelineItemProgress(onProgress, options.totalSteps, newItemCount, targetItems, stepIndex, stepName);
	};

	const buildMetrics = (startTime: number, duration: number, itemCount: number, custom?: object): PipelineMetrics =>
		buildPipelineMetrics(startTime, duration, itemCount, custom as Record<string, unknown>);

	const finalizeCompletedState = (state: PipelineState<TStepId>): PipelineState<TStepId> =>
		finalizePipelineState(state);

	const buildErrorResult = (
		state: PipelineState<TStepId> | null,
		error: Error,
		startTime: number
	): { result: PipelineResult; state: PipelineState<TStepId> } =>
		buildPipelineErrorResult(state, error, startTime, options.totalSteps, initializeState);

	const buildCancelledResult = (
		state: PipelineState<TStepId> | null,
		startTime: number
	): { result: PipelineResult; state: PipelineState<TStepId> } =>
		buildPipelineCancelledResult(state, startTime, options.totalSteps, initializeState);

	return {
		initializeState,
		updateStepState,
		reportProgress,
		reportItemProgress,
		resolveSettings: resolveScopedSettings,
		buildMetrics,
		finalizeCompletedState,
		buildErrorResult,
		buildCancelledResult,
		delay
	};
}
