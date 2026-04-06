import type { PipelineMetrics } from '@ever-works/plugin';

// Shared filesystem sandbox interface (was duplicated in file-tools.ts and validate-json-tools.ts)
export interface WrappedSandbox {
	readFile(path: string): Promise<string>;
	writeFiles(files: Array<{ path: string; content: string }>): Promise<void>;
}

// Token usage from a single generateText call (matches Vercel AI SDK LanguageModelUsage)
export interface AgentTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

// Breakdown: parent orchestrator vs workers vs combined total
export interface TokenUsageBreakdown {
	parent: AgentTokenUsage;
	workers: AgentTokenUsage;
	total: AgentTokenUsage;
}

// Extended PipelineMetrics with token usage
export interface AgentPipelineMetrics extends PipelineMetrics {
	tokenUsage?: TokenUsageBreakdown;
}

// Mutable accumulator — created once per execution, passed to all workers
export class TokenUsageAccumulator {
	private _parent: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	private _workers: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

	addParent(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
		this._parent.inputTokens += usage.inputTokens ?? 0;
		this._parent.outputTokens += usage.outputTokens ?? 0;
		this._parent.totalTokens += usage.totalTokens ?? 0;
	}

	addWorker(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
		this._workers.inputTokens += usage.inputTokens ?? 0;
		this._workers.outputTokens += usage.outputTokens ?? 0;
		this._workers.totalTokens += usage.totalTokens ?? 0;
	}

	toBreakdown(): TokenUsageBreakdown {
		return {
			parent: { ...this._parent },
			workers: { ...this._workers },
			total: {
				inputTokens: this._parent.inputTokens + this._workers.inputTokens,
				outputTokens: this._parent.outputTokens + this._workers.outputTokens,
				totalTokens: this._parent.totalTokens + this._workers.totalTokens
			}
		};
	}
}

export type AgentPipelineStepId =
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const AGENT_PIPELINE_STEP_IDS: readonly AgentPipelineStepId[] = [
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

export function isAgentPipelineStepId(value: string): value is AgentPipelineStepId {
	return (AGENT_PIPELINE_STEP_IDS as readonly string[]).includes(value);
}

export const DEFAULT_MAX_STEPS = 24;
export const DEFAULT_CONTEXT_BUDGET_RATIO = 0.8;

export const WORKER_PROMPT_OVERHEAD_TOKENS = 2000;
export const MIN_CHUNK_CHARS = 4000;

/**
 * Hard cap on chunk size for extraction workers.
 * Prevents huge documents (e.g., a 200K-char README with 3000+ items) from
 * landing in a single chunk where the step limit can't process them all.
 * At ~30K chars, a structured list chunk typically contains 50–150 items.
 */
export const MAX_CHUNK_CHARS = 30_000;

/**
 * Returns the content-budget ratio for the extraction worker based on model context size.
 * Smaller models get a lower ratio so more tokens are available for the JSON response.
 */
export function getWorkerContentBudgetRatio(maxContextTokens: number): number {
	if (maxContextTokens <= 16_000) return 0.35;
	if (maxContextTokens <= 32_000) return 0.4;
	if (maxContextTokens <= 64_000) return 0.5;
	return 0.55;
}

/**
 * Calculates the worker step limit for a single chunk based on its character count.
 * Larger chunks with more extractable items get proportionally more steps.
 */
export const BASE_STEPS_PER_CHUNK = 40;
export const STEPS_PER_ESTIMATED_ITEM = 2;
export const MAX_STEPS_PER_CHUNK = 160;
export const MODIFICATION_WORKER_MAX_STEPS = 80;

export function getStepsPerChunk(chunkChars: number): number {
	// ~200 chars per structured list item (markdown row/entry)
	const estimatedItems = Math.ceil(chunkChars / 200);
	// ~4 steps per item (findItems + createFile + validateItemJson + reasoning)
	const needed = estimatedItems * STEPS_PER_ESTIMATED_ITEM;
	return Math.min(Math.max(needed, BASE_STEPS_PER_CHUNK), MAX_STEPS_PER_CHUNK);
}

export function getWorkerTimeoutMs(stepLimit: number): number {
	const timeoutMinutes = Math.min(8, Math.max(3, Math.ceil(stepLimit / 25)));
	return timeoutMinutes * 60 * 1000;
}
