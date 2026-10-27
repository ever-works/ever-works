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
 * The `FLEET_HUB_ENABLED` switch (Fleet hub, FL-01): the sidebar entry
 * "Fleet", the `/fleet` hub and its computer pages, the runner pill's
 * link to the hub, the palette's hub screens, and Settings → Fleet's
 * "Computers are under Fleet" card. Matches `config.fleet.isHubEnabled()`
 * on the API exactly.
 *
 * **Default OFF** (CONTRACTS §9) and ON only for the literal `'true'`:
 * off is today's Settings → Fleet, byte for byte (spec FR-15). It can
 * never resurrect a fleet `FLEET_ENABLED=false` switched off (spec U3).
 */
export function isFleetHubEnabled(): boolean {
    return isFleetEnabled() && process.env.FLEET_HUB_ENABLED === 'true';
}

/**
 * Machine facts (FL-08 logs first; FL-09 … FL-11) — `FLEET_MACHINE_FACTS_ENABLED`,
 * matching `config.fleet.isMachineFactsEnabled()` on the API. Default OFF; on
 * only for the literal `'true'` and only with the hub on, because every
 * machine-facts surface (the Logs tab, "Logs on <computer>" in the palette)
 * lives on the hub's computer page.
 */
export function isFleetMachineFactsEnabled(): boolean {
    return isFleetHubEnabled() && process.env.FLEET_MACHINE_FACTS_ENABLED === 'true';
}

/**
 * Virtual computers (FL-16) — `FLEET_VIRTUAL_ENABLED`, matching
 * `config.fleet.isVirtualEnabled()` on the API. Default OFF; on only for the
 * literal `'true'` and only with the hub on, because "New virtual computer…",
 * the nested rows and the child's actions all live on the hub.
 */
export function isFleetVirtualEnabled(): boolean {
    return isFleetHubEnabled() && process.env.FLEET_VIRTUAL_ENABLED === 'true';
}

/**
 * Cloud computers (FL-17) — `FLEET_CLOUD_ENABLED`, matching
 * `config.fleet.isCloudEnabled()` on the API. Default OFF; on only for the
 * literal `'true'` and only with the hub on, because "New cloud computer…", the
 * Cloud block and its actions all live on the hub.
 */
export function isFleetCloudEnabled(): boolean {
    return isFleetHubEnabled() && process.env.FLEET_CLOUD_ENABLED === 'true';
}

/**
 * Usage & cost on the fleet (FL-20) — `FLEET_USAGE_SCAN_ENABLED`, matching
 * `config.fleet.isUsageScanEnabled()` on the API. Default OFF; on only for the
 * literal `'true'` and only with the hub on, because the Usage tab and its
 * palette entries live on the hub.
 */
export function isFleetUsageScanEnabled(): boolean {
    return isFleetHubEnabled() && process.env.FLEET_USAGE_SCAN_ENABLED === 'true';
}

/**
 * The per-epic Fleet flags of CONTRACTS §9, read on the server and passed
 * down to the hub so a tab whose epic shipped behind a flag can say "switched
 * off on this deployment" instead of rendering (spec U4). Every flag is
 * default OFF and on only for the literal `'true'`, and none is on while
 * `FLEET_ENABLED` is off.
 *
 * The list is the registry's (`components/fleet/registry.ts`), passed in so
 * this file stays dependency-free.
 */
export function readFleetFeatureFlags<F extends string>(
    names: readonly F[],
): Partial<Record<F, boolean>> {
    const fleet = isFleetEnabled();
    const flags: Partial<Record<F, boolean>> = {};
    for (const name of names) {
        flags[name] = fleet && process.env[name] === 'true';
    }
    return flags;
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
