import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import {
    APP_LAUNCHER_MAX_PREFERENCE_ROWS,
    APP_LAUNCHER_NAME_MAX_LENGTH,
    APP_LAUNCHER_PIN_LIMIT,
    appLauncherPinLimitExceeded,
    isAppLauncherEnvironment,
    type AppLauncherEnvironment,
    type AppLauncherItem,
    type AppLauncherListResponse,
    type AppLauncherManageState,
    type AppLauncherPlatformStatus,
    type AppLauncherPreferenceChange,
    type AppLauncherRejection,
    type AppLauncherSavePreferencesResponse,
    type AppLauncherWorkChip,
} from '@ever-works/contracts';
import { APPS_TIER_POLICY, type AppsTierPolicy } from '../app-runtime/ports';
import { AppLauncherPreference } from '../entities/app-launcher-preference.entity';
import type { Work } from '../entities/work.entity';
import { DeploymentEnvironment, type WorkDeployment } from '../entities/work-deployment.entity';
import type { WorkCustomDomain } from '../entities/work-custom-domain.entity';
import { AppLauncherPreferenceRepository } from '../database/repositories/app-launcher-preference.repository';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import {
    LAUNCHER_CANDIDATE_LIMIT_MAX,
    WorkRepository,
} from '../database/repositories/work.repository';
import {
    resolveAppWorkAddress,
    resolveLauncherAddress,
    toSafeLauncherUrl,
    type LauncherAddress,
} from './launcher-address';
import {
    LAUNCHER_GLOBAL_SCOPE_KEY,
    LAUNCHER_PERSONAL_SCOPE_KEY,
    mergeLauncherPreferences,
    mergedPinnedKeys,
    orderLauncherItems,
    type LauncherOrderableItem,
    type LauncherOrderedItem,
    type LauncherOrderPreference,
} from './launcher-order';
import { AppLauncherPinLimitError } from './app-launcher.errors';
import {
    APP_PUBLISHED_HOSTS,
    DEFAULT_MANAGED_HOST_ROOT_RESOLVER,
    isLauncherAppWorkKind,
    MANAGED_HOST_ROOT_RESOLVER,
    type AppPublishedHostsPort,
    type ManagedHostRootResolver,
} from './managed-host-root.resolver';

/**
 * APW-11 (App Launcher) — the registry: which tiles a person has, what each one
 * says, and the arrangement they wrote for them.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` — FR-16…FR-18,
 * FR-24…FR-29, FR-53…FR-58, FR-62…FR-64; plan §4.1 (the read), §4.2 (the save),
 * §4.5 (the error contract) and §4.6 (address resolution) are the normative
 * sections this class implements.
 *
 * ## Why the platform catalog is an argument, not a dependency (ADR-014)
 *
 * `listForUser(user, scope, platforms, …)` is handed the Ever apps the caller
 * already resolved. The catalog is data read at runtime from a repository
 * outside the product (FR-8), the reader lives in `apps/api`
 * (`PlatformCatalogService`, plan §5.2) and this package contains no catalog
 * content and no HTTP client for it. It also means the outage path of §4.1
 * step 1 — "`catalogAvailable: false`, and the only platform item is the current
 * platform, synthesised" — is the caller's decision, handed in as an argument and
 * echoed in `meta`.
 *
 * ## The reads (plan §4.1 steps 2-4)
 *
 * One bounded candidate query, then four batched reads in one `Promise.all`:
 * the newest production deployment (any state — FR-18's chip), the newest
 * **`READY`** production deployment (liveness — FR-15), the verified production
 * custom domains (FR-16's first preference) and the caller's own preference rows
 * for the merged view. Nothing is read per Work.
 *
 * The two deployment reads are deliberately different, and this class relies on
 * that difference rather than re-filtering: `findLatestReadyForWorks` matches
 * `state = 'READY'` exactly — so a newer failure never hides an earlier success
 * (ACC-11-12), a newer `SUPERSEDED` row is skipped for free (ACC-11-44) and a
 * state APW-06 adds later cannot slip through — while `findLatestForWorks` is
 * unfiltered and is the only source of the FR-58 chip, which this class maps
 * itself (a `CANCELED` or `SUPERSEDED` latest row chips nothing).
 *
 * ## Scope (FR-24, FR-62)
 *
 * Ever app rows live under `global` and are shared by every Organization; Work
 * rows live under `personal` or the active Organization's id. A read renders the
 * merged view `global ∪ <active scope>`, which is why a pin made in Organization
 * B can never renumber Organization A — B's read never loads A's rows at all.
 *
 * ## The seams this epic does not own
 *
 * Four collaborators belong to other epics and are injected `@Optional()`,
 * appended after the repositories, each behind the token its owner will bind:
 *
 *   - `MANAGED_HOST_ROOT_RESOLVER` — APW-06 T48 (`AppManagedHostRootResolver`),
 *     falling back to {@link DEFAULT_MANAGED_HOST_ROOT_RESOLVER} (this epic);
 *   - `APP_PUBLISHED_HOSTS` — APW-06's `AppHostsService` (FR-55);
 *   - `WORK_APP_RUNTIME_STATES` — APW-06 T17's `WorkAppRuntimeStateRepository`,
 *     read through a `findStateForWorks(workIds)` batch for FR-56's pause and
 *     removal. **No row, an unbound port or a failed read all mean "not
 *     paused"**: a pause table that cannot be read must not empty every panel;
 *   - `APP_SPEC_DISPLAY_NAMES` — APW-03's `WorkAppSpecState.displayName`
 *     (`varchar(80)`) for FR-57's item name;
 *   - `APPS_TIER_POLICY` — APW-10's port, read for FR-56's quarantine through an
 *     optional `isQuarantined(workId)` member (never a direct table read). Until
 *     APW-10 adds that member the marking cannot fire, which is why the seam is
 *     here and tested with a bound fake.
 *
 * Nothing in this class writes any of those tables, and nothing here reads
 * `EVER_WORKS_APPS_MANAGED_ENABLED` (R-5).
 */

/** Who is asking. The controller passes the session user; only the id is read. */
export interface AppLauncherUser {
    id: string;
}

/**
 * The active scope, structurally compatible with `ScopeContext`
 * (`apps/api/src/scope/scope-context.types.ts:21`) — declared here rather than
 * imported because this package never depends on the API.
 */
export interface AppLauncherScope {
    tenantId?: string | null;
    /** `null`/absent means the person's personal scope (spec FR-24). */
    organizationId?: string | null;
}

/**
 * One Ever app the caller resolved from the platform catalog (plan §4.3).
 *
 * A structural subset of {@link AppLauncherItem}, so the
 * `PlatformCatalogService.list(environment)` result is assignable unchanged, plus
 * `catalogOrder` — FR-11's ordering number, which is what FR-26 sorts the
 * **Ever apps** section by when the person has no stored order.
 */
export interface AppLauncherPlatformInput {
    /** `platform:<catalogId>`. */
    key: string;
    name: string;
    /** `null` for the current platform when the catalog is unavailable (§4.1 step 1). */
    url?: string | null;
    host?: string | null;
    description?: string;
    iconDataUri?: string;
    status?: AppLauncherPlatformStatus;
    /** FR-13's **You're here** entry; also derived from the self id. */
    current?: boolean;
    /** The catalog entry's `order` (FR-11). */
    catalogOrder?: number | null;
}

/** How one read wants the list rendered (plan §4.1, §4.2:433-435). */
export interface AppLauncherListOptions {
    /** `true` = **Manage apps**: hidden and not-live items are included (FR-27, FR-63). */
    includeHidden?: boolean;
    /** The response cap, 1..200; the ordering module clamps it (FR-34). */
    limit?: number;
    /**
     * FR-63's filter — the text a person typed into **Manage apps**' filter box,
     * applied to the **eligible set before** the ordering module's cap so an
     * item past the cap is still reachable (spec.md:303-305).
     *
     * Matching is a case- and accent-insensitive substring test on the item's
     * name (`./launcher-filter.ts`); a blank or whitespace-only filter is
     * no filter at all, never "match nothing". The eligible count the response
     * reports (`meta.total`) is counted **before** this filter, so a filtered
     * answer still tells the client how many items the scope holds.
     */
    filter?: string;
    /** The environment the addresses belong to (FR-10); defaults to the catalog's. */
    environment?: AppLauncherEnvironment;
    /** The catalog version read, echoed in `meta` (S9/S10). */
    catalogVersion?: string | null;
    /** `false` when the catalog could not be read; defaults to "any platform handed in". */
    catalogAvailable?: boolean;
}

/**
 * One `work_app_runtime_states` row as far as the launcher reads it (APW-06 T17,
 * plan §7.2:1060-1062). Only the three fields FR-56 needs; a row carries many
 * more and this epic reads none of them.
 */
export interface WorkAppRuntimeStateSnapshot {
    workId: string;
    /** `paused` — the App Work is stopped by its owner. */
    paused?: boolean | null;
    /** `pausedAt` — a pause time without the flag still means paused. */
    pausedAt?: Date | string | number | null;
    /** `removedAt` — the runtime was removed. */
    removedAt?: Date | string | number | null;
}

/**
 * APW-06 T17's `WorkAppRuntimeStateRepository` as the launcher consumes it.
 *
 * `findStateForWorks` is the one **new batch** method APW-11 asks for (T5's task
 * text names it), so a panel with 200 Works costs one query. The seam tolerates
 * both a `Map` keyed by Work id and a plain array, because APW-06 owns the final
 * shape and neither reading costs this epic anything.
 */
export interface WorkAppRuntimeStateReader {
    findStateForWorks(
        workIds: string[],
    ): Promise<
        Map<string, WorkAppRuntimeStateSnapshot> | WorkAppRuntimeStateSnapshot[] | null | undefined
    >;
}

/** DI token for {@link WorkAppRuntimeStateReader} — bound by APW-06 T17. */
export const WORK_APP_RUNTIME_STATES = Symbol('WORK_APP_RUNTIME_STATES');

/**
 * APW-03's `WorkAppSpecState.displayName` as the launcher consumes it.
 *
 * FR-57's first preference is the App spec's own display name — already carrying
 * any community-build suffix the platform appends — and the Work's name is only
 * the fallback. A batch read keeps it to one query per listing.
 */
export interface AppSpecDisplayNameReader {
    findDisplayNamesForWorks(
        workIds: string[],
    ): Promise<Map<string, string | null> | Record<string, string | null> | null | undefined>;
}

/** DI token for {@link AppSpecDisplayNameReader} — bound by APW-03. */
export const APP_SPEC_DISPLAY_NAMES = Symbol('APP_SPEC_DISPLAY_NAMES');

/**
 * The optional member APW-10 adds to its `AppsTierPolicy` implementation when a
 * per-Work quarantine becomes part of the port (plan §4.1's audit table: "APW-10's
 * quarantine is read through the same optional injection of its `AppsTierPolicy`
 * port, never by a direct table read").
 *
 * Deliberately optional: APW-06's port declares no such member today, so a bound
 * implementation answers "not quarantined" by simply not having it.
 */
export interface AppsTierQuarantineReader {
    isQuarantined?(workId: string): boolean | Promise<boolean>;
}

/** The self id `EVER_WORKS_PLATFORM_CATALOG_SELF_ID` defaults to (CONTRACTS §7). */
export const LAUNCHER_SELF_PLATFORM_ID_DEFAULT = 'ever-works';

/**
 * The FR-58 chip of one production deployment row.
 *
 * A closed table over the eleven stored states of `APP_DEPLOYMENT_STATES`
 * (`packages/contracts/src/apps/app-runtime.ts:143-155`), keyed as `string` so a
 * state a later epic adds chips nothing instead of failing to compile — the
 * fail-safe direction, because a chip is an addition to a tile and never a
 * reason to build one.
 */
const LAUNCHER_CHIP_BY_DEPLOYMENT_STATE: Readonly<Record<string, AppLauncherWorkChip | null>> = {
    INITIALIZING: 'deploying',
    QUEUED: 'deploying',
    BUILDING: 'deploying',
    DEPLOYING: 'deploying',
    VERIFYING: 'deploying',
    READY: null,
    CANCELED: null,
    SUPERSEDED: null,
    ERROR: 'lastDeployFailed',
    TIMEOUT: 'lastDeployFailed',
    ROLLED_BACK: 'lastDeployFailed',
};

/** One tile while it is being ordered: what the pure ordering module needs, plus the tile's own fields. */
interface LauncherBuiltItem extends LauncherOrderableItem {
    name: string;
    description?: string;
    iconDataUri?: string;
    url: string | null;
    host: string | null;
    current?: boolean;
    status?: AppLauncherPlatformStatus;
    workKind?: string;
    chip?: AppLauncherWorkChip;
    visible: boolean;
    manageState: AppLauncherManageState;
}

/** One projected preference row — what the save is about to leave behind. */
interface ProjectedPreference {
    scopeKey: string;
    itemKey: string;
    visible: boolean;
    pinned: boolean;
    pinOrder: number | null;
    sortOrder: number | null;
}

/** An accepted change, with the scope its row belongs to (FR-24). */
interface AcceptedChange {
    key: string;
    scopeKey: string;
    change: AppLauncherPreferenceChange;
}

@Injectable()
export class AppLauncherService {
    private readonly logger = new Logger(AppLauncherService.name);

    constructor(
        private readonly works: WorkRepository,
        private readonly workMembers: WorkMemberRepository,
        private readonly deployments: WorkDeploymentRepository,
        private readonly domains: WorkCustomDomainRepository,
        private readonly preferences: AppLauncherPreferenceRepository,
        // Every dependency below is `@Optional()` and appended after the required
        // repositories, in a stable order, so a hand-rolled construction (a unit
        // test, a lean CLI context) can pass a prefix of them.
        @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
        @Optional()
        @Inject(MANAGED_HOST_ROOT_RESOLVER)
        private readonly managedHostRoot?: ManagedHostRootResolver,
        @Optional()
        @Inject(APP_PUBLISHED_HOSTS)
        private readonly publishedHosts?: AppPublishedHostsPort,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: WorkAppRuntimeStateReader,
        @Optional() @Inject(APPS_TIER_POLICY) private readonly tierPolicy?: AppsTierPolicy,
        @Optional()
        @Inject(APP_SPEC_DISPLAY_NAMES)
        private readonly specDisplayNames?: AppSpecDisplayNameReader,
    ) {}

    // ── §4.1 — the read ──────────────────────────────────────────────────────

    /**
     * `GET /api/me/apps` — the merged, ordered list of FR-2's sections plus the
     * facts a client must not re-derive (plan §4.1).
     *
     * A request with no person reads nothing and answers an empty list: every read
     * is scoped to the signed-in person (FR-53), and the controller is
     * session-guarded, so there is nothing for an anonymous caller to see.
     *
     * `options.filter` is FR-63's **Manage apps** filter: it narrows the
     * **eligible** set before the response cap, so an item past the cap is still
     * reachable, and it never moves `meta.total` — the eligible count, which is
     * what FR-63's counted line reports.
     */
    async listForUser(
        user: AppLauncherUser | null | undefined,
        scope: AppLauncherScope | null | undefined,
        platforms: ReadonlyArray<AppLauncherPlatformInput> | null | undefined,
        options: AppLauncherListOptions = {},
    ): Promise<AppLauncherListResponse> {
        const userId = typeof user?.id === 'string' ? user.id : '';
        const scopeKey = this.scopeKeyFor(scope);
        const catalog = Array.isArray(platforms) ? platforms : [];
        const selfKey = this.selfPlatformKey();

        if (!userId) {
            return {
                items: [],
                meta: {
                    environment: this.resolveEnvironment(options.environment),
                    catalogVersion: options.catalogVersion ?? null,
                    catalogAvailable: options.catalogAvailable ?? catalog.length > 0,
                    scopeKey,
                    worksTotal: 0,
                    // An anonymous read has no eligible set to count — and this
                    // early return is a response like any other, so it owes the
                    // client every field (FR-63).
                    total: 0,
                    truncated: false,
                    pinLimit: APP_LAUNCHER_PIN_LIMIT,
                    appWorksAvailable: this.appWorksAvailable(),
                },
            };
        }

        const [workItems, storedRows] = await Promise.all([
            this.buildWorkItems(userId, scope),
            this.preferences.findForUser(userId, scopeKeysFor(scopeKey)),
        ]);

        const built: LauncherBuiltItem[] = [
            ...this.buildPlatformItems(catalog, selfKey),
            ...workItems,
        ];

        // FR-27's **Show** control is a property of the merged view, and the panel
        // filter reads the item's own flag: a stored `false` must therefore be
        // resolved onto the item here, not only onto the row the ordering module
        // reports. An item nobody has touched keeps FR-27's default — shown.
        const merged = mergeLauncherPreferences(
            this.asOrderRows(storedRows, selfKey),
            scopeKeysFor(scopeKey),
        );
        for (const item of built) {
            item.visible = merged.get(item.key)?.visible ?? true;
        }

        const ordered = orderLauncherItems(built, this.asOrderRows(storedRows, selfKey), {
            scopeKey,
            includeHidden: options.includeHidden === true,
            limit: options.limit,
            filter: options.filter,
        });

        return {
            items: ordered.items.map((entry) => toAppLauncherItem(entry)),
            meta: {
                environment: this.resolveEnvironment(options.environment),
                catalogVersion: options.catalogVersion ?? null,
                catalogAvailable: options.catalogAvailable ?? catalog.length > 0,
                scopeKey,
                worksTotal: ordered.worksTotal,
                // FR-63's `{count}`: the eligible set, counted before the filter
                // and before the cap by the ordering module.
                total: ordered.total,
                truncated: ordered.truncated,
                pinLimit: APP_LAUNCHER_PIN_LIMIT,
                appWorksAvailable: this.appWorksAvailable(),
            },
        };
    }

    // ── §4.2 — the save ─────────────────────────────────────────────────────

    /**
     * `PUT /api/me/apps/preferences` — merge-patch per item, pin orders recomputed,
     * the whole save refused on the pin limit, then the 500-row prune (plan §4.2).
     *
     * The steps are the plan's, in its order, and each is observable:
     *
     *   1. the eligible key set — the catalog's keys, `platform:<selfId>` and the
     *      candidate Works **in scope**, not only the live ones, because **Manage
     *      apps** edits not-live rows too (spec S12);
     *   2. a key outside that set is rejected with one identical reason
     *      ({@link AppLauncherRejection}) — the same answer for "does not exist"
     *      and "not yours", so a save cannot be used to probe for another
     *      Organization's Works (spec S18, FR-35);
     *   3. inside one transaction: load `global` ∪ `<active scope>`, apply the
     *      patch, recompute the merged pinned sequence, and refuse **everything**
     *      by throwing {@link AppLauncherPinLimitError} if more than
     *      {@link APP_LAUNCHER_PIN_LIMIT} items would be pinned (FR-25, FR-62);
     *   4. `upsertMany` — last-write-wins per item, so two tabs changing different
     *      tiles both persist (FR-29, ACC-11-20);
     *   5. `pruneIneligible` — only rows whose item is no longer eligible, oldest
     *      first, and never an eligible one (FR-28).
     *
     * Rows are written only when a value actually changes, which is what makes a
     * re-sent save a no-op — including `updatedAt`, FR-62's pin-time tie-break.
     */
    async savePreferences(
        userId: string,
        scope: AppLauncherScope | null | undefined,
        changes: ReadonlyArray<AppLauncherPreferenceChange> | null | undefined,
        platforms?: ReadonlyArray<AppLauncherPlatformInput> | null,
    ): Promise<AppLauncherSavePreferencesResponse> {
        const person = typeof userId === 'string' ? userId : '';
        const scopeKey = this.scopeKeyFor(scope);
        const scopeKeyList = scopeKeysFor(scopeKey);
        const selfKey = this.selfPlatformKey();
        const requested = Array.isArray(changes) ? changes : [];

        if (!person) {
            return { saved: 0, rejected: [], items: [] };
        }

        const eligible = await this.eligibleKeys(person, scope, platforms, selfKey);
        const rejected: AppLauncherRejection[] = [];
        const accepted: AcceptedChange[] = [];

        for (const change of requested) {
            const key = typeof change?.key === 'string' ? change.key : '';
            if (!eligible.has(key)) {
                rejected.push({ key, reason: 'unknownItem' });
                continue;
            }
            // FR-13 — the platform the launcher is running inside cannot be hidden.
            if (key === selfKey && change.visible === false) {
                rejected.push({ key, reason: 'cannotHideCurrent' });
                continue;
            }
            accepted.push({ key, scopeKey: preferenceScopeKeyFor(key, scopeKey), change });
        }

        if (accepted.length > 0) {
            await this.inTransaction(async (manager) => {
                const stored = await this.preferences.findForUser(person, scopeKeyList);
                const projected = projectPreferenceRows(stored, accepted, scopeKeyList);
                const pinnedKeys = nextPinnedSequence(stored, accepted, scopeKeyList);
                if (appLauncherPinLimitExceeded(pinnedKeys.length)) {
                    // The whole save is refused: nothing above this line has written
                    // anything, and the transaction rolls back regardless (FR-25).
                    throw new AppLauncherPinLimitError();
                }

                const pinOrderOf = new Map(pinnedKeys.map((key, index) => [key, index]));
                const withOrders = projected.map((row) => ({
                    ...row,
                    pinOrder: row.pinned ? (pinOrderOf.get(row.itemKey) ?? null) : null,
                }));

                const upserts = changedPreferenceRows(stored, withOrders);
                if (upserts.length > 0) {
                    await this.preferences.upsertMany(person, upserts, manager);
                }
                await this.preferences.pruneIneligible(
                    person,
                    [...eligible],
                    APP_LAUNCHER_MAX_PREFERENCE_ROWS,
                    manager,
                );
            });
        }

        const listed = await this.listForUser({ id: person }, scope, platforms, {
            includeHidden: true,
        });

        return { saved: accepted.length, rejected, items: listed.items };
    }

    // ── the candidate set and the batched reads (plan §4.1 steps 2-3) ───────

    /** `creator-or-member`, not archived, in scope, newest first (FR-17, FR-24). */
    private async candidates(
        userId: string,
        scope: AppLauncherScope | null | undefined,
    ): Promise<Work[]> {
        const memberWorkIds = await this.workMembers.getAccessibleWorkIds(userId);
        return this.works.findLauncherCandidates({
            userId,
            memberWorkIds,
            organizationId: organizationIdOf(scope),
            limit: LAUNCHER_CANDIDATE_LIMIT_MAX,
        });
    }

    /** Every key a save may name, in scope — live or not (plan §4.2 step 1). */
    private async eligibleKeys(
        userId: string,
        scope: AppLauncherScope | null | undefined,
        platforms: ReadonlyArray<AppLauncherPlatformInput> | null | undefined,
        selfKey: string,
    ): Promise<Set<string>> {
        const keys = new Set<string>([selfKey]);
        for (const platform of Array.isArray(platforms) ? platforms : []) {
            const key = typeof platform?.key === 'string' ? platform.key : '';
            if (key.length > 0) {
                keys.add(key);
            }
        }
        for (const work of await this.candidates(userId, scope)) {
            keys.add(workKeyOf(work.id));
        }
        return keys;
    }

    /** Build every Work tile of one request from four batched reads. */
    private async buildWorkItems(
        userId: string,
        scope: AppLauncherScope | null | undefined,
    ): Promise<LauncherBuiltItem[]> {
        const candidates = await this.candidates(userId, scope);
        const workIds = candidates.map((work) => work.id);
        const appWorkIds = candidates
            .filter((work) => isLauncherAppWorkKind(work.kind))
            .map((work) => work.id);

        const [latest, latestReady, domains, runtimeStates, quarantined, published, names] =
            await Promise.all([
                this.latestProductionDeployments(workIds),
                this.latestReadyProductionDeployments(workIds),
                this.verifiedProductionDomains(workIds),
                this.runtimeStateByWork(workIds),
                this.quarantinedWorkIds(appWorkIds),
                this.publishedPrimaryHosts(appWorkIds),
                this.specDisplayNamesByWork(workIds),
            ]);

        const allowHttpLocalhost = this.allowHttpLocalhost();

        return candidates.map((work) => {
            const isApp = isLauncherAppWorkKind(work.kind);
            const state = runtimeStates.get(work.id);
            const ready = latestReady.get(work.id);
            const address = this.resolveAddressFor(work, {
                isApp,
                domains: domains.get(work.id) ?? [],
                latestReadyWebsite: ready?.website ?? null,
                publishedPrimaryUrl: published.get(work.id) ?? null,
                allowHttpLocalhost,
            });

            // FR-15 (live = an address **and** a successful production deployment)
            // and FR-56 (paused, removed or quarantined is not live either).
            const live = isNotRunning(state, quarantined.has(work.id))
                ? false
                : Boolean(ready) && address !== null;
            const exposed =
                typeof work.appLauncherExposed === 'boolean' ? work.appLauncherExposed : isApp;
            const manageState: AppLauncherManageState = !live
                ? 'notLive'
                : exposed
                  ? 'listed'
                  : 'exposureOff';
            const listed = manageState === 'listed';

            return {
                key: workKeyOf(work.id),
                kind: 'work' as const,
                name: launcherItemName(names.get(work.id) ?? work.name, work.id),
                url: listed && address ? address.url : null,
                host: listed && address ? address.host : null,
                workKind: typeof work.kind === 'string' ? work.kind : undefined,
                chip: chipForDeploymentState(latest.get(work.id)?.state),
                visible: true,
                manageState,
                readyAt: ready?.completedAt ?? ready?.createdAt ?? null,
            } satisfies LauncherBuiltItem;
        });
    }

    /**
     * FR-16 and FR-55: the published primary address wins for a kind-`app` Work,
     * and only when the platform publishes none does the FR-16 order apply.
     */
    private resolveAddressFor(
        work: Work,
        input: {
            isApp: boolean;
            domains: ReadonlyArray<WorkCustomDomain>;
            latestReadyWebsite: string | null;
            publishedPrimaryUrl: string | null;
            allowHttpLocalhost: boolean;
        },
    ): LauncherAddress | null {
        const shared = {
            verifiedProductionDomains: input.domains.map((domain) => ({
                domain: domain.domain,
                createdAt: domain.createdAt,
            })),
            managedSubdomain: work.managedSubdomain ?? null,
            // `null` skips the synthesised candidate rather than inventing a host.
            managedRoot: this.managedHostRootFor(work),
            latestReadyWebsite: input.latestReadyWebsite,
            allowHttpLocalhost: input.allowHttpLocalhost,
        };

        if (!input.isApp) {
            return resolveLauncherAddress(shared);
        }
        return resolveAppWorkAddress({
            ...shared,
            publishedPrimaryUrl: input.publishedPrimaryUrl,
        });
    }

    /** The apex this Work's managed label lives under, through the bound port. */
    private managedHostRootFor(work: Work): string | null {
        const resolver = this.managedHostRoot ?? DEFAULT_MANAGED_HOST_ROOT_RESOLVER;
        try {
            return resolver.resolve(work) ?? null;
        } catch (error) {
            this.logger.warn(
                `App Launcher: the managed host root resolver failed for work ${work.id} (${errorText(error)}); skipping the managed-subdomain candidate.`,
            );
            return null;
        }
    }

    /**
     * Ever app tiles: the caller's catalog, with FR-13's **You're here** derived
     * from the self id as well as from the entry's own flag.
     *
     * An entry whose address cannot be a safe launcher address is dropped unless it
     * is the current platform, which must always be renderable (§4.1 step 1's
     * outage fallback carries no address at all). `url` and `host` travel together:
     * a tile never reports a host it cannot open.
     */
    private buildPlatformItems(
        platforms: ReadonlyArray<AppLauncherPlatformInput>,
        selfKey: string,
    ): LauncherBuiltItem[] {
        const allowHttpLocalhost = this.allowHttpLocalhost();
        const items: LauncherBuiltItem[] = [];

        for (const platform of platforms) {
            const key = typeof platform?.key === 'string' ? platform.key : '';
            if (key.length === 0) {
                continue;
            }
            const current = platform.current === true || key === selfKey;
            const address = toSafeLauncherUrl(platform.url, { allowHttpLocalhost });
            if (!address && !current) {
                // FR-10/FR-11: an entry with no address for this environment is
                // not shown — the launcher never sends a person to another one.
                continue;
            }
            items.push({
                key,
                kind: 'platform' as const,
                name: launcherItemName(platform.name, key),
                description: nonEmpty(platform.description),
                iconDataUri: nonEmpty(platform.iconDataUri),
                url: address ? address.url : null,
                host: address ? address.host : null,
                current: current ? true : undefined,
                status:
                    platform.status === 'available' || platform.status === 'beta'
                        ? platform.status
                        : undefined,
                catalogOrder:
                    typeof platform.catalogOrder === 'number' ? platform.catalogOrder : null,
                visible: true,
                manageState: 'listed' as const,
            });
        }

        return items;
    }

    private async latestProductionDeployments(
        workIds: string[],
    ): Promise<Map<string, WorkDeployment>> {
        if (workIds.length === 0) {
            return new Map();
        }
        return this.deployments.findLatestForWorks(workIds, DeploymentEnvironment.PRODUCTION);
    }

    private async latestReadyProductionDeployments(
        workIds: string[],
    ): Promise<Map<string, WorkDeployment>> {
        if (workIds.length === 0) {
            return new Map();
        }
        return this.deployments.findLatestReadyForWorks(workIds, DeploymentEnvironment.PRODUCTION);
    }

    private async verifiedProductionDomains(
        workIds: string[],
    ): Promise<Map<string, WorkCustomDomain[]>> {
        if (workIds.length === 0) {
            return new Map();
        }
        return this.domains.findVerifiedProductionForWorks(workIds);
    }

    /**
     * FR-56's pause and removal, from APW-06's runtime-state rows.
     *
     * Fail-open on purpose: an unbound port, an empty answer or a failed read all
     * mean "not paused". The alternative — treating "I could not read the pause
     * table" as "everything is paused" — would empty every panel the first time
     * APW-06's worker is unreachable, and FR-56's guarantee is about a Work that
     * **is** paused, not about one nobody could ask about.
     */
    private async runtimeStateByWork(
        workIds: string[],
    ): Promise<Map<string, WorkAppRuntimeStateSnapshot>> {
        const reader = this.runtimeStates;
        if (!reader || workIds.length === 0 || typeof reader.findStateForWorks !== 'function') {
            return new Map();
        }
        try {
            const answer = await reader.findStateForWorks(workIds);
            const states = new Map<string, WorkAppRuntimeStateSnapshot>();
            if (answer instanceof Map) {
                for (const [workId, state] of answer) {
                    if (state) {
                        states.set(workId, state);
                    }
                }
            } else if (Array.isArray(answer)) {
                for (const state of answer) {
                    if (state && typeof state.workId === 'string') {
                        states.set(state.workId, state);
                    }
                }
            }
            return states;
        } catch (error) {
            this.logger.warn(
                `App Launcher: the App runtime state read failed (${errorText(error)}); treating every Work as not paused.`,
            );
            return new Map();
        }
    }

    /**
     * FR-56's quarantine, asked of the policy port and never of APW-10's table.
     *
     * Only kind-`app` Works are asked: quarantine is a property of tier-hosted
     * workloads, and a non-App Work cannot be in that table.
     */
    private async quarantinedWorkIds(workIds: string[]): Promise<Set<string>> {
        const reader = this.tierPolicy as (AppsTierPolicy & AppsTierQuarantineReader) | undefined;
        const quarantined = new Set<string>();
        if (!reader || workIds.length === 0 || typeof reader.isQuarantined !== 'function') {
            return quarantined;
        }
        await Promise.all(
            workIds.map(async (workId) => {
                try {
                    if ((await reader.isQuarantined?.(workId)) === true) {
                        quarantined.add(workId);
                    }
                } catch (error) {
                    this.logger.warn(
                        `App Launcher: the quarantine check failed for work ${workId} (${errorText(error)}); treating it as not quarantined.`,
                    );
                }
            }),
        );
        return quarantined;
    }

    /** FR-55's first preference: what the platform publishes for the App Work. */
    private async publishedPrimaryHosts(workIds: string[]): Promise<Map<string, string>> {
        const published = new Map<string, string>();
        const port = this.publishedHosts;
        if (!port || workIds.length === 0 || typeof port.primary !== 'function') {
            return published;
        }
        await Promise.all(
            workIds.map(async (workId) => {
                try {
                    const address = await port.primary(workId);
                    if (typeof address === 'string' && address.trim().length > 0) {
                        published.set(workId, address);
                    }
                } catch (error) {
                    this.logger.warn(
                        `App Launcher: the published host read failed for work ${workId} (${errorText(error)}); falling back to the FR-16 order.`,
                    );
                }
            }),
        );
        return published;
    }

    /** FR-57's first preference: the App spec's own display name. */
    private async specDisplayNamesByWork(workIds: string[]): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        const reader = this.specDisplayNames;
        if (
            !reader ||
            workIds.length === 0 ||
            typeof reader.findDisplayNamesForWorks !== 'function'
        ) {
            return names;
        }
        try {
            const answer = await reader.findDisplayNamesForWorks(workIds);
            const entries =
                answer instanceof Map
                    ? [...answer.entries()]
                    : answer && typeof answer === 'object'
                      ? Object.entries(answer)
                      : [];
            for (const [workId, name] of entries) {
                if (typeof name === 'string' && name.trim().length > 0) {
                    names.set(workId, name);
                }
            }
        } catch (error) {
            this.logger.warn(
                `App Launcher: the App spec display-name read failed (${errorText(error)}); falling back to the Work name.`,
            );
        }
        return names;
    }

    // ── scope, environment and flags ────────────────────────────────────────

    /** FR-24: `personal`, or the active Organization's id. */
    private scopeKeyFor(scope: AppLauncherScope | null | undefined): string {
        return organizationIdOf(scope) ?? LAUNCHER_PERSONAL_SCOPE_KEY;
    }

    /**
     * The self platform's key — the one FR-13's tile uses and the one a save may
     * never hide. `EVER_WORKS_PLATFORM_CATALOG_SELF_ID` when set, else the
     * documented `ever-works` (CONTRACTS §7).
     */
    private selfPlatformKey(): string {
        const id =
            process.env.EVER_WORKS_PLATFORM_CATALOG_SELF_ID?.trim() ||
            LAUNCHER_SELF_PLATFORM_ID_DEFAULT;
        return `platform:${id}`;
    }

    /** FR-10: the environment whose addresses these are. */
    private resolveEnvironment(explicit?: AppLauncherEnvironment): AppLauncherEnvironment {
        if (isAppLauncherEnvironment(explicit)) {
            return explicit;
        }
        const configured = process.env.EVER_WORKS_PLATFORM_CATALOG_ENV?.trim();
        return isAppLauncherEnvironment(configured) ? configured : 'production';
    }

    /**
     * FR-64's `meta.appWorksAvailable` — the App Works gate R-6 names, from
     * `process.env` until APW-01's accessor lands (plan §4.1).
     *
     * Fail-closed (`false` unless the value is a truthy flag) and read with the
     * same accepted spellings as the launcher's own install switch, so the empty
     * state the panel offers and the API that serves it cannot disagree about
     * whether App Works are available.
     */
    private appWorksAvailable(): boolean {
        const value = process.env.EVER_WORKS_APP_WORKS_ENABLED?.trim().toLowerCase();
        return value === 'true' || value === '1' || value === 'yes';
    }

    /** Plan §4.6:522 — FR-32's localhost exception exists outside production only. */
    private allowHttpLocalhost(): boolean {
        return process.env.NODE_ENV !== 'production';
    }

    /**
     * The stored rows as the ordering module reads them.
     *
     * The current platform's `visible` is forced to `true` here (FR-13): a stored
     * `false` could only come from a writer that ignored the rule, and a read must
     * not let the **You're here** tile disappear because of one.
     */
    private asOrderRows(
        rows: ReadonlyArray<AppLauncherPreference>,
        selfKey: string,
    ): LauncherOrderPreference[] {
        return (rows ?? []).map((row) => ({
            key: row.itemKey,
            scopeKey: row.scopeKey,
            visible: row.itemKey === selfKey ? true : row.visible !== false,
            pinned: row.pinned === true,
            pinOrder: typeof row.pinOrder === 'number' ? row.pinOrder : null,
            sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : null,
            updatedAt: row.updatedAt ?? null,
        }));
    }

    /** The transaction's manager when a DataSource is bound, or no manager at all. */
    private async inTransaction<T>(work: (manager?: EntityManager) => Promise<T>): Promise<T> {
        const dataSource = this.dataSource;
        if (!dataSource || typeof dataSource.transaction !== 'function') {
            return work(undefined);
        }
        return dataSource.transaction((manager) => work(manager));
    }
}

// ── pure helpers (module scope: no `this`, no I/O) ───────────────────────────

/** `['global', <active>]`, deduped — FR-62's merged view for one request. */
function scopeKeysFor(scopeKey: string): string[] {
    return scopeKey === LAUNCHER_GLOBAL_SCOPE_KEY
        ? [LAUNCHER_GLOBAL_SCOPE_KEY]
        : [LAUNCHER_GLOBAL_SCOPE_KEY, scopeKey];
}

/** FR-24: Ever app rows are `global`; Work rows belong to the active scope. */
function preferenceScopeKeyFor(key: string, activeScopeKey: string): string {
    return key.startsWith('platform:') ? LAUNCHER_GLOBAL_SCOPE_KEY : activeScopeKey;
}

function workKeyOf(workId: string): string {
    return `work:${workId}`;
}

function organizationIdOf(scope: AppLauncherScope | null | undefined): string | null {
    const organizationId =
        typeof scope?.organizationId === 'string' ? scope.organizationId.trim() : '';
    return organizationId.length > 0 ? organizationId : null;
}

/** A `string` field that survives a round trip through `JSON.stringify`. */
function nonEmpty(value: string | null | undefined): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * FR-58: the one chip the latest production deployment row earns.
 *
 * An unknown state chips nothing — a chip is an addition to a tile, never a reason
 * to hide one, so the fail-safe direction is "no chip" (see
 * {@link LAUNCHER_CHIP_BY_DEPLOYMENT_STATE}).
 */
function chipForDeploymentState(state: string | null | undefined): AppLauncherWorkChip | undefined {
    if (typeof state !== 'string') {
        return undefined;
    }
    return LAUNCHER_CHIP_BY_DEPLOYMENT_STATE[state.trim().toUpperCase()] ?? undefined;
}

/** FR-56: paused or removed (and, from APW-10, quarantined) is not live. */
function isNotRunning(
    state: WorkAppRuntimeStateSnapshot | undefined,
    quarantined: boolean,
): boolean {
    if (quarantined) {
        return true;
    }
    if (!state) {
        return false;
    }
    const paused = state.paused === true || (state.paused == null && state.pausedAt != null);
    return paused || state.removedAt != null;
}

/**
 * FR-57: the item's name, capped at {@link APP_LAUNCHER_NAME_MAX_LENGTH}.
 *
 * The App spec's display name is already the full name including any
 * community-build suffix the platform appends (`Cal.diy (community build)`), so
 * the cap must not cut that suffix in half. Two rules do it, in this order:
 *
 *   1. a **complete** trailing parenthetical is kept whole — the name before it is
 *      shortened at a word boundary so the suffix still fits;
 *   2. otherwise the name is cut at a word boundary, and a parenthetical the cut
 *      left half-written is discarded rather than shown.
 *
 * A name that is one long word has no boundary to cut at, and is then cut at the
 * cap: showing 100 characters of it is better than showing nothing.
 */
function launcherItemName(raw: string | null | undefined, fallback: string): string {
    const name =
        (typeof raw === 'string' ? raw.trim() : '') ||
        (typeof fallback === 'string' ? fallback.trim() : '');
    return capLauncherName(name, APP_LAUNCHER_NAME_MAX_LENGTH);
}

/** {@link launcherItemName}'s cap, exposed for reuse by the controller's own tests. */
export function capLauncherName(value: string, cap: number = APP_LAUNCHER_NAME_MAX_LENGTH): string {
    const name = (value ?? '').trim();
    if (name.length <= cap) {
        return name;
    }

    const group = trailingParenthetical(name);
    if (group) {
        const head = name.slice(0, name.length - group.length);
        const shortened = cutAtWordBoundary(head, cap - group.length);
        if (shortened) {
            return `${shortened}${group}`;
        }
    }

    return (
        dropTrailingPartialParenthetical(cutAtWordBoundary(name, cap)) ||
        name.slice(0, cap).trimEnd()
    );
}

/** `' (community build)'` — the trailing group including the space before it. */
function trailingParenthetical(name: string): string | null {
    const match = /\s\([^()]*\)$/.exec(name);
    return match ? match[0] : null;
}

/** The longest whole-word prefix of `value` that fits in `limit`, or `''`. */
function cutAtWordBoundary(value: string, limit: number): string {
    if (limit <= 0) {
        return '';
    }
    if (value.length <= limit) {
        return value.trimEnd();
    }
    const slice = value.slice(0, limit);
    const boundary = slice.lastIndexOf(' ');
    return boundary > 0 ? slice.slice(0, boundary).trimEnd() : '';
}

/** Drop a `(` the cut left open, so half a suffix is never rendered. */
function dropTrailingPartialParenthetical(value: string): string {
    const open = value.lastIndexOf('(');
    if (open < 0) {
        return value;
    }
    return value.lastIndexOf(')') > open ? value : value.slice(0, open).trimEnd();
}

/** The stored rows plus the accepted changes — plan §4.2 step 3's merge patch. */
function projectPreferenceRows(
    stored: ReadonlyArray<AppLauncherPreference>,
    accepted: ReadonlyArray<AcceptedChange>,
    scopeKeys: ReadonlyArray<string>,
): ProjectedPreference[] {
    const byId = new Map<string, ProjectedPreference>();

    for (const row of stored ?? []) {
        if (!row || typeof row.itemKey !== 'string' || !scopeKeys.includes(row.scopeKey)) {
            continue;
        }
        byId.set(preferenceRowId(row.scopeKey, row.itemKey), {
            scopeKey: row.scopeKey,
            itemKey: row.itemKey,
            visible: row.visible !== false,
            pinned: row.pinned === true,
            pinOrder: typeof row.pinOrder === 'number' ? row.pinOrder : null,
            sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : null,
        });
    }

    for (const entry of accepted) {
        const id = preferenceRowId(entry.scopeKey, entry.key);
        const row: ProjectedPreference = byId.get(id) ?? {
            scopeKey: entry.scopeKey,
            itemKey: entry.key,
            visible: true,
            pinned: false,
            pinOrder: null,
            sortOrder: null,
        };
        // A merge patch: an absent field keeps its stored value (FR-29), and a field
        // of the wrong type is ignored rather than written (the DTO is what answers
        // `400` for a malformed body, plan §4.5).
        if (typeof entry.change.visible === 'boolean') {
            row.visible = entry.change.visible;
        }
        if (typeof entry.change.pinned === 'boolean') {
            row.pinned = entry.change.pinned;
        }
        if (isLauncherSortOrder(entry.change.order)) {
            row.sortOrder = Math.trunc(entry.change.order);
        }
        byId.set(id, row);
    }

    return [...byId.values()];
}

/**
 * FR-62's pinned sequence after the patch: the merged view's current order, with
 * released pins removed and new pins appended **after the current last pin**, in
 * the order the save listed them.
 */
function nextPinnedSequence(
    stored: ReadonlyArray<AppLauncherPreference>,
    accepted: ReadonlyArray<AcceptedChange>,
    scopeKeys: ReadonlyArray<string>,
): string[] {
    const sequence = mergedPinnedKeys(
        (stored ?? []).map((row) => ({
            key: row.itemKey,
            scopeKey: row.scopeKey,
            visible: row.visible !== false,
            pinned: row.pinned === true,
            pinOrder: typeof row.pinOrder === 'number' ? row.pinOrder : null,
            sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : null,
            updatedAt: row.updatedAt ?? null,
        })),
        scopeKeys,
    );

    for (const entry of accepted) {
        if (typeof entry.change.pinned !== 'boolean') {
            continue;
        }
        const at = sequence.indexOf(entry.key);
        if (entry.change.pinned) {
            if (at < 0) {
                sequence.push(entry.key);
            }
        } else if (at >= 0) {
            sequence.splice(at, 1);
        }
    }

    return sequence;
}

/**
 * Only the rows a save actually changes, so re-sending the same values writes
 * nothing at all — including `updatedAt`, which FR-62 uses as its pin-time
 * tie-break and which a needless rewrite would move.
 */
function changedPreferenceRows(
    stored: ReadonlyArray<AppLauncherPreference>,
    projected: ReadonlyArray<ProjectedPreference>,
): ProjectedPreference[] {
    const before = new Map<string, ProjectedPreference>();
    for (const row of stored ?? []) {
        if (!row || typeof row.itemKey !== 'string') {
            continue;
        }
        before.set(preferenceRowId(row.scopeKey, row.itemKey), {
            scopeKey: row.scopeKey,
            itemKey: row.itemKey,
            visible: row.visible !== false,
            pinned: row.pinned === true,
            pinOrder: typeof row.pinOrder === 'number' ? row.pinOrder : null,
            sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : null,
        });
    }

    return projected.filter((row) => {
        const previous = before.get(preferenceRowId(row.scopeKey, row.itemKey));
        if (!previous) {
            // A key that had no row and whose patch left every value at its column
            // default is not written at all: FR-27's "absent everywhere means shown"
            // is already the answer, and a save that only re-states a default must
            // not create a row (FR-29's idempotency, and FR-28's 500-row ceiling).
            return !isDefaultPreferenceRow(row);
        }
        return (
            previous.visible !== row.visible ||
            previous.pinned !== row.pinned ||
            previous.pinOrder !== row.pinOrder ||
            previous.sortOrder !== row.sortOrder
        );
    });
}

/** Whether a projected row carries nothing but the table's own column defaults. */
function isDefaultPreferenceRow(row: ProjectedPreference): boolean {
    return row.visible === true && !row.pinned && row.pinOrder === null && row.sortOrder === null;
}

/** A row's identity: the table's unique key, without depending on a separator being unused. */
function preferenceRowId(scopeKey: string, itemKey: string): string {
    return `${scopeKey}\u0000${itemKey}`;
}

/** Plan §4.2:405 — `order` is `0..9999`; anything else keeps the stored value. */
function isLauncherSortOrder(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999;
}

/** The contract's tile, with the ordering module's decisions folded in. */
function toAppLauncherItem(ordered: LauncherOrderedItem<LauncherBuiltItem>): AppLauncherItem {
    const item = ordered.item;
    return {
        key: ordered.key,
        kind: ordered.kind,
        section: ordered.section,
        name: item.name,
        description: item.description,
        iconDataUri: item.iconDataUri,
        url: item.url,
        host: item.host,
        current: item.current,
        status: item.status,
        workKind: item.workKind,
        chip: item.chip,
        visible: ordered.visible,
        pinned: ordered.pinned,
        pinOrder: ordered.pinOrder,
        order: ordered.order,
        manageState: item.manageState,
    };
}

/** An error's message for a log line, with no stack and no address. */
function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === 'string' ? error : 'unknown error';
}
