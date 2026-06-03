import type { PluginInstallStateDto } from './install-state.js';

/**
 * Dynamic plugin distribution (EW-693).
 *
 * A single entry in `GET /plugins/catalog` — the listable set of
 * distributable plugins. Manifest summary only (id/name/category/...)
 * + the local install state so the UI can render an "available"
 * card before the plugin has ever been instantiated.
 */
export interface PluginCatalogEntry {
	readonly pluginId: string;
	readonly name: string;
	readonly description: string;
	readonly category: string;
	readonly capabilities: readonly string[];
	readonly version: string;
	readonly distribution: 'core' | 'registry';
	/** npm package name (e.g. `@ever-works/notion-extractor-plugin`). */
	readonly packageName?: string;
	/** Most recent version published to the registry (catalog-side). */
	readonly latestVersion?: string;
	readonly homepage?: string;
	readonly author?: string;
	readonly deprecated?: boolean;
	/** Per-replica install state, merged from the local DB. */
	readonly install: PluginInstallStateDto;
}

/**
 * Catalog response envelope. Errors fetching the upstream catalog are
 * surfaced via {@link PluginCatalogResponse.fetchedAt} being absent
 * and {@link PluginCatalogResponse.degraded} being true, so the UI
 * can show "registry unreachable — only locally-known plugins listed".
 */
export interface PluginCatalogResponse {
	readonly entries: readonly PluginCatalogEntry[];
	readonly fetchedAt?: string;
	/** True when the registry call failed and entries reflect local state only. */
	readonly degraded?: boolean;
	readonly degradedReason?: string;
}

/**
 * Request body for `POST /plugins/:id/install`.
 *
 * - `version` is optional; when omitted the server resolves the
 *   latest matching version pinned via the allowlist (or the
 *   `@ever-works/*` package's `latest` dist-tag for first-party).
 * - `integrity` is optional; when provided the server MUST refuse
 *   if the downloaded integrity does not match (FR-10).
 * - `source` lets a self-hoster prefer `github-packages` over the
 *   default public npm mirror, when both are configured.
 */
export interface PluginInstallRequestDto {
	readonly version?: string;
	readonly integrity?: string;
	readonly source?: 'npm' | 'github-packages';
}

/**
 * Response body for `POST /plugins/:id/install` (sync 202-accepted
 * envelope). The actual install runs asynchronously; clients poll
 * `GET /plugins/:id/install-status` for terminal state.
 */
export interface PluginInstallResponseDto {
	readonly pluginId: string;
	readonly install: PluginInstallStateDto;
}
