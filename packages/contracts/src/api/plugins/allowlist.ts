/**
 * Dynamic plugin distribution (EW-693).
 *
 * Admin-managed list of non-first-party packages permitted for
 * runtime install. First-party `@ever-works/*` is implicitly allowed
 * (no row required); everything else must match an enabled
 * `plugin_allowlist` row by name + version range, otherwise the
 * installer refuses the package BEFORE any network fetch (FR-11).
 */
export interface PluginAllowlistEntryDto {
	readonly id: string;
	/** Full npm package name, e.g. `@some-vendor/cool-plugin`. */
	readonly packageName: string;
	/** Semver range pinning what versions are allowed, e.g. `^2.0.0` or `2.1.3`. */
	readonly versionRange: string;
	/** Optional integrity (sha512); when set the install MUST match. */
	readonly integrity?: string;
	readonly source: 'npm' | 'github-packages';
	readonly enabled: boolean;
	readonly createdAt: string;
}

/** Body for `POST /admin/plugins/allowlist`. */
export interface CreatePluginAllowlistEntryDto {
	readonly packageName: string;
	readonly versionRange: string;
	readonly integrity?: string;
	readonly source?: 'npm' | 'github-packages';
	readonly enabled?: boolean;
}

/** Body for `PATCH /admin/plugins/allowlist/:id` (toggle / re-pin). */
export interface UpdatePluginAllowlistEntryDto {
	readonly versionRange?: string;
	readonly integrity?: string;
	readonly enabled?: boolean;
}

/** Response envelope for `GET /admin/plugins/allowlist`. */
export interface PluginAllowlistResponseDto {
	readonly entries: readonly PluginAllowlistEntryDto[];
}
