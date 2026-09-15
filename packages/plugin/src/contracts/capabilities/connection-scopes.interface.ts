import type { ConnectionScopePresetDeclaration, ConnectionScopePresetId } from '@ever-works/contracts';
import type { IPlugin } from '../plugin.interface.js';

/**
 * Connection scope presets (AW-15) — a provider plugin's OPTIONAL
 * declaration of plain-English access levels.
 *
 * An owner picks "Read only" or "Read and write" for a provider instead of
 * editing tool names. The platform knows nothing about any provider: the
 * plugin says which agent tools each level unlocks (as tool-grant patterns)
 * and which provider permissions the connected account needs for it, and the
 * platform writes the chosen level onto the existing tool-grant lattice.
 *
 * Declaring the capability is optional. A plugin that does not declare it
 * keeps "Standard access" — nothing about it changes.
 *
 * The shapes live in `@ever-works/contracts` (`ConnectionScopePresetId`,
 * `ConnectionScopePresetDeclaration`) so the API, the agent package and the
 * web UI share the same pure mapping; plugin authors use the aliases below.
 */

/** Capability id a plugin adds to `capabilities` to declare presets. */
export const CONNECTION_SCOPES_CAPABILITY = 'connection-scopes' as const;

/** One declared level. Alias kept close to the plugin vocabulary. */
export type ConnectionScopePreset = ConnectionScopePresetDeclaration;

/** The level ids a plugin may declare: `read` and `write`. */
export type ConnectionScopeLevel = ConnectionScopePresetId;

export interface IConnectionScopesPlugin extends IPlugin {
	/**
	 * The levels this provider supports, least → most access. Tool patterns
	 * use the tool-grant grammar (`*`, `prefix*`, or an exact tool name). The
	 * wider level's `providerScopes` should be a superset of the narrower
	 * one's.
	 */
	getConnectionScopePresets(): readonly ConnectionScopePreset[];
}

export function isConnectionScopesPlugin(plugin: IPlugin): plugin is IConnectionScopesPlugin {
	return (
		Array.isArray(plugin.capabilities) &&
		plugin.capabilities.includes(CONNECTION_SCOPES_CAPABILITY) &&
		typeof (plugin as Partial<IConnectionScopesPlugin>).getConnectionScopePresets === 'function'
	);
}
