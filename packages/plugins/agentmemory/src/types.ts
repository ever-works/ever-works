/**
 * Local types shared between the plugin class and the HTTP client.
 *
 * The shape mirrors the `agentmemory` REST API as documented at
 * https://github.com/rohitg00/agentmemory (paths under `/agentmemory/...`).
 *
 * Wire-format notes (verified against the upstream server's request
 * validators):
 *
 *   - Every endpoint requires a `project` field. We map our internal
 *     `projectId` setting to it, falling back to `DEFAULT_PROJECT` when
 *     the operator hasn't set one.
 *   - `/smart-search` uses `topK` (not `limit`).
 *   - `/context` uses `tokenBudget` (not `maxTokens`).
 *   - `/forget` takes `{ project, filter: { ... } }` — the filter
 *     selects observations / sessions / memory ids to delete.
 *   - `/observe` is reserved for auto-capture hooks (`type: 'PostToolUse'`
 *     + `payload`). Free-form saves from the platform always go through
 *     `/remember` instead.
 */

/** Default base URL used when the operator hasn't overridden it. Matches
 *  the npm package `@agentmemory/agentmemory` default (`III_REST_PORT=3111`).
 *  Use the same value in tests so we don't accidentally talk to a real
 *  service. */
export const DEFAULT_BASE_URL = 'http://localhost:3111';

/** Default request timeout (ms). 30s — generous enough for the embedding
 *  + LLM pass agentmemory may run on `smart-search`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard upper bound. Mirrors `settingsSchema.timeoutMs.maximum`. */
export const MAX_TIMEOUT_MS = 120_000;

/** Default project namespace when no per-work / per-user value is set.
 *  agentmemory rejects requests with an empty `project`, so we MUST send
 *  something. `ever-works` is a sane fallback that keeps the platform's
 *  data partitioned from anyone else sharing the same server. */
export const DEFAULT_PROJECT = 'ever-works';

/** Env vars the plugin probes when the resolved settings are empty. The
 *  plugin settings service does NOT auto-inject these (that would
 *  require `x-envVar` on the schema, which would also lock the field
 *  out of the admin UI — see Codex review on PR #1073). We fall back
 *  to env manually in `resolveSettings`. */
export const ENV_VAR_BASE_URL = 'AGENTMEMORY_BASE_URL';
export const ENV_VAR_API_KEY = 'AGENTMEMORY_API_KEY';
export const ENV_VAR_PROJECT = 'AGENTMEMORY_PROJECT';

/**
 * Settings the plugin reads after the facade has resolved the user / work
 * / admin hierarchy. Everything is optional — the plugin works against a
 * vanilla `npx agentmemory` localhost server with zero configuration.
 */
export interface AgentmemorySettings {
	/** Override the REST endpoint (e.g. https://mem.acme.example). */
	baseUrl?: string;
	/** Bearer token (the agentmemory server reads `AGENTMEMORY_SECRET`). */
	apiKey?: string;
	/** Project namespace inside the shared SQLite store. Plugins set it
	 *  per-Work so different Works don't see each other's observations.
	 *  Resolved with fallback to `DEFAULT_PROJECT` when undefined. */
	project?: string;
	/** Request timeout override. */
	timeoutMs?: number;
}

/** Raw shape returned by `POST /agentmemory/session/start`. */
export interface AgentmemoryRawSession {
	readonly id?: string;
	readonly sessionId?: string;
	readonly session_id?: string;
	readonly startedAt?: string;
	readonly started_at?: string;
	readonly endedAt?: string;
	readonly ended_at?: string;
	readonly metadata?: Record<string, unknown>;
	readonly context?: string;
	readonly recall?: string;
}

/** Raw shape returned by `POST /agentmemory/remember`. */
export interface AgentmemoryRawRecord {
	readonly id?: string;
	readonly observationId?: string;
	readonly observation_id?: string;
	readonly memoryId?: string;
	readonly memory_id?: string;
	readonly content?: string;
	readonly text?: string;
	readonly tags?: readonly string[];
	readonly metadata?: Record<string, unknown>;
	readonly sessionId?: string;
	readonly session_id?: string;
	readonly project?: string;
	readonly projectId?: string;
	readonly project_id?: string;
	readonly createdAt?: string;
	readonly created_at?: string;
	readonly score?: number;
	readonly similarity?: number;
}

/** Raw shape returned by `POST /agentmemory/smart-search`. */
export interface AgentmemoryRawSearchResponse {
	readonly results?: readonly AgentmemoryRawRecord[];
	readonly matches?: readonly AgentmemoryRawRecord[];
	readonly hits?: readonly AgentmemoryRawRecord[];
	readonly summary?: string;
	readonly digest?: string;
}

/** Raw shape returned by `POST /agentmemory/context`. */
export interface AgentmemoryRawContext {
	readonly content?: string;
	readonly context?: string;
	readonly text?: string;
	readonly approxTokens?: number;
	readonly approx_tokens?: number;
	readonly references?: readonly AgentmemoryRawRecord[];
}
