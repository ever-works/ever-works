/** Step IDs for the Make.com pipeline. */
export type MakeStepId =
	| 'validate-make'
	| 'prepare-payload'
	| 'execute-scenario'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const MAKE_STEP_IDS: readonly MakeStepId[] = [
	'validate-make',
	'prepare-payload',
	'execute-scenario',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/** Plugin constants */
export const DEFAULT_BASE_URL = 'https://us2.make.com/api/v2';
export const DEFAULT_TARGET_ITEMS = 50;
export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_MAX_POLL_ATTEMPTS = 600;

/** Execution modes supported by the plugin */
export type MakeExecutionMode = 'webhook' | 'scenario';

/** Data source types for passing data to Make.com */
export type DataSourceType = 'inline' | 'github-repo';

/** Input payload sent to Make.com scenario or webhook */
export interface MakeWorkflowInput {
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
	scenarioParams?: Record<string, unknown>;
}

/** Expected output from a Make.com scenario/webhook */
export interface MakeWorkflowOutput {
	items: MakeOutputItem[];
	categories?: Array<{ name: string; description?: string }>;
	tags?: Array<{ name: string }>;
	brands?: Array<{ name: string; url?: string }>;
}

/** Single item in Make.com workflow output */
export interface MakeOutputItem {
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

/** Resolved settings for the Make.com plugin */
export interface MakeSettings {
	apiKey: string;
	baseUrl: string;
	teamId?: string;
	organizationId?: string;
	defaultScenarioId?: string;
	defaultHookId?: string;
	defaultWebhookUrl?: string;
	executionMode: MakeExecutionMode;
	timeoutMs: number;
	pollIntervalMs: number;
	maxPollAttempts: number;
}

/** Metrics specific to Make.com execution */
export interface MakePipelineMetrics {
	executionMode: MakeExecutionMode;
	scenarioId?: string;
	hookId?: string;
	executionId?: string;
	makeDuration?: number;
}

/** Shape of a Make.com scenario returned by the API */
export interface MakeScenarioSummary {
	id: number | string;
	name: string;
	teamId?: number;
	isActive?: boolean;
	isPaused?: boolean;
	hookId?: number | string;
	description?: string;
}

/** Shape of a Make.com hook returned by the API */
export interface MakeHookSummary {
	id: number | string;
	name: string;
	type?: string;
	url?: string;
	teamId?: number;
	typeName?: string;
}

/** Raw response from running a scenario */
export interface MakeScenarioRunResponse {
	executionId?: string;
	statusUrl?: string;
	status?: string;
	output?: unknown;
	result?: unknown;
	data?: unknown;
}

/** Raw response from polling scenario execution status */
export interface MakeExecutionStatus {
	status: 'pending' | 'running' | 'success' | 'error' | 'stopped' | string;
	output?: unknown;
	result?: unknown;
	data?: unknown;
	error?: string;
	imtId?: string;
}
