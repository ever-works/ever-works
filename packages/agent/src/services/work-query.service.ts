import { BadRequestException, HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { WorkMemberRepository } from '@src/database/repositories/work-member.repository';
import { WorkGenerationHistoryRepository } from '@src/database/repositories/work-generation-history.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { User } from '@src/entities/user.entity';
import { Work } from '@src/entities/work.entity';
import { WorkMemberRole, GenerateStatusType, WorkScheduleStatus } from '@src/entities/types';
import { WorkOwnershipService } from './work-ownership.service';
import { normalizeGeneratorError, rethrowAsNormalized } from './utils/error.utils';
import { isRepositoryWork } from '@src/works/repository-work-guard';
import {
    WorkGenerationHistoryDto,
    WorkGenerationHistoryListDto,
} from '@src/dto/work-generation-history.dto';
import { WorkGenerationHistory } from '@src/entities/work-generation-history.entity';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import { WorkWebsiteRepositoryStateService } from './work-website-repository-state.service';
import { WorkDeploymentRepository } from '@src/database/repositories/work-deployment.repository';
import { DeploymentEnvironment, WorkDeployment } from '@src/entities/work-deployment.entity';
import { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { WorkCustomDomain } from '@src/entities/work-custom-domain.entity';
import type { WorkCurrentHealthDto, WorkStatusProjectionDto } from '@ever-works/contracts/api';

/**
 * APW-11 (App Launcher) — the kind whose exposure default is **on**.
 *
 * Compared against the raw `work.kind` column rather than through the
 * `WorkKind` union, because `@ever-works/contracts` does not carry `'app'` in
 * `WORK_KINDS` yet (APW-01 owns that vocabulary). Reading it as a string keeps
 * this file correct on the day the kind lands and cannot narrow anything.
 */
function isAppWorkKind(kind: string | null | undefined): boolean {
    return typeof kind === 'string' && kind.trim().toLowerCase() === 'app';
}

/** Is there a usable, non-blank value here (a host or a label)? */
function hasText(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

// Extended work response type with userRole for API responses
// Uses Omit to exclude class methods from Work, then adds userRole
type WorkMethods =
    | 'getDataRepo'
    | 'getWebsiteRepo'
    | 'getMainRepo'
    | 'shouldGenerateProviderRepository'
    | 'getRepoOwner'
    | 'isCreator'
    | 'getMember'
    | 'hasAccess'
    | 'getUserRole'
    | 'resolveCommitter';

export type WorkWithRole = Omit<Work, WorkMethods> & {
    userRole: WorkMemberRole;
    websiteRepositoryInitialized?: boolean;
    /**
     * APW-11 (App Launcher, plan §4.4) — present on the **Work detail**
     * payload only, so the exposure toggle renders disabled / read-only
     * correctly without a second call. The list payload keeps its existing
     * shape.
     */
    appLauncher?: WorkAppLauncherStatus;
} & WorkStatusProjectionDto;

/**
 * APW-11 (App Launcher, plan §4.4) — the exposure projection the Work detail
 * payload carries.
 *
 *   - `exposed` — the stored choice: `true`, `false`, or `null` for "no
 *     explicit choice, follow the kind default".
 *   - `effectiveExposed` — what the Work actually does today
 *     (`exposed ?? (kind === 'app')`, spec FR-19).
 *   - `live` — whether the launcher has an address to open for this Work, so
 *     the setting is enabled (spec FR-15/FR-23). A not-live Work keeps its
 *     stored choice and shows the setting disabled.
 */
export interface WorkAppLauncherStatus {
    exposed: boolean | null;
    effectiveExposed: boolean;
    live: boolean;
}

@Injectable()
export class WorkQueryService {
    private readonly logger = new Logger(WorkQueryService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly ownershipService: WorkOwnershipService,
        private readonly websiteRepositoryState: WorkWebsiteRepositoryStateService,
        private readonly workDeploymentRepository: WorkDeploymentRepository,
        // Appended last, and `@Optional()`, so every existing positional
        // construction keeps its argument slots (APW-11 T7 — the exposure
        // projection in the Work detail payload). `DatabaseModule` provides
        // and exports the repository, so the real one is injected in
        // production; without it the payload still answers `exposed` /
        // `effectiveExposed` and simply cannot see a verified custom domain.
        @Optional()
        private readonly workCustomDomainRepository?: WorkCustomDomainRepository,
    ) {}

    async getWorks(options: { limit?: number; offset?: number; search?: string } = {}, user: User) {
        const { limit = 20, offset = 0, search } = options;

        let sanitizedSearch: string | undefined;
        if (search) {
            sanitizedSearch = search.trim().slice(0, 100) || undefined;
        }

        try {
            // Get work IDs where user has membership (not as creator)
            const memberWorkIds = await this.workMemberRepository.getAccessibleWorkIds(user.id);

            // Find all works user has access to (as creator or member)
            let works = await this.workRepository.findAllAccessible({
                userId: user.id,
                memberWorkIds,
                limit,
                offset,
                search: sanitizedSearch,
            });

            const workIds = works.map((work) => work.id);
            const workIdsNeedingRecoveredCounts = works
                .filter((dir) => this.shouldRecoverItemsCount(dir))
                .map((dir) => dir.id);
            const nonOwnedWorkIds = works
                .filter((dir) => dir.userId !== user.id)
                .map((dir) => dir.id);
            const [recoveredItemCounts, latestDeployments, memberRoles, total] = await Promise.all([
                this.generationHistoryRepository.findLatestPositiveItemCounts(
                    workIdsNeedingRecoveredCounts,
                ),
                this.workDeploymentRepository.findLatestForWorks(
                    workIds,
                    DeploymentEnvironment.PRODUCTION,
                ),
                this.workMemberRepository.getMemberRolesForWorks(user.id, nonOwnedWorkIds),
                this.workRepository.countAllAccessible({
                    userId: user.id,
                    memberWorkIds,
                    search: sanitizedSearch,
                }),
            ]);

            // Add userRole to each work without additional queries
            const worksWithRoles: WorkWithRole[] = works.map((dir) => {
                dir.owner = dir.getRepoOwner();

                const recoveredItemsCount = recoveredItemCounts.get(dir.id);
                const itemsCount =
                    (dir.itemsCount ?? 0) > 0
                        ? dir.itemsCount
                        : (recoveredItemsCount ?? dir.itemsCount);

                // Creator is always OWNER, otherwise look up member role
                const userRole =
                    dir.userId === user.id
                        ? WorkMemberRole.OWNER
                        : memberRoles.get(dir.id) || WorkMemberRole.VIEWER;

                return {
                    ...dir,
                    itemsCount,
                    userRole,
                    ...this.toStatusProjection(dir, latestDeployments.get(dir.id)),
                } as WorkWithRole;
            });

            // Diagnostic: explicit log when listing returns empty so we can
            // cross-check the user's id against the DB rows when needed.
            if (worksWithRoles.length === 0) {
                this.logger.log(
                    `getWorks: 0 works for user ${user.id} (memberWorkIds=${memberWorkIds.length}, total=${total}, search=${sanitizedSearch ?? 'none'})`,
                );
            }

            return {
                status: 'success',
                works: worksWithRoles,
                total,
                limit,
                offset,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'getting works');
        }
    }

    private shouldRecoverItemsCount(work: Work): boolean {
        if ((work.itemsCount ?? 0) > 0) {
            return false;
        }

        const status = work.generateStatus?.status;
        return (
            status === GenerateStatusType.GENERATING ||
            status === GenerateStatusType.ERROR ||
            status === GenerateStatusType.CANCELLED
        );
    }

    async getStats(user: User) {
        try {
            const memberWorkIds = await this.workMemberRepository.getAccessibleWorkIds(user.id);

            return await this.workRepository.getAccessibleStats({
                userId: user.id,
                memberWorkIds,
            });
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'getting work stats');
        }
    }

    async getWork(id: string, user: User) {
        try {
            const accessResult = await this.ownershipService.ensureAccess(id, user.id);
            const work = accessResult.work;
            work.owner = work.getRepoOwner();
            const websiteRepositoryInitialized = await this.websiteRepositoryState.isInitialized(
                work,
                user,
            );
            const latestDeployment = await this.workDeploymentRepository.findLatest(
                work.id,
                DeploymentEnvironment.PRODUCTION,
            );

            // APW-11 (App Launcher, plan §4.4) — the two reads the exposure
            // projection needs, batched into ONE `Promise.all` and both scoped
            // to this single Work: the newest `READY` production deployment
            // ("has a production deployment ever succeeded", spec FR-15) and
            // this Work's verified production custom domains (FR-16 first
            // preference). `findLatest` above answers a different question —
            // what happened most recently — so it is left alone. The same
            // repository methods T5 added for the launcher service are reused
            // here rather than re-derived.
            const [latestReady, verifiedProductionDomains] = await Promise.all([
                this.findLatestReadyDeployment(work.id),
                this.findVerifiedProductionDomains(work.id),
            ]);

            // Lazy backfill of the denormalised cache columns
            // (configCache + counts). When a Work pre-dates the
            // caching migration its cache is NULL on first read; we
            // clone once here, populate, and serve straight from
            // Postgres on every subsequent load. Strictly best-effort
            // — `refreshDataCache` swallows errors so we never trade
            // a working page for a transient git outage.
            if (
                this.shouldBackfillDataCache(work) &&
                work.generateStatus?.status === GenerateStatusType.GENERATED
            ) {
                const refreshed = await this.dataGenerator.refreshDataCache(work, user);
                if (refreshed) {
                    if (refreshed.configCache !== null) {
                        work.configCache = refreshed.configCache as Work['configCache'];
                    }
                    if (refreshed.companyWebsite !== null) {
                        work.companyWebsite = refreshed.companyWebsite;
                    }
                    if (refreshed.categoriesCount !== null) {
                        work.categoriesCount = refreshed.categoriesCount;
                    }
                    if (refreshed.tagsCount !== null) {
                        work.tagsCount = refreshed.tagsCount;
                    }
                    if (refreshed.comparisonsCount !== null) {
                        work.comparisonsCount = refreshed.comparisonsCount;
                    }
                    if (refreshed.itemsCount !== null) {
                        work.itemsCount = refreshed.itemsCount;
                    }
                }
            }

            // Return work with user's role
            const workWithRole: WorkWithRole = {
                ...work,
                userRole: accessResult.role,
                websiteRepositoryInitialized,
                appLauncher: this.toAppLauncherStatus(work, latestReady, verifiedProductionDomains),
                ...this.toStatusProjection(work, latestDeployment ?? undefined),
            };

            return {
                status: 'success',
                work: workWithRole,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'getting work');
        }
    }

    /**
     * APW-11 (plan §4.4) — one newest `READY` production deployment for this
     * Work, or `null`.
     *
     * Guarded on the method's presence so a context that binds only the older
     * deployment reads (a narrower test double, an existing positional
     * construction) still answers the payload instead of throwing on an
     * undefined call.
     */
    private async findLatestReadyDeployment(workId: string): Promise<WorkDeployment | null> {
        if (typeof this.workDeploymentRepository?.findLatestReadyForWorks !== 'function') {
            return null;
        }

        const rows = await this.workDeploymentRepository.findLatestReadyForWorks(
            [workId],
            DeploymentEnvironment.PRODUCTION,
        );
        return rows?.get(workId) ?? null;
    }

    /**
     * APW-11 (plan §4.4) — this Work's verified **production** custom domains,
     * earliest added first (the order spec FR-16 reads). Empty when the
     * repository is not bound.
     */
    private async findVerifiedProductionDomains(workId: string): Promise<WorkCustomDomain[]> {
        const repository = this.workCustomDomainRepository;
        if (typeof repository?.findVerifiedProductionForWorks !== 'function') {
            return [];
        }

        const grouped = await repository.findVerifiedProductionForWorks([workId]);
        return grouped?.get(workId) ?? [];
    }

    /**
     * APW-11 (plan §4.4, spec FR-15/FR-19/FR-23) — the exposure projection the
     * Work detail payload carries.
     *
     * `effectiveExposed` is the point of the payload: a Work with no explicit
     * choice follows its kind, and an App Work's kind default is **on** while
     * every other kind's is **off** (FR-19). An explicit value always wins,
     * including after the Work's kind changed.
     *
     * `live` is spec FR-15 — a Work is live when it has an address from FR-16
     * **and** at least one production deployment of it has succeeded — plus
     * the Work-level half of FR-56 (an archived Work is never live).
     *
     * DEFERRED, and reported rather than silently assumed: two inputs a
     * *launcher* has and this service does not.
     *
     *   1. The apex a managed label lives under is resolved by
     *      `ManagedHostRootResolver` in `packages/agent/src/app-launcher/**`
     *      (APW-11 T6) — a module this task may not import — so a non-empty
     *      `managedSubdomain` counts as an address candidate here on its own
     *      rather than being paired with a root.
     *   2. FR-56's paused / removed / quarantined App Work states live in
     *      APW-06's and APW-10's tables, which this service does not read.
     *
     * So `live` is correct for the common cases (a `READY` deployment plus a
     * verified domain, a managed label, or the address that deployment
     * reported), and can read `true` for an App Work whose runtime state says
     * otherwise. The launcher's own listing stays the authority on what is
     * listed; this field only decides whether the setting is offered as
     * enabled (FR-23).
     */
    private toAppLauncherStatus(
        work: Work,
        latestReady?: WorkDeployment | null,
        verifiedProductionDomains?: WorkCustomDomain[] | null,
    ): WorkAppLauncherStatus {
        const exposed = work.appLauncherExposed ?? null;

        return {
            exposed,
            // `'app'` is compared against the raw column value: the shared
            // `WorkKind` vocabulary does not carry it yet (APW-01 owns that
            // list), so reading the string keeps this correct the day it lands.
            effectiveExposed: exposed ?? isAppWorkKind(work.kind),
            live: this.isWorkLiveForLauncher(work, latestReady, verifiedProductionDomains),
        };
    }

    /** Spec FR-15 + the Work-level half of FR-56, in FR-16's candidate order. */
    private isWorkLiveForLauncher(
        work: Work,
        latestReady?: WorkDeployment | null,
        verifiedProductionDomains?: WorkCustomDomain[] | null,
    ): boolean {
        // A soft-retired Work is not live — the same exclusion T5's launcher
        // candidate read applies (`status <> 'archived'`).
        if (work.status === 'archived') {
            return false;
        }

        // FR-15: an address alone is not enough. A production deployment must
        // have succeeded, which is exactly what a `READY` row records, so a
        // preview-only or never-deployed Work is not live (ACC-11-13).
        if (!latestReady) {
            return false;
        }

        if ((verifiedProductionDomains ?? []).some((row) => hasText(row?.domain))) {
            return true;
        }

        if (hasText(work.managedSubdomain)) {
            return true;
        }

        return hasText(latestReady.website);
    }

    /** Build the immutable last-run and derived current-health read model. */
    private toStatusProjection(
        work: Work,
        latestDeployment?: WorkDeployment,
    ): WorkStatusProjectionDto {
        const generation = work.generateStatus
            ? {
                  status: work.generateStatus.status,
                  startedAt: this.toIsoString(work.generationStartedAt),
                  finishedAt: this.toIsoString(work.generationFinishedAt),
              }
            : null;
        const deployment = latestDeployment
            ? {
                  status: latestDeployment.state,
                  startedAt: this.toIsoString(latestDeployment.startedAt),
                  finishedAt: this.toIsoString(latestDeployment.completedAt),
              }
            : null;

        return {
            lastRun: { generation, deployment },
            currentHealth: {
                state:
                    work.generateStatus?.status === GenerateStatusType.GENERATING
                        ? 'running'
                        : work.scheduledStatus === WorkScheduleStatus.PAUSED
                          ? 'paused'
                          : 'idle',
                deployment: this.toCurrentDeploymentHealth(work, latestDeployment),
            },
        };
    }

    /** Derive availability without treating historical failure as current downtime. */
    private toCurrentDeploymentHealth(
        work: Work,
        latestDeployment?: WorkDeployment,
    ): WorkCurrentHealthDto['deployment'] {
        const deploymentState = work.deploymentState?.toUpperCase();

        if (deploymentState === 'READY') {
            return {
                readiness: 'ready',
                source: 'deployment_projection',
                observedAt:
                    latestDeployment?.state === 'READY'
                        ? this.toIsoString(latestDeployment.completedAt)
                        : null,
            };
        }

        if (['PENDING', 'INITIALIZING', 'QUEUED', 'BUILDING'].includes(deploymentState ?? '')) {
            return {
                readiness: 'pending',
                source: 'deployment_projection',
                observedAt: null,
            };
        }

        if (!work.website && !work.deployProjectId && !work.deploymentState) {
            return { readiness: 'not_deployed', source: 'none', observedAt: null };
        }

        return {
            readiness: 'unknown',
            source: work.deploymentState ? 'deployment_projection' : 'none',
            observedAt: null,
        };
    }

    /** Serialize legacy Date/string timestamps defensively for the API contract. */
    private toIsoString(value?: Date | string | null): string | null {
        if (!value) {
            return null;
        }

        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    /**
     * Should we attempt a one-shot backfill of the data-cache columns
     * on this read? Gated on `configCache` alone, not on any of the
     * count columns. Reason: `refreshDataCache` writes each column
     * independently from its own `Promise.allSettled` slot — so if a
     * single read (e.g. `countComparisons()` on a Work with no
     * comparisons folder) consistently rejects, that one count stays
     * NULL forever even after the rest are populated. Triggering on
     * `configCache == null` instead means once the YAML snapshot has
     * been written at least once, the page is unblocked regardless
     * of which sibling reads failed — and a per-read failure can be
     * retried by an explicit refresh path, not by silently
     * re-cloning the repo on every page load.
     */
    private shouldBackfillDataCache(work: Work): boolean {
        return work.configCache == null;
    }

    async workExists(slug: string, user: User) {
        return this.workRepository.existsByUserAndSlug(user.id, slug);
    }

    /**
     * Live slug-availability check for the create-Work form (mirrors the
     * GitHub "create a new repository" name check). Work slugs are unique
     * **per user**, so the lookup is scoped to `user.id`. Returns the
     * normalized slug we actually checked plus, when taken, a free
     * `<slug>-N` suggestion the UI can offer as a one-click fix.
     */
    async checkSlugAvailability(
        rawSlug: string,
        user: User,
    ): Promise<{ available: boolean; slug: string; suggestion?: string }> {
        const slug = this.normalizeSlug(rawSlug);
        if (!slug) {
            return { available: false, slug: '' };
        }

        const exists = await this.workRepository.existsByUserAndSlug(user.id, slug);
        if (!exists) {
            return { available: true, slug };
        }

        // Suggest the first free `<slug>-N`. Bounded probing keeps this to a
        // handful of cheap COUNT lookups; the deterministic suffix loop falls
        // back to a base36-timestamp suffix so we always hand back something
        // unique even in the (degenerate) case where -2..-20 are all taken.
        let suggestion: string | undefined;
        for (let i = 2; i <= 20; i += 1) {
            const candidate = `${slug}-${i}`;
            if (!(await this.workRepository.existsByUserAndSlug(user.id, candidate))) {
                suggestion = candidate;
                break;
            }
        }
        if (!suggestion) {
            suggestion = `${slug}-${Date.now().toString(36)}`;
        }

        return { available: false, slug, suggestion };
    }

    /**
     * Browser-side `slugifyForWork` (WorkAICreator) mirror — lowercase
     * letters + digits, hyphen-joined, leading/trailing hyphens stripped.
     * Kept in sync so the slug we availability-check is exactly the slug the
     * form will submit.
     */
    private normalizeSlug(value: string): string {
        return (value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    async workItems(workId: string, user: User) {
        // Any access level can view items
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        // A Repository Work has no items by definition, and `getItems`
        // would clone the wrapped code repository into the shared checkout
        // to discover that. Answer the read without the clone — a read is
        // not refused, it is simply empty.
        if (isRepositoryWork(work)) {
            return { status: 'success', items: [] };
        }

        try {
            const items = await this.dataGenerator.getItems(work, user);
            return {
                status: 'success',
                items,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get work items:', error);

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    items: [],
                };
            }

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async workConfig(workId: string, user: User) {
        // Any access level can view config
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const config = await this.dataGenerator.getConfig(work, user);
            return {
                status: 'success',
                config,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    config: null,
                };
            }

            this.logger.error('Failed to get work config:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async getWebsiteSettings(workId: string, user: User) {
        // Any access level can view settings
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);
        const defaultCompanyName = work.name || work.slug;

        try {
            const config = await this.dataGenerator.getConfig(work, user);
            return {
                status: 'success',
                company_name: config?.company_name || defaultCompanyName,
                company_website: config?.company_website || '',
                settings: config?.settings || {},
                custom_menu: config?.custom_menu || { header: [], footer: [] },
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    company_name: defaultCompanyName,
                    company_website: '',
                    settings: {},
                    custom_menu: { header: [], footer: [] },
                };
            }

            this.logger.error('Failed to get website settings:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async updateWebsiteSettings(
        workId: string,
        user: User,
        dto: {
            company_name?: string;
            company_website?: string;
            categories_enabled?: boolean;
            collections_enabled?: boolean;
            companies_enabled?: boolean;
            tags_enabled?: boolean;
            surveys_enabled?: boolean;
            export_enabled?: boolean;
            import_enabled?: boolean;
            import_max_rows?: number;
            header?: {
                submit_enabled?: boolean;
                pricing_enabled?: boolean;
                layout_enabled?: boolean;
                language_enabled?: boolean;
                theme_enabled?: boolean;
                layout_default?: string;
                pagination_default?: string;
                theme_default?: string;
            };
            homepage?: {
                hero_enabled?: boolean;
                search_enabled?: boolean;
                default_view?: string;
                default_sort?: string;
            };
            footer?: {
                subscribe_enabled?: boolean;
                version_enabled?: boolean;
                theme_selector_enabled?: boolean;
            };
            custom_menu?: {
                header?: Array<{
                    label: string;
                    path: string;
                    target?: '_self' | '_blank';
                    icon?: string;
                }>;
                footer?: Array<{
                    label: string;
                    path: string;
                    target?: '_self' | '_blank';
                    icon?: string;
                }>;
            };
        },
    ) {
        // Require edit access to update settings
        const { work } = await this.ownershipService.ensureCanEdit(workId, user.id);

        try {
            const { custom_menu, company_name, company_website, ...settings } = dto;
            await this.dataGenerator.updateWebsiteSettings(
                work,
                user,
                settings,
                custom_menu,
                company_name,
                company_website,
            );
            return {
                status: 'success',
                message: 'Website settings updated successfully',
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'updating website settings');
        }
    }

    async workCount(workId: string, user: User) {
        // Any access level can view count
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const count = await this.dataGenerator.count(work, user);
            return {
                status: 'success',
                ...count,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    items: 0,
                    categories: 0,
                    tags: 0,
                };
            }

            this.logger.error('Failed to get work count:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async workCategoriesTags(workId: string, user: User) {
        // Any access level can view categories and tags
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const { categories, tags, collections } = await this.dataGenerator.getCategoriesTags(
                work,
                user,
            );
            return {
                status: 'success',
                categories,
                tags,
                collections,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);

            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    categories: [],
                    tags: [],
                    collections: [],
                };
            }

            this.logger.error('Failed to get work categories and tags:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async workGenerationHistory(
        workId: string,
        user: User,
        options: { limit?: number; offset?: number; activityType?: string } = {},
    ): Promise<WorkGenerationHistoryListDto> {
        // Any access level can view generation history
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
        const offset = Math.max(options.offset ?? 0, 0);
        const activityTypes = this.resolveHistoryActivityTypes(options.activityType);

        const [history, total] = await Promise.all([
            this.generationHistoryRepository.findByWorkFiltered(
                work.id,
                limit,
                offset,
                activityTypes,
            ),
            this.generationHistoryRepository.countByWork(work.id, activityTypes),
        ]);

        return {
            history: history.map((record) => this.toGenerationHistoryDto(record)),
            total,
            limit,
            offset,
        };
    }

    private toGenerationHistoryDto(record: WorkGenerationHistory): WorkGenerationHistoryDto {
        return {
            id: record.id,
            status: record.status,
            generationMethod: record.generationMethod ?? null,
            startedAt: record.startedAt ? record.startedAt.toISOString() : null,
            finishedAt: record.finishedAt ? record.finishedAt.toISOString() : null,
            durationInSeconds: record.durationInSeconds ?? null,
            newItemsCount: record.newItemsCount,
            updatedItemsCount: record.updatedItemsCount,
            totalItemsCount: record.totalItemsCount,
            metrics: record.metrics ?? null,
            errorMessage: record.errorMessage ?? null,
            parameters: record.parameters ?? null,
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
            triggerRunId: record.triggerRunId,
            activityType: record.activityType,
            changelog: record.changelog ?? null,
            logs: record.logs ?? null,
            warnings: record.warnings ?? null,
            triggeredBy: record.triggeredBy ?? null,
        };
    }

    private resolveHistoryActivityTypes(
        activityType?: string,
    ): WorkHistoryActivityType[] | undefined {
        switch (activityType) {
            case 'generation':
                return [WorkHistoryActivityType.GENERATION];
            case 'items':
                return [
                    WorkHistoryActivityType.ITEM_ADDED,
                    WorkHistoryActivityType.ITEM_UPDATED,
                    WorkHistoryActivityType.ITEM_REMOVED,
                ];
            case 'comparisons':
                return [
                    WorkHistoryActivityType.COMPARISON_ADDED,
                    WorkHistoryActivityType.COMPARISON_REMOVED,
                ];
            case 'taxonomy':
                return [
                    WorkHistoryActivityType.CATEGORY_CHANGE,
                    WorkHistoryActivityType.TAG_CHANGE,
                    WorkHistoryActivityType.COLLECTION_CHANGE,
                ];
            case 'community_pr':
                return [WorkHistoryActivityType.COMMUNITY_PR_MERGED];
            default:
                return undefined;
        }
    }

    private isReadOnlyRepoUnavailable(message: string): boolean {
        return (
            message.includes('Repository not found') ||
            message.includes('Please reconnect your Git account to continue.')
        );
    }
}
