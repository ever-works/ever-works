/** Step IDs for the Activepieces pipeline. */
export type ActivepiecesStepId =
	| 'validate-activepieces'
	| 'prepare-payload'
	| 'execute-flow'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const ACTIVEPIECES_STEP_IDS: readonly ActivepiecesStepId[] = [
	'validate-activepieces',
	'prepare-payload',
	'execute-flow',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/** Plugin constants */
export const DEFAULT_BASE_URL = 'https://cloud.activepieces.com/api/v1';
export const DEFAULT_TARGET_ITEMS = 50;

/** Webhook execution mode for Activepieces flows. */
export type WebhookMode = 'sync' | 'async';

/** Data source types for passing data to Activepieces. */
export type DataSourceType = 'inline' | 'github-repo';

/** Input payload sent to Activepieces flow webhook. */
export interface ActivepiecesFlowInput {
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
	flowParams?: Record<string, unknown>;
}

/** Expected output from an Activepieces flow execution. */
export interface ActivepiecesFlowOutput {
	items: ActivepiecesOutputItem[];
	categories?: Array<{ name: string; description?: string }>;
	tags?: Array<{ name: string }>;
	brands?: Array<{ name: string; url?: string }>;
}

/** Single item in Activepieces flow output. */
export interface ActivepiecesOutputItem {
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

/** Resolved settings for the Activepieces plugin. */
export interface ActivepiecesSettings {
	apiKey: string;
	baseUrl: string;
	projectId?: string;
	defaultFlowId?: string;
	webhookMode: WebhookMode;
	timeoutMs: number;
}

/** Metrics specific to Activepieces flow execution. */
export interface ActivepiecesPipelineMetrics {
	flowId: string;
	flowRunId?: string;
	flowDuration?: number;
	webhookMode: WebhookMode;
}

/** Schema of a flow returned by the Activepieces API. */
export interface ActivepiecesFlow {
	id: string;
	created?: string;
	updated?: string;
	projectId?: string;
	externalId?: string;
	status?: 'ENABLED' | 'DISABLED' | string;
	publishedVersionId?: string | null;
	folderId?: string | null;
	metadata?: Record<string, unknown>;
}

/** Schema of a flow run returned by the Activepieces API. */
export interface ActivepiecesFlowRun {
	id: string;
	flowId: string;
	projectId: string;
	flowVersionId?: string;
	status: string;
	environment?: string;
	startTime?: string;
	finishTime?: string;
	stepsCount?: number;
	tags?: string[];
	steps?: Record<string, unknown>;
}

/** Result of executing an Activepieces flow webhook. */
export interface ActivepiecesExecutionResult {
	output: unknown;
	flowRunId?: string;
	flowDuration?: number;
}
