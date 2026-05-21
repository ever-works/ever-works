/**
 * EW-644 — Per-Work repo resolution for `mode: 'data-repo'`.
 *
 * The github-storage plugin avoids a direct workspace import to
 * `@ever-works/agent` (which would create a circular dep: agent ->
 * plugin contracts -> plugin impl), and instead receives a resolver
 * through `PluginContext`. The API's `storage-backend.factory` wires
 * a concrete NestJS-backed impl into the stub context before
 * `onLoad()`.
 *
 * Looked up at upload time, not at boot — the user's OAuth token may
 * have rotated, the Work's data repo coordinates may have changed,
 * etc. The impl is responsible for any caching it wants.
 */

export interface ResolvedWorkRepo {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
}

export interface WorkRepoResolver {
	resolve(workId: string): Promise<ResolvedWorkRepo>;
}
