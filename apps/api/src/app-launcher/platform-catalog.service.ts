/**
 * APW-11 (App Launcher) — the platform catalog reader.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` FR-8…FR-14,
 * FR-44; plan: `…/plan.md` §5.1 (the `ever-works/platforms` repository), §5.2
 * (this service, line by line) and §9.1/§9.2 (its events and failure modes).
 *
 * ## What it is
 *
 * The launcher's Ever apps are **data read at runtime** from a versioned
 * repository outside the product (FR-8, ADR-014). This service reads
 * `platforms.json`, validates it with `./platform-catalog.schema`, inlines each
 * referenced icon as a `data:` URI and caches the result — no catalog content
 * lives in the product, and the only platform name the product itself knows is
 * the self id (used for FR-13's **You're here** chip).
 *
 * ## The fetch happens HERE, in the API process (APW11-G06)
 *
 * A browser route cannot stand in for this read: Playwright intercepts the
 * browser only, and the panel's tiles are composed server-side. That is why the
 * acceptance lanes point the **API** at a fixture catalog through
 * `EVER_WORKS_PLATFORM_CATALOG_BASE_URL` — and why that override is hard-gated
 * (see {@link PlatformCatalogService.catalogBaseUrl}).
 *
 * ## The shape of a read
 *
 *   `read(environment?)` → `{ environment, catalogVersion, catalogAvailable, stale, platforms }`
 *   `list(environment?)` → the `platforms` array alone (plan §4.1 step 1).
 *
 * The items are `AppLauncherItem`s (plus FR-11's `catalogOrder`), so the packet
 * the registry service accepts is the packet this service returns — the item
 * type is the contract, not a second copy of it.
 *
 * `catalogAvailable` is **false exactly when nothing could be served**, which
 * is the case plan §4.1 step 1 renders as the single synthesised
 * `platform:<selfId>` tile; a last-good copy served after a failed refresh is
 * `catalogAvailable: true` with `stale: true`, because the panel renders it
 * "with no error" (ACC-11-07). The synthesised tile itself is the caller's
 * (T9 / `AppLauncherService`), per `AppLauncherPlatformInput.url`'s comment in
 * `packages/agent/src/app-launcher/app-launcher.service.ts:153`.
 *
 * ## Caching (FR-12, plan §5.2:663-665)
 *
 *   - `platform-catalog:<ref>` — the read, for {@link PLATFORM_CATALOG_SUCCESS_TTL_MS}
 *     after a success and {@link PLATFORM_CATALOG_FAILURE_TTL_MS} after a
 *     failure, so a rate-limiting upstream is retried within 30 s instead of on
 *     every request;
 *   - `platform-catalog:<ref>:last-good` — the last catalog that *did* read,
 *     with **no TTL**, so a later failure still renders the panel (S10).
 *
 * Both entries hold the same environment-independent document: the environment
 * is selected per read, so one cache entry serves `production`, `stage` and
 * `develop` without three copies drifting apart.
 *
 * ## What this service never does
 *
 * It never invents a platform, never falls back to a built-in list (FR-8), never
 * renders an address that failed validation and never lets the non-production
 * override relax a single safety rule — scheme, size, SVG deny patterns and the
 * entry cap all still apply while it is active (plan §5.2:643-648, CONTRACTS
 * R-40).
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import {
    isAppLauncherEnvironment,
    type AppLauncherEnvironment,
    type AppLauncherItem,
} from '@ever-works/contracts';
import {
    CATALOG_REPO_RE,
    DEFAULT_CATALOG_REPO,
    parseCatalogDocument,
    toCatalogIconDataUri,
    type CatalogDocument,
    type CatalogIconOmissionReason,
    type CatalogOmission,
    type CatalogOmissionReason,
    type CatalogPlatformEntry,
} from './platform-catalog.schema';

/**
 * The raw host the catalog is read from (plan §5.1:604) — the same tokenless
 * read `WorksTemplateCatalogService` uses for `ever-works/works`, with a real
 * `User-Agent` for the CF-proxied deployments and for rate-limit etiquette.
 */
export const RAW_CATALOG_HOST = 'https://raw.githubusercontent.com';

/** The full read's timeout, per request (plan §5.2:656 — "8 s timeout each"). */
export const PLATFORM_CATALOG_FETCH_TIMEOUT_MS = 8_000;

/**
 * How many icons are fetched at once (plan §5.2:657 — "max 24 icons in parallel
 * batches of 6"). Bounded concurrency keeps a 24-entry catalog from opening 24
 * sockets at the raw host while still finishing in a handful of round trips.
 */
export const PLATFORM_CATALOG_ICON_BATCH_SIZE = 6;

/** TTL of a successful read (plan §5.2:663 — 3,600,000 ms). */
export const PLATFORM_CATALOG_SUCCESS_TTL_MS = 3_600_000;

/** TTL of a failed read — FR-12's "at most once every 30 seconds after a failed one". */
export const PLATFORM_CATALOG_FAILURE_TTL_MS = 30_000;

/**
 * TTL of the last-good copy: **none** (plan §5.2:664-665). `0` is how
 * cache-manager/keyv spells "no expiry"; a store that treats `0` as "the
 * default TTL" only shortens the grace window — it can never make an older
 * catalog render, because the entry is read exclusively after a failure.
 */
export const PLATFORM_CATALOG_LAST_GOOD_TTL_MS = 0;

/** Cache key prefix and suffix (plan §5.2:663-665, verbatim). */
export const PLATFORM_CATALOG_CACHE_KEY_PREFIX = 'platform-catalog';
export const PLATFORM_CATALOG_LAST_GOOD_SUFFIX = 'last-good';

/** Default coordinates (plan §5.2:633-637). */
export const DEFAULT_CATALOG_REF = 'main';
export const DEFAULT_CATALOG_ENV: AppLauncherEnvironment = 'production';
export const DEFAULT_CATALOG_SELF_ID = 'ever-works';

/** The User-Agent every catalog request carries. */
export const PLATFORM_CATALOG_USER_AGENT = 'ever-works-platform (+https://ever.works)';

/**
 * DI token for the fetch implementation. Unbound in production (the service then
 * uses `globalThis.fetch`); a spec or a fixture server binds it, which is what
 * keeps every test off the network while still asserting the exact URL asked
 * for.
 */
export const PLATFORM_CATALOG_FETCH = Symbol('PLATFORM_CATALOG_FETCH');

/** The fetch signature the service uses — `globalThis.fetch`'s. */
export type PlatformCatalogFetch = typeof fetch;

/**
 * One catalog platform as the registry consumes it: an `AppLauncherItem` whose
 * preference fields are their defaults (the public catalog read carries no
 * preference state) plus FR-11's ordering number, which is what the **Ever
 * apps** section sorts by when a person has stored no order of their own.
 */
export interface PlatformCatalogItem extends AppLauncherItem {
    /** The catalog entry's `order` (FR-11), kept beside the resolved tile order. */
    catalogOrder: number;
}

/** The result of one catalog read — everything the caller must not re-derive. */
export interface PlatformCatalogRead {
    /** The environment these addresses belong to (FR-10). */
    environment: AppLauncherEnvironment;
    /** The version read, or `null` when no catalog could be served (S9/S10). */
    catalogVersion: string | null;
    /** `false` only when there is nothing to serve at all — see the header. */
    catalogAvailable: boolean;
    /** `true` when the source is failing and this list is the last good copy (S10). */
    stale: boolean;
    /** The tiles, in FR-11 order, capped at 24 entries. */
    platforms: PlatformCatalogItem[];
}

/**
 * The in-process counters behind the service's operational events (plan
 * §9.1:907-908, §5.2:652). Logs are the operational surface the plan names;
 * these counters are the same facts in a form a test (and, until a metrics
 * registry exists in `apps/api`, an operator) can read directly.
 */
export interface PlatformCatalogTelemetry {
    /** `app_launcher.catalog.environment_unset` — one per refresh, production excluded. */
    environmentUnset: number;
    /** `app_launcher.catalog.refreshed` — one per successful read of the source. */
    refreshed: number;
    /** `app_launcher.catalog.refresh_failed` — one per failed read of the source. */
    refreshFailed: number;
    /** `app_launcher.item.omitted` counts, per reason (FR-44). */
    omitted: Record<CatalogOmissionReason, number>;
    /** Icons that were not inlined; the entry was kept (plan §9.2:916). */
    iconsOmitted: Record<CatalogIconOmissionReason, number>;
}

/** A validated entry whose icon has been inlined (or deliberately dropped). */
type CatalogPlatformWithIcon = Omit<CatalogPlatformEntry, 'icon'> & { iconDataUri?: string };

/** What the cache holds: the read, or the fact that the read just failed. */
type CatalogCacheEntry =
    | { kind: 'catalog'; catalog: CatalogDocumentWithIcons }
    | { kind: 'failure'; reason: string };

/** A catalog document whose platforms already carry their inlined icons. */
interface CatalogDocumentWithIcons {
    catalogVersion: string;
    platforms: CatalogPlatformWithIcon[];
}

@Injectable()
export class PlatformCatalogService {
    private readonly logger = new Logger(PlatformCatalogService.name);
    private warnedMutableRef = false;
    private warnedUnboundCache = false;

    private readonly counts = {
        environmentUnset: 0,
        refreshed: 0,
        refreshFailed: 0,
        omitted: { invalidEntry: 0, unsafeUrl: 0, overLimit: 0 } as Record<
            CatalogOmissionReason,
            number
        >,
        iconsOmitted: {
            oversizeIcon: 0,
            unsafeSvg: 0,
            unreadableIcon: 0,
        } as Record<CatalogIconOmissionReason, number>,
    };

    constructor(
        @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
        @Optional()
        @Inject(PLATFORM_CATALOG_FETCH)
        private readonly fetchImpl?: PlatformCatalogFetch,
    ) {
        // Refused at BOOT, not on the first request (plan §5.2:633-635): a
        // misconfigured repo is an operator error the installation must not
        // discover by serving an empty panel. The value is re-checked on every
        // read as well, so a mutation after boot is refused too.
        this.resolveRepo();
    }

    /**
     * The Ever apps for one environment (plan §4.1 step 1: `platforms =
     * PlatformCatalogService.list(env)`).
     *
     * Returns the tiles alone; use {@link read} for the version, the availability
     * flag and the staleness fact the registry echoes in `meta`.
     */
    async list(
        environment?: AppLauncherEnvironment | string | null,
    ): Promise<PlatformCatalogItem[]> {
        return (await this.read(environment)).platforms;
    }

    /** One full catalog read (see the header for the shape and the cache rules). */
    async read(environment?: AppLauncherEnvironment | string | null): Promise<PlatformCatalogRead> {
        const resolvedEnvironment = this.resolveEnvironment(environment);
        const ref = this.resolveRef();
        const { owner, repo } = this.resolveRepo();
        const cacheKey = this.cacheKey(ref);
        const lastGoodKey = this.lastGoodKey(ref);

        const cached = await this.cacheGet<CatalogCacheEntry>(cacheKey);

        if (cached?.kind === 'failure') {
            // FR-12: a failed read is remembered briefly, so the panel does not
            // re-pay the whole 8 s timeout on every request while the source is
            // down — and the last good copy is served in the meantime (S10).
            return this.serveLastGood(resolvedEnvironment, lastGoodKey, cached.reason);
        }
        if (cached?.kind === 'catalog') {
            return this.buildRead(resolvedEnvironment, cached.catalog, {
                available: true,
                stale: false,
            });
        }

        const refreshed = await this.refresh(owner, repo, ref, cacheKey, lastGoodKey);
        // `'catalog' in refreshed`, not `refreshed.ok`: `strictNullChecks: false`
        // (this app's tsconfig) does not narrow a union on a boolean literal.
        if ('catalog' in refreshed) {
            return this.buildRead(resolvedEnvironment, refreshed.catalog, {
                available: true,
                stale: false,
            });
        }
        return this.serveLastGood(resolvedEnvironment, lastGoodKey, refreshed.reason);
    }

    /** The operational counters of this process (see {@link PlatformCatalogTelemetry}). */
    telemetry(): PlatformCatalogTelemetry {
        return {
            environmentUnset: this.counts.environmentUnset,
            refreshed: this.counts.refreshed,
            refreshFailed: this.counts.refreshFailed,
            omitted: { ...this.counts.omitted },
            iconsOmitted: { ...this.counts.iconsOmitted },
        };
    }

    // -----------------------------------------------------------------------
    // Coordinates and the one non-production hook
    // -----------------------------------------------------------------------

    /**
     * The catalog repository coordinates (plan §5.2:633-635).
     *
     * The value must match {@link CATALOG_REPO_RE} — SSRF containment — and it
     * is checked on **every** read, not only at boot, so a value mutated after
     * startup cannot reach the URL builder.
     */
    private resolveRepo(): { owner: string; repo: string } {
        const configured = (process.env.EVER_WORKS_PLATFORM_CATALOG_REPO ?? '').trim();
        const spec = configured.length > 0 ? configured : DEFAULT_CATALOG_REPO;
        if (!CATALOG_REPO_RE.test(spec)) {
            throw new Error(
                `EVER_WORKS_PLATFORM_CATALOG_REPO must match ${CATALOG_REPO_RE} (SSRF containment, APW-11 plan §5.2) — refusing "${spec}".`,
            );
        }
        const [owner, repo] = spec.split('/');
        return { owner, repo };
    }

    /** The ref read (plan §5.2:635), defaulting to `main`. */
    private resolveRef(): string {
        const ref = (process.env.EVER_WORKS_PLATFORM_CATALOG_REF ?? '').trim();
        return ref.length > 0 ? ref : DEFAULT_CATALOG_REF;
    }

    /** The id marked `current` (FR-13), defaulting to `ever-works`. */
    private resolveSelfId(): string {
        const selfId = (process.env.EVER_WORKS_PLATFORM_CATALOG_SELF_ID ?? '').trim();
        return selfId.length > 0 ? selfId : DEFAULT_CATALOG_SELF_ID;
    }

    /**
     * The environment whose addresses this read shows (FR-10).
     *
     * An explicit, recognised argument wins (the public route's
     * `?environment=`); otherwise `EVER_WORKS_PLATFORM_CATALOG_ENV`; otherwise
     * `production`, which is the documented default (plan §5.2:636, APW11-G19).
     * An unset or unrecognised value is reported by
     * {@link logEnvironmentWhenUnset} on the refresh path — it never changes the
     * answer, because an installation that upgrades into this epic must keep
     * serving.
     */
    private resolveEnvironment(
        requested?: AppLauncherEnvironment | string | null,
    ): AppLauncherEnvironment {
        if (isAppLauncherEnvironment(requested)) {
            return requested;
        }
        const configured = (process.env.EVER_WORKS_PLATFORM_CATALOG_ENV ?? '').trim();
        return isAppLauncherEnvironment(configured) ? configured : DEFAULT_CATALOG_ENV;
    }

    /**
     * The non-production source override (plan §5.2:637-648, APW11-G06,
     * ACC-11-51) — **the one place** this service reads both variables.
     *
     * The shape is the lane-switch precedent
     * (`config.subscriptions.bypassSeatLimitsInE2E()`,
     * `packages/agent/src/config/index.ts:824-829`): the production branch is
     * **first**, so a variable that is set in production is ignored rather than
     * honoured, and the override is only ever a test-lane affordance. APW-13 T5
     * owns the programme's `EVER_WORKS_E2E_FAKES` accessor; until it lands this
     * is the getter, and moving it later means replacing this method body.
     *
     * The override replaces the **raw host** for the whole read — the fixture
     * index and its icons — and nothing else about the read changes: the repo
     * coordinates, the validation, the SVG patterns, the size cap and the entry
     * cap all still apply (CONTRACTS R-40), which the spec asserts while the
     * override is active.
     *
     * A malformed value is ignored (with a warning) instead of being used: a URL
     * that cannot be parsed is a broken lane, not a catalog.
     */
    private catalogBaseUrl(): string | null {
        if (process.env.NODE_ENV === 'production') {
            return null;
        }
        if (!this.e2eFakesEnabled()) {
            return null;
        }
        const configured = (process.env.EVER_WORKS_PLATFORM_CATALOG_BASE_URL ?? '').trim();
        if (configured.length === 0) {
            return null;
        }

        const safe = safeBaseUrl(configured);
        if (!safe) {
            this.logger.warn(
                'EVER_WORKS_PLATFORM_CATALOG_BASE_URL is not a usable http(s) URL — ignoring it and reading the versioned catalog instead.',
            );
            return null;
        }
        return safe;
    }

    /**
     * The programme's single non-production switch (CONTRACTS §7,
     * `EVER_WORKS_E2E_FAKES`). APW-13 T5 and the lanes set `1`
     * (`APW-13-golden-paths/tasks.md:97`); `true` is accepted as well because
     * that is the value the lane-switch precedent uses
     * (`E2E_BYPASS_SEAT_LIMITS === 'true'`). Anything else — unset, empty, `0`,
     * `false` — is **off**: an unrecognised value must never open a test hook.
     */
    private e2eFakesEnabled(): boolean {
        const value = (process.env.EVER_WORKS_E2E_FAKES ?? '').trim().toLowerCase();
        return value === '1' || value === 'true';
    }

    /** The host the read starts from: the override when it is live, else the raw host. */
    private catalogBase(): string {
        return this.catalogBaseUrl() ?? RAW_CATALOG_HOST;
    }

    // -----------------------------------------------------------------------
    // The read itself
    // -----------------------------------------------------------------------

    /**
     * Read the source and cache the outcome. Never throws: every failure is a
     * `{ ok: false, reason }` the caller turns into last-good or unavailable.
     */
    private async refresh(
        owner: string,
        repo: string,
        ref: string,
        cacheKey: string,
        lastGoodKey: string,
    ): Promise<{ ok: true; catalog: CatalogDocumentWithIcons } | { ok: false; reason: string }> {
        const startedAt = Date.now();
        this.logEnvironmentWhenUnset();
        this.warnWhenRefIsMutable(ref);

        const indexUrl = this.indexUrl(owner, repo, ref);
        const response = await this.get(indexUrl);
        if (!response) {
            return this.failRefresh(cacheKey, 'unreachable', indexUrl);
        }

        const text = await readBodyText(response);
        if (text === null) {
            return this.failRefresh(cacheKey, 'unreadableBody', indexUrl);
        }

        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            return this.failRefresh(cacheKey, 'malformedJson', indexUrl);
        }

        const parsed = parseCatalogDocument(raw);
        // `'error' in parsed` — see the note on the refresh branch above.
        if ('error' in parsed) {
            return this.failRefresh(cacheKey, `invalidCatalog: ${parsed.error}`, indexUrl);
        }

        for (const omission of parsed.omissions) {
            this.reportOmission(omission);
        }

        const platforms = await this.inlineIcons(owner, repo, ref, parsed.catalog.platforms);
        const catalog: CatalogDocumentWithIcons = {
            catalogVersion: parsed.catalog.catalogVersion,
            platforms,
        };
        const fresh: CatalogCacheEntry = { kind: 'catalog', catalog };
        const lastGood: CatalogCacheEntry = { kind: 'catalog', catalog };

        await this.cacheSet(cacheKey, fresh, PLATFORM_CATALOG_SUCCESS_TTL_MS);
        await this.cacheSet(lastGoodKey, lastGood, PLATFORM_CATALOG_LAST_GOOD_TTL_MS);

        this.counts.refreshed += 1;
        this.logger.log(
            `app_launcher.catalog.refreshed ${JSON.stringify({
                entries: platforms.length,
                dropped: parsed.omissions.length,
                durationMs: Date.now() - startedAt,
            })}`,
        );

        return { ok: true, catalog };
    }

    /** Remember a failed read for {@link PLATFORM_CATALOG_FAILURE_TTL_MS} and report it. */
    private async failRefresh(
        cacheKey: string,
        reason: string,
        indexUrl: string,
    ): Promise<{ ok: false; reason: string }> {
        this.counts.refreshFailed += 1;
        const failure: CatalogCacheEntry = { kind: 'failure', reason };
        await this.cacheSet(cacheKey, failure, PLATFORM_CATALOG_FAILURE_TTL_MS);
        // The URL is named here on purpose: this line is how an operator learns
        // which source failed (the catalog itself is public data, so the host is
        // not a secret).
        this.logger.warn(
            `app_launcher.catalog.refresh_failed ${JSON.stringify({ reason, url: indexUrl })} — the last good catalog is served when one exists.`,
        );
        return { ok: false, reason };
    }

    /** Serve the last good copy when there is one, else report "nothing to show". */
    private async serveLastGood(
        environment: AppLauncherEnvironment,
        lastGoodKey: string,
        reason: string,
    ): Promise<PlatformCatalogRead> {
        const lastGood = await this.cacheGet<CatalogCacheEntry>(lastGoodKey);
        if (lastGood?.kind === 'catalog') {
            // S10 / ACC-11-07: the last good list renders with no error while the
            // source is failing — the panel says nothing, it simply keeps working.
            this.logger.warn(
                `app_launcher.catalog.last_good_served ${JSON.stringify({ reason, catalogVersion: lastGood.catalog.catalogVersion })}`,
            );
            return this.buildRead(environment, lastGood.catalog, { available: true, stale: true });
        }
        // S9: nothing was ever read, so the caller renders the single current
        // platform and the "catalog unavailable" state.
        return {
            environment,
            catalogVersion: null,
            catalogAvailable: false,
            stale: false,
            platforms: [],
        };
    }

    /** Turn one cached/refreshed catalog document into the items for one environment. */
    private buildRead(
        environment: AppLauncherEnvironment,
        catalog: CatalogDocumentWithIcons,
        flags: { available: boolean; stale: boolean },
    ): PlatformCatalogRead {
        const selfId = this.resolveSelfId();
        const platforms: PlatformCatalogItem[] = [];

        for (const entry of catalog.platforms) {
            // FR-10: an entry without an address for the environment this
            // installation runs in is simply not shown — the launcher never sends
            // a person from one environment to another.
            const address = entry.urls[environment];
            if (!address) {
                continue;
            }
            platforms.push({
                key: `platform:${entry.id}`,
                kind: 'platform',
                section: 'platforms',
                name: entry.name,
                description: entry.description,
                iconDataUri: entry.iconDataUri,
                url: address.url,
                host: address.host,
                current: entry.id === selfId,
                status: entry.status,
                visible: true,
                pinned: false,
                pinOrder: null,
                order: entry.order,
                catalogOrder: entry.order,
                manageState: 'listed',
            });
        }

        return {
            environment,
            catalogVersion: catalog.catalogVersion,
            catalogAvailable: flags.available,
            stale: flags.stale,
            platforms,
        };
    }

    /**
     * Fetch every referenced icon, at most
     * {@link PLATFORM_CATALOG_ICON_BATCH_SIZE} at a time (plan §5.2:657).
     *
     * A failure of any kind — unreachable, non-2xx, oversize, a deny pattern —
     * keeps the **entry** and drops only its icon, so a bad icon can never
     * remove a platform from the panel (plan §9.2:916, the fixture's
     * `oversizeIcon`/`scriptIcon` cases).
     */
    private async inlineIcons(
        owner: string,
        repo: string,
        ref: string,
        entries: CatalogPlatformEntry[],
    ): Promise<CatalogPlatformWithIcon[]> {
        const resolved: CatalogPlatformWithIcon[] = [];

        for (let index = 0; index < entries.length; index += PLATFORM_CATALOG_ICON_BATCH_SIZE) {
            const batch = entries.slice(index, index + PLATFORM_CATALOG_ICON_BATCH_SIZE);
            const icons = await Promise.all(
                batch.map((entry) => this.readIcon(owner, repo, ref, entry)),
            );

            batch.forEach((entry, offset) => {
                const withoutIcon: Omit<CatalogPlatformEntry, 'icon'> = {
                    id: entry.id,
                    name: entry.name,
                    description: entry.description,
                    order: entry.order,
                    status: entry.status,
                    urls: entry.urls,
                };
                const iconDataUri = icons[offset];
                resolved.push(iconDataUri === null ? withoutIcon : { ...withoutIcon, iconDataUri });
            });
        }

        return resolved;
    }

    /** Read one icon and inline it, or report why it was not inlined. */
    private async readIcon(
        owner: string,
        repo: string,
        ref: string,
        entry: CatalogPlatformEntry,
    ): Promise<string | null> {
        const response = await this.get(this.iconUrl(owner, repo, ref, entry.icon));
        if (!response) {
            return this.reportIconOmission(entry.id, 'unreadableIcon');
        }
        const bytes = await readBodyBytes(response);
        if (bytes === null) {
            return this.reportIconOmission(entry.id, 'unreadableIcon');
        }

        const inlined = toCatalogIconDataUri(entry.icon, bytes);
        // `'reason' in inlined` — see the note on the refresh branch above.
        if ('reason' in inlined) {
            return this.reportIconOmission(entry.id, inlined.reason);
        }
        return inlined.dataUri;
    }

    /**
     * Report a dropped entry (FR-11: the drop is logged with the entry id only)
     * and count it per reason (FR-44).
     */
    private reportOmission(omission: CatalogOmission): void {
        this.counts.omitted[omission.reason] += 1;
        this.logger.warn(
            `app_launcher.item.omitted ${JSON.stringify({ id: omission.id, reason: omission.reason })}`,
        );
    }

    /** Report an icon that was not inlined — the entry itself is kept. */
    private reportIconOmission(id: string, reason: CatalogIconOmissionReason): null {
        this.counts.iconsOmitted[reason] += 1;
        this.logger.warn(
            `app_launcher.catalog.icon_omitted ${JSON.stringify({ id, reason })} — the platform is listed without an icon.`,
        );
        return null;
    }

    /**
     * FR-10 / APW11-G19: outside production an unset (or unrecognised)
     * `EVER_WORKS_PLATFORM_CATALOG_ENV` is an **error event on every refresh**,
     * counted in operational telemetry, and it does not fail boot — an
     * installation whose manifests are wrong keeps serving, loudly.
     *
     * Only a refresh reports: a cache hit did not touch the source, so it has
     * nothing new to say and must not turn one misconfiguration into one log
     * line per request.
     */
    private logEnvironmentWhenUnset(): void {
        if (process.env.NODE_ENV === 'production') {
            // `production` is the documented default BECAUSE this is production;
            // nothing is wrong and there is nothing to report.
            return;
        }
        const configured = (process.env.EVER_WORKS_PLATFORM_CATALOG_ENV ?? '').trim();
        if (isAppLauncherEnvironment(configured)) {
            return;
        }

        this.counts.environmentUnset += 1;
        this.logger.error(
            `app_launcher.catalog.environment_unset ${JSON.stringify({
                reason: configured.length > 0 ? 'invalid' : 'unset',
                value: configured.length > 0 ? configured : null,
                fallback: DEFAULT_CATALOG_ENV,
            })}`,
        );
    }

    /**
     * Warn once when the ref is a mutable branch (plan §5.2:635) — a tag or a
     * 40-char SHA cannot be moved under the installation after the cache
     * expires, so production should pin one. Only the refresh path warns, so
     * routine cache hits stay quiet.
     */
    private warnWhenRefIsMutable(ref: string): void {
        if (this.warnedMutableRef) {
            return;
        }
        const isPinned = /^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+(\.\d+)?$/.test(ref);
        if (isPinned) {
            return;
        }
        this.warnedMutableRef = true;
        this.logger.warn(
            `EVER_WORKS_PLATFORM_CATALOG_REF is set to a mutable ref '${ref}'. Pin a commit SHA (40 hex chars) or a version tag (vX.Y.Z) in production to prevent supply-chain substitution after cache expiry.`,
        );
    }

    // -----------------------------------------------------------------------
    // URLs, HTTP and the cache
    // -----------------------------------------------------------------------

    /** `<base>/<owner>/<repo>/<ref>/platforms.json` (plan §5.1:604). */
    private indexUrl(owner: string, repo: string, ref: string): string {
        return `${this.catalogBase()}/${owner}/${repo}/${encodeURIComponent(ref)}/platforms.json`;
    }

    /** `<base>/<owner>/<repo>/<ref>/<icon path>` — the icon read (§5.1:598). */
    private iconUrl(owner: string, repo: string, ref: string, iconPath: string): string {
        return `${this.catalogBase()}/${owner}/${repo}/${encodeURIComponent(ref)}/${iconPath}`;
    }

    /**
     * One GET with the 8 s timeout (plan §5.2:656). Returns `null` on any
     * non-2xx, timeout or transport error — the caller turns that into the
     * failure path, and nothing here throws at a request.
     */
    private async get(url: string): Promise<Response | null> {
        const doFetch = this.fetchImpl ?? globalThis.fetch;
        if (typeof doFetch !== 'function') {
            return null;
        }
        try {
            const response = await doFetch(url, {
                headers: {
                    'User-Agent': PLATFORM_CATALOG_USER_AGENT,
                    Accept: 'application/json,image/svg+xml,image/png,*/*',
                },
                signal: AbortSignal.timeout(PLATFORM_CATALOG_FETCH_TIMEOUT_MS),
            });
            return response?.ok ? response : null;
        } catch {
            // A timeout aborts, a DNS failure rejects, a rate limit may still be
            // a 2xx-less response: all of them are "this read did not happen".
            return null;
        }
    }

    private cacheKey(ref: string): string {
        return `${PLATFORM_CATALOG_CACHE_KEY_PREFIX}:${ref}`;
    }

    private lastGoodKey(ref: string): string {
        return `${this.cacheKey(ref)}:${PLATFORM_CATALOG_LAST_GOOD_SUFFIX}`;
    }

    /**
     * A cache read that can never fail the request: a cache outage degrades to
     * "read the source", which is slower but correct.
     */
    private async cacheGet<T>(key: string): Promise<T | undefined> {
        if (!this.hasCache()) {
            return undefined;
        }
        try {
            return (await this.cache!.get<T>(key)) ?? undefined;
        } catch {
            return undefined;
        }
    }

    /** A cache write that can never fail the request, for the same reason. */
    private async cacheSet(key: string, value: CatalogCacheEntry, ttl: number): Promise<void> {
        if (!this.hasCache()) {
            return;
        }
        try {
            await this.cache!.set(key, value, ttl);
        } catch {
            // Nothing to do: the next read simply reads the source again.
        }
    }

    /**
     * Whether a usable cache is bound. The service is wired with an injected
     * `CACHE_MANAGER`; if a deployment ever loses it, the reader still works
     * (every read hits the source) and says so once, rather than failing boot.
     */
    private hasCache(): boolean {
        const usable =
            typeof this.cache?.get === 'function' && typeof this.cache?.set === 'function';
        if (!usable && !this.warnedUnboundCache) {
            this.warnedUnboundCache = true;
            this.logger.warn(
                'No CACHE_MANAGER is bound — the platform catalog is read on every request (FR-12 expects a 1-hour cache).',
            );
        }
        return usable;
    }
}

/**
 * Validate the non-production override's own value: an absolute `http(s)` URL
 * with no credential and a host, without a trailing slash so the URL builder
 * composes cleanly.
 *
 * `http` is admitted (it is not `https`-only like a catalog *address*) because
 * the lanes serve the fixture over a local server — APW-13's fake GitHub is
 * `http://127.0.0.1:3900` (`APW-13-golden-paths/plan.md:676`) — and the whole
 * override is already gated to non-production plus the fakes switch.
 */
function safeBaseUrl(value: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return null;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.host.length === 0) {
        return null;
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** `Response.text()`, or `null` when the body cannot be read. */
async function readBodyText(response: Response): Promise<string | null> {
    try {
        return await response.text();
    } catch {
        return null;
    }
}

/** `Response.arrayBuffer()`, or `null` when the body cannot be read. */
async function readBodyBytes(response: Response): Promise<Uint8Array | null> {
    try {
        return new Uint8Array(await response.arrayBuffer());
    } catch {
        return null;
    }
}
