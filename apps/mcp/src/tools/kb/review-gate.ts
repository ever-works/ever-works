import { mcpPrivilegedToolsEnabled } from '../../openapi-tools/privileged-tools.js';

/**
 * Works-security (2026-10-18) — what an MCP-written Knowledge Base document
 * carries.
 *
 * Every accepted KB document rides in the always-injected `<kb>` context of
 * the owner's later agent runs. A document written through this server was
 * written by a model (possibly one steered by content it read), so it lands
 * `proposed` and agent-authored: the M7 review gate holds it out of agent
 * context until a person accepts it in the app. The API applies the same rule
 * to every non-session credential (`KB_NON_SESSION_WRITES_PROPOSED`); this is
 * the client-side half, for the case where this server forwards a session JWT.
 *
 * `MCP_PRIVILEGED_TOOLS=true` (the operator trusts this server's clients with
 * owner-level powers) stops marking writes here; the API then decides alone.
 */

export interface KbAuthorshipFields {
	reviewState?: 'proposed';
	source?: 'agent';
}

/** Fields added to a `kb.create` body. */
export function kbCreateAuthorship(enabled: boolean = mcpPrivilegedToolsEnabled()): KbAuthorshipFields {
	return enabled ? {} : { reviewState: 'proposed', source: 'agent' };
}

/** Fields added to a `kb.update` patch: only a content change re-enters review. */
export function kbUpdateAuthorship(
	patch: { title?: unknown; body?: unknown; description?: unknown },
	enabled: boolean = mcpPrivilegedToolsEnabled()
): KbAuthorshipFields {
	if (enabled) return {};
	const changesContent = patch.title !== undefined || patch.body !== undefined || patch.description !== undefined;
	return changesContent ? { reviewState: 'proposed' } : {};
}
