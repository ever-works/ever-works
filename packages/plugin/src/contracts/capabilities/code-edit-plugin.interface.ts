import type { IPlugin } from '../plugin.js';

/**
 * Code-edit capability — produced by AI agents that run inside a checked-out
 * workspace and modify the codebase in place (e.g. claude-code, codex,
 * gemini-cli, opencode).
 *
 * Distinct from `IPipelinePlugin` (which produces *items*). A single plugin
 * MAY implement both — the underlying binary is the same; the operation is
 * different. Plugins advertise this via `capabilities: ['pipeline', 'code-edit']`
 * in their manifest.
 *
 * Output is intentionally minimal — file paths + summary + raw stdout/stderr.
 * The orchestrator (`CodeUpdateGeneratorService`) handles git operations,
 * commit messages, PR creation; the plugin's only job is "edit the
 * workspace to satisfy the prompt".
 */
export interface ICodeEditPlugin extends IPlugin {
	readonly providerName?: string;

	executeCodeEdit(request: CodeEditRequest, options?: CodeEditOptions): Promise<CodeEditResult>;

	/** Optional cancel — invoked when the controller aborts the run. */
	cancelCodeEdit?(): Promise<void>;
}

export interface CodeEditRequest {
	/**
	 * Absolute path to a checked-out git working directory. The plugin runs
	 * inside this directory and is free to edit any file. The caller is
	 * responsible for cloning + branch checkout BEFORE invocation, and for
	 * commit + push AFTER invocation.
	 */
	readonly workspaceDir: string;

	/** Natural-language prompt describing the desired change. */
	readonly prompt: string;

	/** Model alias or full id (provider-specific, optional). */
	readonly model?: string;

	/**
	 * Maximum agentic turns (provider-specific cap). When omitted the plugin
	 * uses its own default. Higher = more autonomy + cost.
	 */
	readonly maxTurns?: number;

	/** Hard budget cap in USD (best-effort, providers ignore if unsupported). */
	readonly maxBudgetUsd?: number;

	/**
	 * Plugin-specific extra configuration — same shape as
	 * `GenerationRequest.config` for pipeline plugins. Lets the form-schema
	 * surface drive per-plugin knobs without growing this interface.
	 */
	readonly config?: Record<string, unknown>;

	/**
	 * Optional scope of paths the plugin is allowed to touch. Plugins may
	 * surface this to their underlying CLI as an allow-list or simply
	 * surface a warning in the system prompt. Defaults to "anywhere".
	 */
	readonly allowedPaths?: readonly string[];
}

export interface CodeEditOptions {
	readonly signal?: AbortSignal;
	readonly onProgress?: CodeEditProgressCallback;
	/** Optional log sink (per-line stdout/stderr from the underlying agent). */
	readonly onLogLine?: (stream: 'stdout' | 'stderr', line: string) => void;
	/**
	 * Forwarded execution context (token resolution, plugin settings).
	 * The agent package wraps this; plugins read whatever they need.
	 */
	readonly execContext?: Record<string, unknown>;
}

export interface CodeEditResult {
	readonly success: boolean;
	/** Short human-readable summary of what the agent did. */
	readonly summary: string;
	/**
	 * Files the agent reports touching. Plugins may compute this from a
	 * `git status` after the run if the agent doesn't surface it directly.
	 */
	readonly filesChanged: readonly CodeEditFileChange[];
	/** Number of agentic turns consumed. */
	readonly turnsUsed?: number;
	/** Approximate cost in USD when the provider surfaces it. */
	readonly costUsd?: number;
	readonly duration: number;
	readonly error?: string;
	readonly warnings?: readonly string[];
	/** Provider-specific extra payload (telemetry, raw response, etc.). */
	readonly extra?: Record<string, unknown>;
}

export interface CodeEditFileChange {
	readonly path: string;
	readonly status: 'added' | 'modified' | 'deleted';
	readonly additions?: number;
	readonly deletions?: number;
}

export interface CodeEditProgress {
	/** 0-100 progress estimate when the plugin can compute one. */
	readonly percent?: number;
	readonly turn?: number;
	readonly totalTurns?: number;
	readonly message?: string;
}

export type CodeEditProgressCallback = (progress: CodeEditProgress) => void;

/**
 * Type guard for plugins implementing the code-edit capability.
 */
export function isCodeEditPlugin(plugin: IPlugin): plugin is ICodeEditPlugin {
	return plugin.capabilities.includes('code-edit');
}
