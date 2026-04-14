import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type {
	PipelineMetrics,
	PipelineProgressCallback,
	PipelineResult,
	PipelineState,
	PluginContext,
	PluginSettings,
	StepState,
	StepStatus
} from '@ever-works/plugin';
import { buildCancelledPipelineResult, buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';

import type { CodexStepId } from '../types.js';
import { CODEX_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export interface ResolvedExecutionAuth {
	readonly env: Record<string, string>;
	readonly mode: 'api-key' | 'local';
	readonly codexHome?: string;
}

export function initializeState(): PipelineState<CodexStepId> {
	const steps = new Map<CodexStepId, StepState<CodexStepId>>();
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
	state: PipelineState<CodexStepId>,
	stepId: CodexStepId,
	status: StepStatus,
	error?: string
): PipelineState<CodexStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) {
		return state;
	}

	const now = Date.now();
	const updated: StepState<CodexStepId> = {
		...existing,
		status,
		startedAt: status === 'running' ? now : existing.startedAt,
		completedAt: status === 'completed' || status === 'failed' || status === 'skipped' ? now : undefined,
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
		failedSteps,
		isRunning: status === 'running' ? true : state.isRunning
	};
}

export function reportProgress(
	onProgress: PipelineProgressCallback | undefined,
	stepIndex: number,
	percent: number,
	stepName: string,
	message?: string,
	itemsProcessed?: number
): void {
	onProgress?.({
		percent,
		currentStepIndex: stepIndex,
		totalSteps: CODEX_STEP_IDS.length,
		currentStepName: stepName,
		message,
		itemsProcessed
	});
}

export async function resolveSettings(
	context: PluginContext | null,
	userId: string,
	directoryId: string
): Promise<PluginSettings> {
	if (!context) {
		return {};
	}

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

export function resolveCodexHome(settings: PluginSettings): string {
	const configured = typeof settings.codexHome === 'string' ? settings.codexHome.trim() : '';
	return configured || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export async function hasLocalCodexAuth(settings: PluginSettings): Promise<boolean> {
	const authPath = path.join(resolveCodexHome(settings), 'auth.json');
	try {
		const stats = await fs.stat(authPath);
		return stats.isFile();
	} catch {
		return false;
	}
}

export async function resolveExecutionAuth(settings: PluginSettings): Promise<ResolvedExecutionAuth | null> {
	const authMode = typeof settings.authMode === 'string' ? settings.authMode : undefined;
	const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';

	if (authMode === 'api-key') {
		if (!apiKey) {
			return null;
		}

		return {
			mode: 'api-key',
			env: { OPENAI_API_KEY: apiKey }
		};
	}

	if (authMode === 'local') {
		if (!(await hasLocalCodexAuth(settings))) {
			return null;
		}

		const codexHome = resolveCodexHome(settings);
		return {
			mode: 'local',
			codexHome,
			env: {
				CODEX_HOME: codexHome
			}
		};
	}

	if (apiKey) {
		return {
			mode: 'api-key',
			env: { OPENAI_API_KEY: apiKey }
		};
	}

	if (await hasLocalCodexAuth(settings)) {
		const codexHome = resolveCodexHome(settings);
		return {
			mode: 'local',
			codexHome,
			env: {
				CODEX_HOME: codexHome
			}
		};
	}

	return null;
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
	state: PipelineState<CodexStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<CodexStepId> } {
	let currentState = state ?? initializeState();

	for (const [stepId, stepState] of currentState.steps) {
		if (stepState.status === 'running') {
			currentState = updateStepState(currentState, stepId, 'failed', error.message);
			break;
		}
	}

	currentState = {
		...currentState,
		isRunning: false,
		completedAt: Date.now()
	};

	return {
		state: currentState,
		result: buildErrorPipelineResult(error, {
			outputs: createEmptyPipelineOutputs(),
			duration: Date.now() - startTime,
			stepsCompleted: currentState.completedSteps.length,
			totalSteps: CODEX_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<CodexStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<CodexStepId> } {
	const currentState: PipelineState<CodexStepId> = {
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
			totalSteps: CODEX_STEP_IDS.length,
			state: currentState
		})
	};
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
