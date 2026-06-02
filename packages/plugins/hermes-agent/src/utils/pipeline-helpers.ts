import type {
	PipelineMetrics,
	PipelineProgressCallback,
	PipelineResult,
	PipelineState,
	PipelineStepDefinition,
	PluginContext,
	PluginSettings,
	ResolvedSettings,
	StepState,
	StepStatus
} from '@ever-works/plugin';
import { buildCancelledPipelineResult, buildErrorPipelineResult, createEmptyPipelineOutputs } from '@ever-works/plugin';
import type { HermesAgentStepId } from '../types.js';
import { HERMES_AGENT_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';

export interface HermesRuntimeSettings {
	profile: string;
	provider?: string;
	model?: string;
	toolsets: string;
	skills?: string;
	maxTurns: number;
	binaryPath?: string;
	yolo: boolean;
}

function initializePipelineState<TStepId extends string>(
	stepDefinitions: readonly PipelineStepDefinition<TStepId>[]
): PipelineState<TStepId> {
	const steps = new Map<TStepId, StepState<TStepId>>();
	for (const definition of stepDefinitions) {
		steps.set(definition.id, { definition, status: 'pending' });
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

function updatePipelineStepState<TStepId extends string>(
	state: PipelineState<TStepId>,
	stepId: TStepId,
	status: StepStatus,
	error?: string
): PipelineState<TStepId> {
	const existing = state.steps.get(stepId);
	if (!existing) {
		return state;
	}

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

	return {
		...state,
		steps,
		currentStep: status === 'running' ? stepId : state.currentStep === stepId ? undefined : state.currentStep,
		completedSteps:
			status === 'completed' || status === 'skipped' ? [...state.completedSteps, stepId] : state.completedSteps,
		failedSteps: status === 'failed' ? [...state.failedSteps, stepId] : state.failedSteps
	};
}

async function resolveScopedSettings(
	context: PluginContext | null,
	userId: string,
	workId: string
): Promise<PluginSettings> {
	if (!context) {
		return {};
	}

	const loadResolvedSettings = async (
		scope: 'global' | 'user' | 'work',
		scopeId?: string
	): Promise<ResolvedSettings> => {
		try {
			return await context.getResolvedSettings(scope, scopeId);
		} catch {
			return {};
		}
	};

	const [globalSettings, userSettings, workSettings] = await Promise.all([
		loadResolvedSettings('global'),
		loadResolvedSettings('user', userId),
		loadResolvedSettings('work', workId)
	]);

	const merged: PluginSettings = {};

	for (const [key, entry] of Object.entries(globalSettings)) {
		if (entry?.value !== undefined && entry?.value !== null) {
			merged[key] = entry.value;
		}
	}

	for (const [key, entry] of Object.entries(userSettings)) {
		if (entry?.source === 'user' && entry.value !== undefined && entry.value !== null) {
			merged[key] = entry.value;
		}
	}

	for (const [key, entry] of Object.entries(workSettings)) {
		if (entry?.source === 'work' && entry.value !== undefined && entry.value !== null) {
			merged[key] = entry.value;
		}
	}

	return merged;
}

export function initializeState(): PipelineState<HermesAgentStepId> {
	return initializePipelineState(STEP_DEFINITIONS);
}

export function updateStepState(
	state: PipelineState<HermesAgentStepId>,
	stepId: HermesAgentStepId,
	status: StepStatus,
	error?: string
): PipelineState<HermesAgentStepId> {
	return updatePipelineStepState(state, stepId, status, error);
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
		totalSteps: HERMES_AGENT_STEP_IDS.length,
		currentStepName: stepName,
		message,
		itemsProcessed
	});
}

export async function resolveSettings(
	context: PluginContext | null,
	userId: string,
	workId: string
): Promise<PluginSettings> {
	return resolveScopedSettings(context, userId, workId);
}

export function buildMetrics(
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

export function finalizeCompletedState(state: PipelineState<HermesAgentStepId>): PipelineState<HermesAgentStepId> {
	return {
		...state,
		isRunning: false,
		isCancelled: false,
		currentStep: undefined,
		completedAt: Date.now()
	};
}

export function buildErrorResult(
	state: PipelineState<HermesAgentStepId> | null,
	error: Error,
	startTime: number
): { result: PipelineResult; state: PipelineState<HermesAgentStepId> } {
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
			totalSteps: HERMES_AGENT_STEP_IDS.length,
			failedStep: currentState.failedSteps[currentState.failedSteps.length - 1],
			state: currentState
		})
	};
}

export function buildCancelledResult(
	state: PipelineState<HermesAgentStepId> | null,
	startTime: number
): { result: PipelineResult; state: PipelineState<HermesAgentStepId> } {
	const currentState: PipelineState<HermesAgentStepId> = {
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
			totalSteps: HERMES_AGENT_STEP_IDS.length,
			state: currentState
		})
	};
}

// Security: the resolved `binaryPath` is passed straight to spawn() in
// process-runner.ts / binary-manager.ts as the executable run for every Hermes
// generation. The primary defence lives on the schema: the `x-envVar` binding
// makes filterEnvVarFields strip binaryPath from tenant settings writes, so only
// the host operator can set it. This adds defence-in-depth at the point of use:
// reject any value containing shell-metacharacter, glob, quote, or control
// characters that have no place in a real executable path. spawn() is invoked
// WITHOUT shell:true, so these cannot be interpreted as a command line today,
// but rejecting them blocks argument smuggling and keeps the plugin safe if a
// shell-mode spawn is ever introduced. Legitimate paths are preserved unchanged
// (`hermes`, `/usr/local/bin/hermes`, relative `../bin/hermes`); a suspicious
// value falls back to `undefined` so the safe `hermes` default applies
// downstream, identical to leaving the setting unset.
const UNSAFE_BINARY_PATH_CHARS = [
	';',
	'|',
	'&',
	'$',
	'`',
	'(',
	')',
	'<',
	'>',
	'{',
	'}',
	'[',
	']',
	'!',
	'?',
	'*',
	"'",
	'"',
	'\n',
	'\r',
	'\t',
	'\0'
];

function sanitizeBinaryPath(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	if (UNSAFE_BINARY_PATH_CHARS.some((char) => trimmed.includes(char))) {
		return undefined;
	}

	return trimmed;
}

export function resolveHermesRuntimeSettings(settings: Record<string, unknown>): HermesRuntimeSettings {
	return {
		profile: typeof settings.profile === 'string' && settings.profile.trim() ? settings.profile.trim() : 'default',
		provider:
			typeof settings.provider === 'string' && settings.provider.trim() ? settings.provider.trim() : undefined,
		model: typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : undefined,
		toolsets:
			typeof settings.toolsets === 'string' && settings.toolsets.trim()
				? settings.toolsets.trim()
				: 'web,terminal,skills',
		skills: typeof settings.skills === 'string' && settings.skills.trim() ? settings.skills.trim() : undefined,
		maxTurns:
			typeof settings.maxTurns === 'number' && Number.isFinite(settings.maxTurns)
				? Math.max(1, Math.floor(settings.maxTurns))
				: 90,
		binaryPath: sanitizeBinaryPath(settings.binaryPath),
		yolo: settings.yolo !== false
	};
}
