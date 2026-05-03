/** Step IDs for the SIM AI pipeline. */
export type SimAiStepId =
	| 'validate-sim'
	| 'prepare-payload'
	| 'execute-workflow'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const SIM_AI_STEP_IDS: readonly SimAiStepId[] = [
	'validate-sim',
	'prepare-payload',
	'execute-workflow',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/** Plugin constants */
export const DEFAULT_BASE_URL = 'https://www.sim.ai';
export const DEFAULT_TARGET_ITEMS = 50;

/** Data source types for passing data to SIM */
export type DataSourceType = 'inline' | 'github-repo';

/** Input payload sent to SIM workflow */
export interface SimWorkflowInput {
	metadata: {
		workId: string;
		workName: string;
		workSlug: string;
		workDescription?: string;
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

/** Resolved settings for the SIM AI plugin */
export interface SimAiSettings {
	apiKey: string;
	baseUrl: string;
	defaultWorkflowId?: string;
	timeoutMs: number;
}

/** Metrics specific to SIM execution */
export interface SimAiPipelineMetrics {
	workflowId: string;
	simDuration?: number;
}
