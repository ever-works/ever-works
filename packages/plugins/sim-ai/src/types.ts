/**
 * Step IDs for the SIM AI pipeline.
 * All steps run sequentially.
 */
export type SimAiStepId =
	| 'validate-sim'
	| 'prepare-payload'
	| 'execute-workflow'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

/**
 * All step IDs as an array for iteration
 */
export const SIM_AI_STEP_IDS: readonly SimAiStepId[] = [
	'validate-sim',
	'prepare-payload',
	'execute-workflow',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/**
 * Type guard for SimAiStepId
 */
export function isSimAiStepId(value: string): value is SimAiStepId {
	return (SIM_AI_STEP_IDS as readonly string[]).includes(value);
}

/** Plugin constants */
export const SIM_AI_PLUGIN_ID = 'sim-ai';
export const DEFAULT_BASE_URL = 'https://www.sim.ai';
export const DEFAULT_POLLING_INTERVAL_MS = 5000;
export const DEFAULT_ASYNC_TIMEOUT_MS = 600_000; // 10 minutes
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_TARGET_ITEMS = 50;

/** Data source types for passing data to SIM */
export type DataSourceType = 'inline' | 'github-repo';

/** Input payload sent to SIM workflow */
export interface SimWorkflowInput {
	metadata: {
		directoryId: string;
		directoryName: string;
		directorySlug: string;
		directoryDescription?: string;
		prompt?: string;
		generationMethod?: string;
		targetItems: number;
	};
	existingSummary?: {
		totalItems: number;
		categories: string[];
		tags: string[];
		sampleItems: Array<{ name: string; url?: string }>;
	};
	dataSource?: {
		type: DataSourceType;
		repoUrl?: string;
		accessToken?: string;
		branch?: string;
		path?: string;
	};
	workflowParams?: Record<string, unknown>;
}

/** Expected output from SIM workflow */
export interface SimWorkflowOutput {
	items: SimOutputItem[];
	categories?: Array<{ name: string; description?: string }>;
	tags?: Array<{ name: string }>;
	brands?: Array<{ name: string; url?: string }>;
}

/** Single item in SIM workflow output */
export interface SimOutputItem {
	name: string;
	description?: string;
	url?: string;
	source_url?: string;
	content?: string;
	category?: string;
	tags?: string[];
	brand?: string;
	images?: string[];
	metadata?: Record<string, unknown>;
}

/** Event trigger configuration for a single event */
export interface EventTriggerConfig {
	workflowId: string;
	enabled: boolean;
}

/** Resolved settings for the SIM AI plugin */
export interface SimAiSettings {
	apiKey: string;
	baseUrl: string;
	defaultWorkflowId?: string;
	executionMode: 'sync' | 'async';
	asyncPollingIntervalMs: number;
	asyncTimeoutMs: number;
	maxRetries: number;
	eventTriggers?: {
		onGenerationCompleted?: EventTriggerConfig;
	};
}

/** Metrics specific to SIM execution */
export interface SimAiPipelineMetrics {
	simDuration?: number;
	pollingAttempts?: number;
	simCost?: number;
	workflowId: string;
	executionMode: 'sync' | 'async';
	taskId?: string;
}
