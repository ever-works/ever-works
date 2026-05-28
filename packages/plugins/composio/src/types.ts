/** Step IDs for the Composio pipeline. */
export type ComposioStepId =
	| 'validate-composio'
	| 'prepare-payload'
	| 'execute-tool'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const COMPOSIO_STEP_IDS: readonly ComposioStepId[] = [
	'validate-composio',
	'prepare-payload',
	'execute-tool',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/** Plugin constants */
export const DEFAULT_BASE_URL = 'https://backend.composio.dev/api/v3';
export const DEFAULT_TARGET_ITEMS = 50;
export const DEFAULT_TIMEOUT_MS = 180000;

/**
 * Identifies a single Composio tool the plugin will invoke.
 *
 * Composio v3 references a tool by its **slug** (e.g. `GMAIL_SEND_EMAIL`,
 * `GITHUB_CREATE_ISSUE`, `SLACK_SEND_MESSAGE`). The slug is unique across
 * toolkits, so `toolkit` is informational only — used for connected-account
 * validation and surfaced in metrics.
 */
export interface ComposioToolRef {
	toolkit: string;
	toolSlug: string;
	/**
	 * The Composio `user_id` whose connected account the tool runs against.
	 * The plugin defaults this to the Ever Works user ID; the user can pin a
	 * different value (e.g. an email) in plugin settings.
	 */
	userId: string;
}

/**
 * How the plugin should interpret the tool's response payload.
 *  - `structured`: the tool returns `{ items: [...] }` (cleanest for custom tools).
 *  - `native`: raw records projected onto work items via a field mapping.
 *  - `side-effect`: fire-and-forget (e.g. send email, post message) — no items.
 */
export type ComposioResultShape = 'structured' | 'native' | 'side-effect';

/** Field mapping used when the tool returns native records instead of { items: [...] }. */
export interface ComposioFieldMapping {
	nameField: string;
	urlField?: string;
	descriptionField?: string;
	categoryField?: string;
	tagsField?: string;
	imageField?: string;
	brandField?: string;
	contentField?: string;
}

/** Data source types for passing data to the Composio tool. */
export type DataSourceType = 'inline' | 'github-repo';

/** Input payload sent as `arguments` to the Composio tool. */
export interface ComposioToolInput {
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
	toolParams?: Record<string, unknown>;
}

/** Structured work payload returned by a custom Composio tool (mirrors sim-ai / zapier). */
export interface ComposioToolOutput {
	items: ComposioOutputItem[];
	categories?: Array<{ name: string; description?: string }>;
	tags?: Array<{ name: string }>;
	brands?: Array<{ name: string; url?: string }>;
}

export interface ComposioOutputItem {
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

/** Resolved settings for the Composio plugin. */
export interface ComposioSettings {
	apiKey?: string;
	baseUrl?: string;
	defaultUserId?: string;
	defaultToolkit?: string;
	defaultToolSlug?: string;
	timeoutMs: number;
	resultShape: ComposioResultShape;
	fieldMapping: ComposioFieldMapping;
}

/** Metrics specific to Composio execution. */
export interface ComposioPipelineMetrics {
	toolkit: string;
	toolSlug: string;
	userId: string;
	resultShape: ComposioResultShape;
	composioDuration?: number;
	itemsReturned?: number;
}

/** Shape of a Composio connected account (subset of the v3 response). */
export interface ComposioConnectedAccount {
	id: string;
	status: 'INITIATED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'FAILED' | string;
	toolkit?: { slug: string } | undefined;
	user_id?: string;
}

/** Shape of a Composio toolkit catalog entry (subset of the v3 response). */
export interface ComposioToolkitEntry {
	slug: string;
	name: string;
	description?: string;
	categories?: string[];
	auth_schemes?: string[];
}
