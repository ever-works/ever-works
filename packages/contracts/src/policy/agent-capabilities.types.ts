import type { ResolvedToolGrants, ToolGrantDecision } from './tool-grant.types.js';

/**
 * Agent Capabilities tab — the CONTRACT half of the composed
 * `GET /api/agents/:id/capabilities` read.
 *
 * The payload unifies three previously separate answers about one Agent:
 *
 *   1. WHAT tools exist for it (the static catalog derived from
 *      `AgentToolService.resolveAllowedTools` — see
 *      `@ever-works/agent/agents` `buildAgentToolCatalog`);
 *   2. WHICH of them the Agent may actually call right now — the
 *      per-Agent permission flags AND the tool-grant matrix folded
 *      tenant → organization → Work → Agent (audit item G4);
 *   3. the Agent's `initScript` (advisory v1 — persisted now, consumed
 *      by execution paths as they gain bootstrap support).
 *
 * Everything here is a pure type so the API composes it and the web UI
 * renders it from the same definitions.
 */

/** Where a tool in the catalog is assembled from. */
export type AgentToolSource = 'builtin' | 'facade' | 'domain';

/**
 * One row of the static tool catalog. `gatedByPermission` names the
 * `AgentPermissions` flag that must be true for the tool to be exposed
 * at all (`null` = always exposed). Kept as a plain string here so the
 * contracts package does not depend on the entity type.
 */
export interface AgentToolCatalogEntry {
	name: string;
	description: string;
	gatedByPermission: string | null;
	source: AgentToolSource;
}

/**
 * One tool row of the composed capabilities payload: the catalog entry
 * plus the two live gates that decide whether the model actually sees it.
 *
 *  - `permissionEnabled` — the per-Agent permission flag (or `true` when
 *    the tool carries no flag).
 *  - `decision` — the tool-grant matrix verdict, with the scope that
 *    decided (`source: 'default' | 'tenant' | 'organization' | 'work' |
 *    'agent'`) so the UI can say WHERE a denial came from.
 *  - `effective` — `permissionEnabled && decision.allowed`, precomputed
 *    server-side so no surface re-derives (and drifts on) the rule.
 */
export interface AgentCapabilityToolRow extends AgentToolCatalogEntry {
	permissionEnabled: boolean;
	decision: ToolGrantDecision;
	effective: boolean;
}

/**
 * The caller's STORED agent-scope grant row (when one exists). The
 * resolve chain reports what each layer contributed; this is the raw row
 * the UI edits — its `id` is what `DELETE /api/tool-grants/:id` needs
 * for "reset to inherited", and `allow`/`deny` are the lists a toggle
 * recomposes before `PUT /api/tool-grants`.
 */
export interface AgentStoredToolGrant {
	id: string;
	allow: string[] | null;
	deny: string[] | null;
	note: string | null;
}

/** Response body of `GET /api/agents/:id/capabilities`. */
export interface AgentCapabilitiesPayload {
	agentId: string;
	/** Advisory v1 — runs at session/workspace bootstrap where supported. */
	initScript: string | null;
	/** The 8 per-Agent permission flags, read-only on this surface. */
	permissions: Record<string, boolean>;
	tools: AgentCapabilityToolRow[];
	/** Full grant-resolution chain (least → most specific) for this Agent. */
	grants: ResolvedToolGrants;
	/** The stored agent-scope grant row, or null when the Agent inherits. */
	agentGrantRow: AgentStoredToolGrant | null;
}

/** Byte cap for `agents.initScript` (matches the task-chat 16 KB posture). */
export const AGENT_INIT_SCRIPT_MAX_BYTES = 16 * 1024;
