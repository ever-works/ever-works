/**
 * Dynamic plugin distribution (EW-693).
 *
 * Per-replica install lifecycle for a distributable plugin. Distinct
 * from `state` (load-lifecycle) and `enabled` (per-user/per-work) so
 * the UI can show all three independently.
 *
 * - `available`: known in the catalog but not yet installed on this node.
 * - `installing`: currently being resolved / downloaded / placed.
 * - `installed`: present on disk and importable; may or may not be enabled.
 * - `error`: last install attempt failed; `installError` carries the reason.
 */
export type PluginInstallState = 'available' | 'installing' | 'installed' | 'error';

/**
 * Source the plugin's code came from on this deployment. Denormalised
 * onto the row for listing; the manifest's `distribution` is the
 * source of truth for "could this plugin ever be installed at runtime?"
 */
export type PluginInstallSource = 'bundled' | 'registry';

/**
 * Wire payload describing where a plugin sits in the install lifecycle.
 * Returned by `GET /plugins/:id/install-status` and embedded in the
 * plugin list / catalog responses (see {@link PluginCatalogEntry}).
 */
export interface PluginInstallStateDto {
	readonly pluginId: string;
	readonly installState: PluginInstallState;
	readonly source: PluginInstallSource;
	/** npm spec actually installed, e.g. `@ever-works/notion-extractor-plugin@1.2.0`. */
	readonly registrySpec?: string;
	readonly installedVersion?: string;
	/** Integrity used to verify the install (sha512 from the registry). */
	readonly integrity?: string;
	/** Last error message if `installState === 'error'`. */
	readonly installError?: string;
	readonly updatedAt?: string;
}
