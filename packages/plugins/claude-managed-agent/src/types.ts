import type { AiModel, Brand, Category, Collection, FacadeOptions, ItemData, Tag } from '@ever-works/plugin';

export type ClaudeManagedAgentStepId =
	| 'configure-managed-agent'
	| 'run-managed-session'
	| 'parse-agent-output'
	| 'capture-screenshots';

export const CLAUDE_MANAGED_AGENT_STEP_IDS: readonly ClaudeManagedAgentStepId[] = [
	'configure-managed-agent',
	'run-managed-session',
	'parse-agent-output',
	'capture-screenshots'
] as const;

export const FILES_API_BETA = 'files-api-2025-04-14';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_MAX_POLL_ATTEMPTS = 3600;
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_WORKSPACE_PATH = '/workspace/ever-works';
export const WORKSPACE_SEED_MANIFEST_MOUNT_PATH = '/mnt/session/uploads/ever-works-workspace-seed.json';

export interface ManagedAgentsTextBlock {
	type: 'text' | string;
	text?: string;
}

export interface ManagedAgentsEvent {
	id: string;
	type: string;
	processed_at?: string | null;
	content?: ManagedAgentsTextBlock[];
	stop_reason?: {
		type?: string;
		event_ids?: string[];
	};
	error?:
		| {
				message?: string;
				type?: string;
		  }
		| string;
}

export interface ManagedAgentsListResponse {
	data?: ManagedAgentsEvent[];
	next_page?: string | null;
}

export interface ManagedAgentsUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface ManagedAgentsSession {
	id: string;
	status: 'idle' | 'running' | 'rescheduling' | 'terminated' | string;
	usage?: ManagedAgentsUsage;
}

export interface ManagedAgentsSessionResource {
	type: 'file';
	file_id: string;
	mount_path?: string;
}

export interface ManagedAgentOperationSummary {
	created_files?: string[];
	updated_files?: string[];
	unchanged_seeded_files_count?: number;
}

export interface ManagedAgentsStructuredOutput {
	items: Array<{
		name: string;
		description: string;
		source_url: string;
		category?: string | string[];
		tags?: string[];
		collection?: string;
		brand?: string;
		brand_logo_url?: string | null;
		images?: string[];
		markdown?: string;
		featured?: boolean;
	}>;
	categories?: Array<{ name: string; description?: string }> | string[];
	tags?: Array<{ name: string }> | string[];
	collections?: Array<{ name: string; description?: string }> | string[];
	brands?: Array<{ name: string; website?: string; logo_url?: string }> | string[];
	operations?: ManagedAgentOperationSummary;
	warnings?: string[];
}

export interface NormalizedManagedAgentOutputs {
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	collections: Collection[];
	brands: Brand[];
	extra?: {
		operations?: ManagedAgentOperationSummary;
	};
}

export interface ManagedAgentScreenshotFacade {
	isAvailable(): boolean;
	getSmartImage(
		options: { url: string; itemName: string },
		facadeOptions: FacadeOptions
	): Promise<{ primaryImage?: string }>;
}

function buildClaudeModel(
	id: string,
	name: string,
	description: string,
	maxContextLength: number,
	maxOutputTokens: number
): AiModel {
	return {
		id,
		name,
		description,
		capabilities: {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: true,
			maxContextLength,
			maxOutputTokens
		}
	};
}

export const CLAUDE_MANAGED_AGENT_SUPPORTED_MODELS: readonly AiModel[] = [
	buildClaudeModel(
		'claude-opus-4-7',
		'Claude Opus 4.7',
		'Most capable generally available Claude model for complex reasoning and agentic coding.',
		1000000,
		128000
	),
	buildClaudeModel(
		'claude-opus-4-6',
		'Claude Opus 4.6',
		'Previous Opus generation with strong long-context reasoning and coding performance.',
		1000000,
		128000
	),
	buildClaudeModel(
		'claude-sonnet-4-6',
		'Claude Sonnet 4.6',
		'Best balance of speed and intelligence for managed agent work workflows.',
		1000000,
		64000
	),
	buildClaudeModel(
		'claude-sonnet-4-5-20250929',
		'Claude Sonnet 4.5',
		'Stable earlier Sonnet 4.5 snapshot for teams that want that exact model version.',
		1000000,
		64000
	),
	buildClaudeModel(
		'claude-haiku-4-5',
		'Claude Haiku 4.5',
		'Convenient alias for the current Claude Haiku 4.5 release.',
		200000,
		64000
	),
	buildClaudeModel(
		'claude-haiku-4-5-20251001',
		'Claude Haiku 4.5 (2025-10-01)',
		'Pinned Haiku 4.5 snapshot for lightweight managed agent runs.',
		200000,
		64000
	)
] as const;

export interface WorkspaceSeedFile {
	path: string;
	content: string;
}

export interface WorkspaceSeedManifest {
	workspacePath: string;
	files: WorkspaceSeedFile[];
}

export interface ManagedAgentRunResources {
	sessionId?: string;
	uploadedFileId?: string;
	createdAgentId?: string;
	createdEnvironmentId?: string;
}
