import type {
	AiModel,
	Brand,
	Category,
	Collection,
	FacadeOptions,
	ItemData,
	PipelineMetrics,
	Tag
} from '@ever-works/plugin';

export type ClaudeManagedAgentStepId =
	| 'configure-managed-agent'
	| 'run-managed-session'
	| 'run-variant-sessions'
	| 'parse-agent-output'
	| 'capture-screenshots';

export const CLAUDE_MANAGED_AGENT_STEP_IDS: readonly ClaudeManagedAgentStepId[] = [
	'configure-managed-agent',
	'run-managed-session',
	'run-variant-sessions',
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

// feat-cma-scale — fan-out + persistent control plane defaults.
export const DEFAULT_FAN_OUT_CONCURRENCY = 5;
export const MIN_VARIANT_SESSIONS = 1;
export const MAX_VARIANT_SESSIONS = 8;
export const PERSISTENT_AGENT_NAME = 'Ever Works Managed Agent';
export const PERSISTENT_ENVIRONMENT_NAME = 'Ever Works Environment';

/**
 * User-scope settings keys used to persist the reusable control plane.
 * All four are `x-hidden` in the settings schema — they are plugin-managed
 * state, not user-editable configuration.
 */
export const SETTING_MANAGED_AGENT_ID = 'managedAgentId';
export const SETTING_MANAGED_AGENT_CONFIG_HASH = 'managedAgentConfigHash';
export const SETTING_MANAGED_ENVIRONMENT_ID = 'managedEnvironmentId';
export const SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH = 'managedEnvironmentConfigHash';

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
	/**
	 * Tracked list cost as reported by the sessions API (`usage.list_cost`),
	 * converted to USD. Undefined when the API did not report a cost.
	 */
	list_cost_usd?: number;
}

export interface ManagedAgentsSession {
	id: string;
	status: 'idle' | 'running' | 'rescheduling' | 'terminated' | string;
	usage?: ManagedAgentsUsage;
}

export interface ManagedAgentsSessionFileResource {
	type: 'file';
	file_id: string;
	mount_path?: string;
}

/**
 * Repository registry (Feature G) — a git repository mounted into the
 * managed session's workspace. Emitted for each of the run agent's
 * attached registry repos (`PipelineExecutionOptions.attachedRepos`).
 */
export interface ManagedAgentsSessionGithubRepositoryResource {
	type: 'github_repository';
	url: string;
	branch?: string;
	mount_path?: string;
}

export type ManagedAgentsSessionResource =
	| ManagedAgentsSessionFileResource
	| ManagedAgentsSessionGithubRepositoryResource;

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
	/** Env files of attached registry repos, uploaded per run (Feature G). */
	uploadedEnvFileIds?: string[];
	createdAgentId?: string;
	createdEnvironmentId?: string;
}

// --- Cloud Managed Agents at scale (feat-cma-scale) ---

/**
 * Serializable runtime-environment descriptor optionally carried on the
 * pipeline execution context by the platform (Environments feature, parallel
 * branch). The plugin reads it defensively — it must NOT import the entity —
 * so every field is optional and unknown shapes degrade to the env-var
 * fallback.
 */
export interface ManagedRuntimeEnvironment {
	name?: string;
	networking?: {
		type?: 'unrestricted' | 'limited' | string;
		allowedHosts?: string[];
		allowPackageManagers?: boolean;
		allowMcpServers?: boolean;
	};
}

/** Desired persistent-agent configuration used for drift detection. */
export interface ManagedAgentDesiredConfig {
	name: string;
	description?: string;
	model: string;
	system: string;
}

/** Networking config sent to `environments.create` / `environments.update`. */
export type ManagedEnvironmentNetworking =
	| { type: 'unrestricted' }
	| {
			type: 'limited';
			allowed_hosts: string[];
			allow_package_managers: boolean;
			allow_mcp_servers: boolean;
	  };

/** One prompt of a fan-out batch. */
export interface ManagedSessionPromptInput {
	id: string;
	prompt: string;
	title?: string;
}

export interface RunManagedSessionsOptions {
	prompts: ManagedSessionPromptInput[];
	agentId: string;
	environmentId: string;
	/** Parallel session limit. Defaults to 5. */
	concurrency?: number;
	/** Hard spend ceiling per session, in USD. Omitted = no budget cap. */
	perSessionBudgetUsd?: number;
	/** Per-session wall-clock ceiling; converted into a poll-attempt bound. */
	timeoutMs?: number;
	resources?: ManagedAgentsSessionResource[];
	pollIntervalMs?: number;
	maxPollAttempts?: number;
	/** Per-session agent overrides (model / system) — avoids version churn. */
	agentOverrides?: { system?: string; model?: string };
	signal?: AbortSignal;
	logger?: { warn(message: string): void };
	/** Archive each session after it finishes (default true). */
	archiveSessions?: boolean;
}

export interface ManagedSessionTokenUsage {
	inputTokens: number;
	outputTokens: number;
	/**
	 * Cached input tokens reported separately by the sessions API. Anthropic
	 * excludes both counters from `input_tokens`, and managed-agent sessions
	 * are cache-heavy by design (the system prompt + workspace context are
	 * re-read on every turn), so they routinely dwarf `inputTokens`.
	 */
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	/** Every billed token: input + output + both cache counters. */
	totalTokens: number;
}

export interface ManagedSessionRunResult {
	id: string;
	status: 'completed' | 'failed' | 'cancelled';
	output?: string;
	sessionId?: string;
	tokens?: ManagedSessionTokenUsage;
	costUsd?: number;
	error?: string;
}

/** Per-session usage summary carried in the pipeline metrics `custom` bag. */
export interface ManagedSessionUsageSummary {
	id: string;
	status: ManagedSessionRunResult['status'];
	sessionId?: string;
	tokens?: ManagedSessionTokenUsage;
	costUsd?: number;
	error?: string;
}

/**
 * Pipeline metrics extended with the two keys the platform's usage seam
 * actually reads (`extractPipelineUsageMetrics` in
 * `packages/agent/src/utils/metrics.util.ts`): `tokenUsage.total.totalTokens`
 * and `totalCost`.
 *
 * Both MUST sit at the metrics ROOT. The plugin runtime helper
 * `buildMetrics()` nests whatever it is given under `metrics.custom`, which
 * the seam never looks at — so token/cost figures placed there are silently
 * dropped from every usage rollup. `custom` stays reserved for the
 * human/debug-facing per-session breakdown.
 */
export interface ManagedAgentPipelineMetrics extends PipelineMetrics {
	tokenUsage?: { total: { totalTokens: number } };
	totalCost?: number;
	custom?: {
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheCreationInputTokens: number;
			cacheReadInputTokens: number;
		};
		sessions: ManagedSessionUsageSummary[];
	};
}

/**
 * Name under which the fan-out service is published on the platform's custom
 * capability registry (`context.registerCustomCapability`), so API-side and
 * Trigger.dev callers can reach `runSessions` without holding the plugin
 * instance: `customCapabilityRegistry.getImplementation(CMA_FAN_OUT_CAPABILITY)`.
 */
export const CMA_FAN_OUT_CAPABILITY = 'claude-managed-agent.fan-out';

/** Implementation shape registered under {@link CMA_FAN_OUT_CAPABILITY}. */
export interface ManagedAgentFanOutCapability {
	runSessions(options: PluginRunSessionsOptions): Promise<ManagedSessionRunResult[]>;
}

/** Options accepted by the plugin-level `runSessions` fan-out entry point. */
export interface PluginRunSessionsOptions {
	prompts: ManagedSessionPromptInput[];
	/** User whose plugin settings (API key, control-plane ids) are used. */
	userId: string;
	/** Optional Work scope for settings resolution. */
	workId?: string;
	concurrency?: number;
	perSessionBudgetUsd?: number;
	timeoutMs?: number;
	resources?: ManagedAgentsSessionResource[];
	signal?: AbortSignal;
}
