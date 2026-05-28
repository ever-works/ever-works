import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Agent-memory capability — pluggable persistent memory for AI coding /
 * generation agents.
 *
 * The contract intentionally mirrors the de-facto shape established by the
 * "agentmemory" REST API (Claude Code / Codex / OpenCode / Cursor / MCP
 * clients all hit the same endpoints): sessions wrap a unit of work,
 * observations are appended during the session, and `searchMemory` /
 * `buildContext` produce the payload that gets injected on the next run.
 *
 * Plugins implementing this capability can run:
 *
 * 1. **Locally** alongside the Ever Works API — the default
 *    `@ever-works/agentmemory-plugin` ships with a `baseUrl` defaulting to
 *    `http://localhost:3111`, matching the `agentmemory` npm package's
 *    standalone Node server. The operator runs `npx agentmemory` (or the
 *    optional Helm chart in `.deploy/k8s/agentmemory.optional.yaml`) and
 *    the plugin just connects.
 *
 * 2. **Hosted** behind any HTTPS endpoint — the same plugin accepts a
 *    custom `baseUrl` + bearer `apiKey` (set per-user, per-work, or via
 *    the `AGENTMEMORY_BASE_URL` / `AGENTMEMORY_API_KEY` env vars). This
 *    matches every other "external service" plugin in the repo
 *    (Activepieces, Make, Tavily, ...).
 *
 * Community plugins (mem0, zep, langmem, vector-db-backed homegrown
 * stores) implement the same interface; the `AgentMemoryFacadeService`
 * doesn't care which backend is selected.
 */

/**
 * A single observation recorded against a session — a free-form snippet
 * of text the agent wants to remember. `tags` and `metadata` let backends
 * cluster / filter without baking schema in.
 */
export interface AgentMemoryObservation {
	/** Free-form text — what happened, what was learned. */
	readonly content: string;
	/** Optional human-readable tags ('bug-fix', 'auth', 'webhook'). */
	readonly tags?: readonly string[];
	/** Arbitrary structured metadata (file path, PR number, model used). */
	readonly metadata?: Record<string, unknown>;
}

/**
 * A persisted memory record returned by `searchMemory` and friends. The
 * shape is a superset of `AgentMemoryObservation` plus identity / scoring
 * fields the backend produces.
 */
export interface AgentMemoryRecord extends AgentMemoryObservation {
	/** Stable identifier the backend assigned. */
	readonly id: string;
	/** Owning session id, when the record was captured inside a session. */
	readonly sessionId?: string;
	/** ISO-8601 timestamp the record was written. */
	readonly createdAt: string;
	/** Similarity score from `searchMemory` (0..1). Absent on plain lookups. */
	readonly score?: number;
	/** Project / agent namespace this record belongs to, when the backend
	 *  segments by project (agentmemory does — same SQLite file, many projects). */
	readonly projectId?: string;
}

/**
 * Inputs accepted by `saveMemory`. Either standalone (`sessionId` omitted —
 * the record lives at the project / user level) or tied to an open session.
 */
export interface AgentMemorySaveInput extends AgentMemoryObservation {
	readonly sessionId?: string;
	readonly projectId?: string;
	/** Resolved plugin settings injected by the facade. */
	readonly settings?: PluginSettings;
}

/**
 * Inputs accepted by `searchMemory`. `query` may be free-form text — the
 * backend chooses keyword vs semantic vs hybrid (agentmemory does all
 * three under "smart search"). `agentMemoryRecallLimit` caps the result
 * count; the default is backend-defined (typically 10).
 */
export interface AgentMemorySearchInput {
	readonly query: string;
	readonly limit?: number;
	readonly tags?: readonly string[];
	readonly sessionId?: string;
	readonly projectId?: string;
	readonly settings?: PluginSettings;
}

export interface AgentMemorySearchResponse {
	readonly results: readonly AgentMemoryRecord[];
	/** Optional backend-provided summary (token-compressed digest). */
	readonly summary?: string;
}

/**
 * Inputs to `openSession`. `metadata` is the seed payload the backend
 * stores against the session — what triggered it, who started it, which
 * Work / Agent it belongs to.
 */
export interface AgentMemorySessionInput {
	readonly projectId?: string;
	readonly metadata?: Record<string, unknown>;
	readonly settings?: PluginSettings;
}

export interface AgentMemorySession {
	readonly id: string;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly metadata?: Record<string, unknown>;
	/** Initial context payload some backends ship back on open
	 *  (agentmemory's `/session/start` returns recall + slots + recent ops). */
	readonly context?: string;
}

/**
 * Inputs to `buildContext` — the "give me what's relevant to inject into
 * the next prompt" call. `purpose` lets backends bias the payload (e.g.
 * agentmemory weights bugs higher when `purpose: 'fix-bug'`).
 */
export interface AgentMemoryContextInput {
	readonly query?: string;
	readonly purpose?: string;
	readonly sessionId?: string;
	readonly projectId?: string;
	readonly maxTokens?: number;
	readonly settings?: PluginSettings;
}

export interface AgentMemoryContext {
	/** Text ready to splice into a system prompt. */
	readonly content: string;
	/** Approximate token cost of `content` if the backend reports it. */
	readonly approxTokens?: number;
	/** Records the context was distilled from, when the backend surfaces them. */
	readonly references?: readonly AgentMemoryRecord[];
}

/**
 * Agent-memory plugin interface — capability `agent-memory`.
 *
 * Required surface: open/close session, save / search / build-context.
 * Optional governance surface (`deleteEntry`, `listSessions`, `exportAll`)
 * is opt-in — the facade probes for presence before exposing the
 * corresponding API endpoints.
 */
export interface IAgentMemoryPlugin extends IPlugin {
	/** Backend name for facade identification ('agentmemory', 'mem0', 'zep', ...). */
	readonly providerName: string;

	/**
	 * Open a new agent session. Returns the session id the caller passes
	 * to subsequent `saveMemory` / `searchMemory` / `closeSession` calls.
	 */
	openSession(input: AgentMemorySessionInput): Promise<AgentMemorySession>;

	/** End an open session. Idempotent — closing a closed session is a no-op. */
	closeSession(sessionId: string, settings?: PluginSettings): Promise<void>;

	/** Append an observation. The backend assigns an id and returns the record. */
	saveMemory(input: AgentMemorySaveInput): Promise<AgentMemoryRecord>;

	/**
	 * Smart / semantic search across the user's (or project's, depending
	 * on the resolved scope in settings) memory store.
	 */
	searchMemory(input: AgentMemorySearchInput): Promise<AgentMemorySearchResponse>;

	/**
	 * Build a context payload to inject into the next prompt. Implementations
	 * are free to combine semantic search + recent sessions + pinned slots.
	 */
	buildContext(input: AgentMemoryContextInput): Promise<AgentMemoryContext>;

	// ── Optional governance surface ────────────────────────────────────

	/** Delete a single record by id. Required for GDPR / "forget me" flows. */
	deleteEntry?(id: string, settings?: PluginSettings): Promise<void>;

	/** List sessions for the resolved scope (most recent first). */
	listSessions?(options?: {
		limit?: number;
		projectId?: string;
		settings?: PluginSettings;
	}): Promise<readonly AgentMemorySession[]>;

	/** Export everything for backup / migration. Returns opaque JSON blob. */
	exportAll?(settings?: PluginSettings): Promise<unknown>;
}

/**
 * Facade interface — same shape exposed to API controllers / pipeline steps.
 * The implementation lives in `@ever-works/agent` as `AgentMemoryFacadeService`.
 *
 * `FacadeOptions` is imported by the implementation, not the contract —
 * this file stays in the dep-free `@ever-works/plugin` package.
 */
export interface IAgentMemoryFacade {
	openSession(metadata: Record<string, unknown> | undefined, facadeOptions: unknown): Promise<AgentMemorySession>;
	closeSession(sessionId: string, facadeOptions: unknown): Promise<void>;
	saveMemory(input: Omit<AgentMemorySaveInput, 'settings'>, facadeOptions: unknown): Promise<AgentMemoryRecord>;
	searchMemory(
		input: Omit<AgentMemorySearchInput, 'settings'>,
		facadeOptions: unknown
	): Promise<AgentMemorySearchResponse>;
	buildContext(input: Omit<AgentMemoryContextInput, 'settings'>, facadeOptions: unknown): Promise<AgentMemoryContext>;
	deleteEntry(id: string, facadeOptions: unknown): Promise<void>;
	listSessions(
		options: { limit?: number; projectId?: string } | undefined,
		facadeOptions: unknown
	): Promise<readonly AgentMemorySession[]>;
}

/**
 * Type guard — true when a plugin declares the `agent-memory` capability.
 */
export function isAgentMemoryPlugin(plugin: IPlugin): plugin is IAgentMemoryPlugin {
	return plugin.capabilities.includes('agent-memory');
}
