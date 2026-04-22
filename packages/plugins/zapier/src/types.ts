/** Step IDs for the Zapier pipeline. */
export type ZapierStepId =
	| 'validate-zapier'
	| 'prepare-payload'
	| 'execute-action'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const ZAPIER_STEP_IDS: readonly ZapierStepId[] = [
	'validate-zapier',
	'prepare-payload',
	'execute-action',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/** Plugin constants */
export const DEFAULT_BASE_URL = 'https://actions.zapier.com';
export const DEFAULT_TARGET_ITEMS = 50;
export const DEFAULT_TIMEOUT_MS = 180000;

/** Action type enum exposed by the Zapier SDK. */
export type ZapierActionType =
	| 'search'
	| 'filter'
	| 'read'
	| 'read_bulk'
	| 'run'
	| 'search_and_write'
	| 'search_or_write'
	| 'write';

export const ZAPIER_ACTION_TYPES: readonly ZapierActionType[] = [
	'search',
	'filter',
	'read',
	'read_bulk',
	'run',
	'search_and_write',
	'search_or_write',
	'write'
] as const;

/** Identifies a single Zapier action the plugin will invoke. */
export interface ZapierActionRef {
	appKey: string;
	actionType: ZapierActionType;
	actionKey: string;
	authenticationId: number;
}

/** How the plugin should interpret the action's `data` payload. */
export type ZapierResultShape = 'structured' | 'native';

/** Field mapping used when the action returns native records instead of { items: [...] }. */
export interface ZapierFieldMapping {
	nameField: string;
	urlField?: string;
	descriptionField?: string;
	categoryField?: string;
	tagsField?: string;
	imageField?: string;
	brandField?: string;
	contentField?: string;
}

/** Data source types for passing data to the Zapier action. */
export type DataSourceType = 'inline' | 'github-repo';

/** Input payload sent as `inputs` to the Zapier action. */
export interface ZapierWorkflowInput {
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
	actionParams?: Record<string, unknown>;
}

/** Structured directory payload returned by a custom Zap (mirrors sim-ai). */
export interface ZapierWorkflowOutput {
	items: ZapierOutputItem[];
	categories?: Array<{ name: string; description?: string }>;
	tags?: Array<{ name: string }>;
	brands?: Array<{ name: string; url?: string }>;
}

export interface ZapierOutputItem {
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

/** Resolved settings for the Zapier plugin. */
export interface ZapierSettings {
	accessToken?: string;
	clientId?: string;
	clientSecret?: string;
	baseUrl?: string;
	defaultAppKey?: string;
	defaultActionType?: ZapierActionType;
	defaultActionKey?: string;
	defaultAuthenticationId?: number;
	timeoutMs: number;
	resultShape: ZapierResultShape;
	fieldMapping: ZapierFieldMapping;
}

/** Metrics specific to Zapier execution. */
export interface ZapierPipelineMetrics {
	appKey: string;
	actionType: ZapierActionType;
	actionKey: string;
	authenticationId: number;
	resultShape: ZapierResultShape;
	zapierDuration?: number;
	itemsReturned?: number;
}
