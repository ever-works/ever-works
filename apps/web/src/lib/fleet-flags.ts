/**
 * Fleet gating + link resolution.
 *
 * Deliberately dependency-free (no `server-only`, no API client) so the
 * settings LAYOUT — which must hide the nav entry — and the fleet PAGE
 * can both read it without either one dragging a server-only module
 * into a client bundle.
 *
 * Everything here is a pure read of `process.env`, evaluated on the
 * server. None of these names is `NEXT_PUBLIC_`-prefixed by accident:
 * the values are passed DOWN as props, never inlined into the browser
 * bundle from here.
 */

/** Fallback download location for the node apps. */
const DEFAULT_DOWNLOAD_URL = 'https://github.com/ever-works/ever-works/releases';

/**
 * The `FLEET_ENABLED` switch, matching `config.fleet.isEnabled()` on the
 * API exactly — including the default.
 *
 * **Default ON.** Fleet already ships; a default-off flag would silently
 * remove a working feature from every existing deployment on upgrade.
 * Operators opt out explicitly with `FLEET_ENABLED=false`.
 */
export function isFleetEnabled(): boolean {
    return process.env.FLEET_ENABLED !== 'false';
}

/**
 * The API base a NODE should call — which is not necessarily the one the
 * web tier calls.
 *
 * `API_URL` is frequently an in-cluster address (`http://api:3100`) that
 * a laptop in an office cannot reach, so the browser-facing
 * `NEXT_PUBLIC_API_URL` wins when it is set. The trailing `/api` is
 * stripped because the node CLI takes an origin and appends its own
 * paths.
 */
export function resolvePublicApiBaseUrl(): string {
    const raw = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3100';
    return raw.replace(/\/+$/, '').replace(/\/api$/, '');
}

/** Where the desktop and headless node apps are downloaded from. */
export function resolveFleetDownloadUrls(): { desktop: string; node: string } {
    return {
        desktop: process.env.FLEET_DESKTOP_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL,
        node: process.env.FLEET_NODE_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL,
    };
}
