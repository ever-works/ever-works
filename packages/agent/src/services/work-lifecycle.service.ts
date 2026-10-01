import {
    BadRequestException,
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { OrganizationRepository } from '@src/database/repositories/organization.repository';
import {
    WorkCreatedEvent,
    WorkStatusChangedEvent,
    WorksConfigSyncRequestedEvent,
    type WorkCreatedPlatformActor,
} from '@src/events';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import { CreateWorkDto } from '@src/dto/create-work.dto';
import { UpdateWorkDto } from '@src/dto';
import { DeleteWorkDto, DeleteWorkResponseDto } from '@src/items-generator/dto';
import {
    type MarkdownReadmeConfig,
    normalizeCreateWorkKind,
    Work,
    type WorkKind,
    type WorkStatus,
} from '@src/entities/work.entity';
import { canonicalJson } from '@src/safety/payload-digest';
import { User } from '@src/entities/user.entity';
import { WorkOwnershipService } from './work-ownership.service';
import { rethrowAsNormalized } from './utils/error.utils';
import { GenerateStatusType } from '@src/entities/types';
import { DeployFacadeService } from '@src/facades/deploy.facade';
import {
    getDefaultWebsiteTemplateId,
    SwitchWebsiteTemplateResponseDto,
} from '@src/generators/website-generator';
import { WebsiteRepositoryCreationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { TemplateCatalogService } from '../template-catalog/template-catalog.service';
import {
    retiredDefaultInheritanceMessage,
    retiredTemplateSelectionMessage,
} from '../template-catalog/template-retirement';
import {
    describeExternalRefConflicts,
    findExternalRefConflicts,
    validateWorkExternalRefs,
    WorkExternalRefsValidationError,
} from '../works/work-external-refs';
import { WorkWebsiteRepositoryStateService } from './work-website-repository-state.service';
import {
    EverWorksDeployQuotaService,
    EverWorksDnsService,
    EverWorksGitDisabledError,
    EverWorksGitMisconfiguredError,
    EverWorksGitProvider,
    EverWorksGitRequestError,
    type EverWorksGitRepoRef,
} from '@src/ever-works-providers';
import { config } from '@src/config';
import {
    isRepositoryWorkKind,
    normalizeWorkRepoDeclaredCommandPolicy,
    type AppSourceRecord,
} from '@ever-works/contracts';
import type { OnboardingWizardStateV2 } from '@ever-works/contracts/api';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';
import { ZeroFrictionFunnelService } from './zero-friction-funnel.service';
import { GitFacadeService } from '@src/facades/git.facade';
import {
    parseRepositoryWorkSource,
    type RepositoryWorkSource,
} from '@src/works/repository-work-source';
import {
    REPOSITORY_WORK_REFUSAL,
    assertNotRepositoryWork,
    hasRepositoryRole,
    isRepositoryWork,
} from '@src/works/repository-work-guard';
import { ActivityLogService } from '@src/activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '@src/entities/activity-log.types';
import { AppWorkCreateService } from '@src/app-works/app-work-create.service';
import {
    APP_WORK_DELETION_PORT,
    type AppWorkDeletionOutcome,
    type AppWorkDeletionPort,
} from '@src/app-works/app-work-deletion.port';
import {
    APP_WORKS_TELEMETRY_EVENTS,
    AppWorksTelemetryService,
} from '@src/app-works/app-works-telemetry.service';

/**
 * APW-11 (App Launcher) — the kind whose exposure default is **on**.
 *
 * The literal is compared against the raw `work.kind` column rather than
 * through the `WorkKind` union, because `@ever-works/contracts` does not
 * carry `'app'` in `WORK_KINDS` yet (APW-01 owns that vocabulary). Reading
 * the column as a string means this file is already correct on the day the
 * kind lands, and it cannot narrow anything if the vocabulary grows
 * differently.
 */
const APP_WORK_KIND = 'app';

/** Is this Work an App Work (spec FR-19: App Works default to exposed)? */
function isAppWorkKind(kind: string | null | undefined): boolean {
    return typeof kind === 'string' && kind.trim().toLowerCase() === APP_WORK_KIND;
}

/**
 * APW-11 (plan §4.4, spec FR-61) — everything the exposure write and its
 * Activity record need, decided once.
 */
interface AppLauncherExposureChange {
    /** Did the `(value, explicit)` pair move? `null → null` did not. */
    changed: boolean;
    /** The value to persist: `true`, `false`, or `null` for "kind default". */
    value: boolean | null;
    /** Whether the NEW state is an explicit choice (spec FR-61). */
    explicit: boolean;
    /** The effective value AFTER the write — the recorded direction. */
    effective: boolean;
    /** The effective value BEFORE the write (`metadata.previousEffective`). */
    previousEffective: boolean;
}

/**
 * Map a wizard "storage" choice onto the existing `gitProvider` field.
 *
 * The Work entity still drives every repository operation off
 * `work.gitProvider` (see git facade + repository-management). The onboarding
 * wizard's storage step is a higher-level choice that needs to translate
 * back into a concrete git-provider plugin id, otherwise picking
 * `ever-works-git` would silently fall back to whatever `gitProvider` the
 * DTO carried (default `github`).
 */
function gitProviderFromStorageChoice(storage: string): string | undefined {
    switch (storage) {
        case 'ever-works-git':
            // Ever Works Git is a managed GitHub org, so the runtime git
            // provider is still GitHub.
            return 'github';
        case 'user-github':
            return 'github';
        case 'user-gitlab':
            return 'gitlab';
        case 'user-git':
            // Self-hosted Git is "planned" in the catalog. Until a concrete
            // plugin lands, fall through to the caller's default.
            return undefined;
        default:
            return undefined;
    }
}

@Injectable()
export class WorkLifecycleService {
    private readonly logger = new Logger(WorkLifecycleService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly userRepository: UserRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly markdownGenerator: MarkdownGeneratorService,
        private readonly websiteGenerator: WebsiteGeneratorService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly ownershipService: WorkOwnershipService,
        private readonly deployFacade: DeployFacadeService,
        private readonly templateCatalogService: TemplateCatalogService,
        private readonly websiteRepositoryState: WorkWebsiteRepositoryStateService,
        private readonly everWorksDeployQuota: EverWorksDeployQuotaService,
        private readonly everWorksGit: EverWorksGitProvider,
        private readonly everWorksDns: EverWorksDnsService,
        private readonly funnel: ZeroFrictionFunnelService,
        private readonly eventEmitter: EventEmitter2,
        // Appended last (EW-711 #27) so existing positional test constructions
        // keep their argument slots; NestJS DI resolves by type, not position.
        private readonly organizationRepository: OrganizationRepository,
        // Appended after it for the same reason (self-build slice D, EW-766):
        // only the Repository Work create path probes the git provider, so
        // every other positional construction can leave the slot empty.
        private readonly gitFacade: GitFacadeService,
        // Appended last, and `@Optional()`, for the same reason again (APW-11
        // T7 — App Launcher exposure): `WorkModule` imports `ActivityLogModule`,
        // so the real service is injected in production, while an existing
        // positional construction that stops before this slot keeps working —
        // it simply records no exposure Activity. The exposure write itself
        // never depends on this.
        @Optional()
        private readonly activityLog?: ActivityLogService,
        // Appended LAST, and `@Optional()`, for the positional-spec arity rule
        // this constructor documents above (APW-01 T13 — the App Work create
        // path). `WorkModule` imports `AppWorksModule`, so the real service is
        // injected in production; a positional construction that stops before
        // this slot keeps working and simply never receives an `app` create —
        // `createWork` answers `500` with a named message rather than calling
        // `undefined.create`, because only `kind: 'app'` reaches for it.
        @Optional()
        private readonly appWorkCreate?: AppWorkCreateService,
        // Appended LAST, and `@Optional()`, for the same positional-arity rule
        // (APW-01 T39 — deleting an App Work). The binding is APW-06's
        // `APP_WORK_DELETION_PORT_PROVIDER` (`app-runtime-deletion.service.ts`),
        // which provides this exact token, imported from
        // `app-works/app-work-deletion.port.ts`. No API module provides it yet
        // (APW-06 T33), so the token is unbound and `deleteWork` treats that as
        // "no App runtime exists, so nothing can be running" and keeps today's
        // behaviour (the row goes now). Only `kind: 'app'` ever reads it.
        @Optional()
        @Inject(APP_WORK_DELETION_PORT)
        private readonly appWorkDeletion?: AppWorkDeletionPort,
        // Appended LAST, and `@Optional()`, for the same positional-arity rule
        // (APW-01 T36 — FR-53's `app_work.deleted`). `WorkModule` imports
        // `AppWorksModule`, which exports the service; absent, no event is emitted
        // and the delete is unchanged. Only `kind: 'app'` ever reads it.
        @Optional()
        private readonly appWorksTelemetry?: AppWorksTelemetryService,
    ) {}

    /**
     * Resolve storage / deploy / git provider for a new Work. Precedence:
     *
     *   1. value the client passed in the DTO (explicit overrides win),
     *   2. the user's persisted onboarding choice (if any),
     *   3. the historical fallback (`user-github` / `vercel`).
     *
     * Two additional safeguards:
     *
     *   - `deployProvider === 'ever-works'` is only persisted when the env
     *     flag is on. There's no plugin registered with id `ever-works`, so
     *     the deploy facade would throw at deploy time on environments where
     *     the feature is off (which is the prod default until the tenant
     *     cluster is wired up). Fall back to `vercel` in that case.
     *   - The storage choice is translated back into a concrete `gitProvider`
     *     value, since repository operations still read `work.gitProvider`.
     *     Without this, picking `ever-works-git` in the wizard had no
     *     runtime effect.
     */
    private async resolveProviderDefaults(
        dto: Pick<CreateWorkDto, 'storageProvider' | 'deployProvider' | 'gitProvider'>,
        userId: string,
    ): Promise<{ storageProvider: string; deployProvider: string; gitProvider: string }> {
        let onboardingState: OnboardingWizardStateV2 | null | undefined;
        try {
            const user = await this.userRepository.findById(userId);
            onboardingState = user?.onboardingState;
        } catch (cause) {
            this.logger.warn(
                `Failed to read onboarding state for user ${userId}; falling back to defaults: ${(cause as Error).message}`,
            );
        }

        const storageProvider =
            dto.storageProvider ?? onboardingState?.storage?.choice ?? 'user-github';

        let deployProvider = dto.deployProvider ?? onboardingState?.deploy?.choice ?? 'vercel';
        if (deployProvider === 'ever-works' && !config.everWorks.deploy.isEnabled()) {
            this.logger.warn(
                `deployProvider 'ever-works' selected by user ${userId} but DEPLOY_EVER_WORKS_ENABLED is off — falling back to 'vercel' to avoid persisting an unresolvable provider id`,
            );
            deployProvider = 'vercel';
        }

        const gitProvider =
            dto.gitProvider ?? gitProviderFromStorageChoice(storageProvider) ?? 'github';

        return { storageProvider, deployProvider, gitProvider };
    }

    private normalizeWebsiteTemplateSelection(value?: string | null): string | null {
        const normalized = value?.trim();
        return normalized ? normalized : null;
    }

    /**
     * Validates a website template id a caller asks a Work to use. Every
     * Work-side write path that takes one goes through here: create, the
     * settings update and the template switch.
     *
     * `currentTemplateId` is the Work's current explicit selection (none on
     * create). A RETIRED row (templates-catalog FR-5 c/e — an App Blueprint an
     * earlier discovery saved as a website template) is refused as a NEW
     * selection with a 400, but re-sending the id the Work already has is not a
     * new selection: a settings save or a no-op switch on such a Work keeps
     * working, exactly as the resolver keeps resolving the row for it.
     *
     * An empty value ("use my default") returns null unchecked; what the Work
     * would then inherit is each caller's concern (FR-5 f): `createWork` pins
     * a new Work away from a retired saved default, and the update and switch
     * call `assertMayNewlyInheritWebsiteDefault`.
     */
    private async resolveValidatedWebsiteTemplateSelection(
        value: string | null | undefined,
        userId: string,
        currentTemplateId: string | null = null,
    ): Promise<string | null> {
        const normalizedTemplateId = this.normalizeWebsiteTemplateSelection(value);

        if (!normalizedTemplateId) {
            return null;
        }

        const visibleTemplate = await this.templateCatalogService.getVisibleTemplateForUser(
            'website',
            normalizedTemplateId,
            userId,
        );
        if (!visibleTemplate) {
            throw new BadRequestException({
                status: 'error',
                message: `Unsupported website template: ${normalizedTemplateId}`,
            });
        }

        if (visibleTemplate.retiredReason && normalizedTemplateId !== currentTemplateId) {
            throw new BadRequestException({
                status: 'error',
                message: retiredTemplateSelectionMessage(
                    visibleTemplate,
                    visibleTemplate.retiredReason,
                ),
            });
        }

        return normalizedTemplateId;
    }

    /**
     * Refuses moving an existing Work to "use my default" (no website template
     * of its own) while the user's saved default is a RETIRED row the Work
     * does not already use (templates-catalog FR-5 f). The switch and the
     * settings update send null for that choice, and a Work storing null
     * inherits the saved default, which the resolver still resolves — so
     * without this the Work would newly land on the App Blueprint, and the
     * switch would reset its website repository from it.
     *
     * It refuses rather than substituting another template: "use my default"
     * cannot be honoured, and a guessed replacement could reset the
     * repository from a template the user never saw named. (A NEW Work is
     * pinned instead — see `createWork` — because there is nothing to reset
     * and every Create-Work form starts on "use my default".)
     *
     * `currentEffectiveTemplateId` is the template the Work uses now. A Work
     * already on the retired row — by inheritance or by id — may move to
     * inheriting it: nothing it resolves changes.
     */
    private async assertMayNewlyInheritWebsiteDefault(
        userId: string,
        currentEffectiveTemplateId: string,
    ): Promise<void> {
        const retiredDefault = await this.templateCatalogService.getRetiredDefaultTemplateForUser(
            'website',
            userId,
        );
        if (retiredDefault?.retiredReason && retiredDefault.id !== currentEffectiveTemplateId) {
            throw new BadRequestException({
                status: 'error',
                message: retiredDefaultInheritanceMessage(
                    retiredDefault,
                    retiredDefault.retiredReason,
                ),
            });
        }
    }

    private async getEffectiveWebsiteTemplateId(
        work: Pick<Work, 'websiteTemplateId'>,
        userId: string,
    ): Promise<string> {
        return (
            this.normalizeWebsiteTemplateSelection(work.websiteTemplateId) ||
            (await this.templateCatalogService.getDefaultTemplateIdForUser('website', userId)) ||
            getDefaultWebsiteTemplateId()
        );
    }

    private isMissingWebsiteRepositoryError(error: unknown): boolean {
        if (error instanceof NotFoundException) {
            return true;
        }

        const errorStatus =
            typeof error === 'object' && error !== null && 'status' in error
                ? Number((error as { status?: unknown }).status)
                : undefined;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const normalizedMessage = errorMessage.toLowerCase();

        return (
            errorStatus === 404 ||
            errorMessage.includes('404') ||
            normalizedMessage.includes('not found') ||
            normalizedMessage.includes('does not exist')
        );
    }

    private async hasInitializedWebsiteRepository(work: Work, user: User): Promise<boolean> {
        return this.websiteRepositoryState.isInitialized(work, user);
    }

    async createWork(createWorkDto: CreateWorkDto, user: User) {
        const { slug, name, description, owner, readmeConfig, organization, websiteTemplateId } =
            createWorkDto;

        // Persist the user's work-kind choice (website / landing-page /
        // blog / directory / awesome-repo / repo) so
        // `WebsiteTemplateResolverService.resolveForWork` can apply the
        // kind-aware default website template (PR #1681). Re-normalized
        // here because `createWork` is also invoked programmatically with
        // plain objects that never passed through the DTO transform
        // (quick-create controller, onboarding adapter). Omitted → the
        // column default `'default'` applies, exactly as before.
        const normalizedKind = normalizeCreateWorkKind(createWorkDto.kind);

        // App Work (APW-01 T13, README D1) — a kind of its own, with a create
        // path of its own. The branch sits FIRST because an App Work shares
        // nothing with the generated-website path below: it provisions no
        // website template, no provider repository and no data repository, it
        // resolves its own deploy target (so `resolveProviderDefaults` — and with
        // it every onboarding default — is deliberately skipped for the kind),
        // and it writes the Work row plus its `WorkUpstreamState` row in one
        // transaction. Falling through to the generator path is exactly the bug
        // this branch removes: it silently created a generated website for an
        // `app` request and acted on none of `repositoryMode`, `targetOwner`,
        // `blueprintId` or `autoProvision`.
        if (isAppWorkKind(normalizedKind)) {
            if (!this.appWorkCreate) {
                throw new ServiceUnavailableException(
                    'App Works are not available in this deployment: the App Work create service is ' +
                        'not wired into WorkModule.',
                );
            }
            return this.appWorkCreate.create(createWorkDto, user);
        }

        // Repository Work (self-build slice D, EW-766) — resolve and verify
        // the source repository FIRST so a bad, missing, unreachable or
        // already-wrapped URL fails before any side effect. A `repo` Work
        // has no website template and no deploy, so template validation and
        // the deploy quota are skipped for it.
        const repositorySource = isRepositoryWorkKind(normalizedKind)
            ? await this.resolveRepositoryWorkSource(createWorkDto, user)
            : null;

        let selectedWebsiteTemplateId = repositorySource
            ? null
            : await this.resolveValidatedWebsiteTemplateSelection(websiteTemplateId, user.id);
        if (!repositorySource && !selectedWebsiteTemplateId) {
            // No template named: the Work would store null and inherit the
            // user's saved default. When that default is a RETIRED row (an App
            // Blueprint) the catalog names the template a user with no saved
            // default gets, and the Work is pinned to it (templates-catalog
            // FR-5 f). Every Create-Work form starts on "use my default", so
            // this is the common path, not an API corner.
            selectedWebsiteTemplateId =
                await this.templateCatalogService.getWebsiteTemplateIdForNewWork(
                    user.id,
                    normalizedKind,
                );
        }

        const { storageProvider, deployProvider, gitProvider } = await this.resolveProviderDefaults(
            createWorkDto,
            user.id,
        );

        // Ever Works Deploy is capped per user. The check is a no-op when
        // the user isn't picking it; we still want a hard fail BEFORE the
        // create-work side-effects (repo creation etc.) kick in.
        if (deployProvider === 'ever-works' && !repositorySource) {
            await this.everWorksDeployQuota.assertWithinQuota(user.id);
        }

        // The shape we hand to `workRepository.create()` is a subset of
        // `Partial<Work>` (TypeORM accepts the full entity shape on save).
        // We layer the create-time DTO fields + an optional `id` (when the
        // platform pre-generates a UUID for the EW-614 path) + the
        // `sourceRepository` JSONB that records the resolved repo
        // coordinates.
        const workData: Partial<Work> = {
            slug,
            name,
            description,
            userId: user.id,
            owner,
            gitProvider,
            storageProvider,
            deployProvider,
            websiteTemplateId: selectedWebsiteTemplateId,
            readmeConfig,
            organization,
            // EW-617 G8 — persist the funnel correlation id so the async
            // DEPLOY_READY poller can emit with the same id later. Nullable
            // when the caller is not a zero-friction quick-create.
            lastDeployCorrelationId: createWorkDto.correlationId ?? null,
        };

        if (normalizedKind) {
            workData.kind = normalizedKind;
        }

        // A Repository Work registers the user's EXISTING repository as its
        // data repository and provisions nothing — see
        // `applyRepositoryWorkSource`. The managed Ever Works Git branch
        // below is skipped for it on purpose: creating a fresh repo in the
        // platform org is the opposite of what "wrap this repo" means.
        if (repositorySource) {
            this.applyRepositoryWorkSource(workData, repositorySource);
        }

        // EW-614 — when the user picks "Ever Works Git" AND the feature flag
        // is on, the platform provisions the GitHub repo in the
        // `ever-works-cloud` org BEFORE the Work is persisted. The repo
        // identifier is then woven into the workData so:
        //   - `work.owner` becomes the platform org (drives `getRepoOwner()`)
        //   - `work.organization` is true (the owner is an org, not a user)
        //   - `sourceRepository.relatedRepositories` records the resolved repo
        //     coordinates (handles the collision-suffix path the provider
        //     transparently does on `422 name already exists`)
        //
        // The provisioned repo is registered under BOTH the `work` and `data`
        // roles because managed storage is a SINGLE-repo model: one repo in the
        // platform org holds the work and its data, which is what
        // `sourceRepository.type = 'data_repo'` below already declares.
        //
        // Registering only `work` (as this did until EW-028) left the `data`
        // role unrecorded, and `Work.getRelatedRepository` then falls back per
        // FIELD, not per role — so the owner resolved correctly from
        // `work.owner` while the repo silently fell through to the DERIVED
        // default `${slug}-data`, a repo nobody ever creates. Two consumers
        // broke on that, in different ways:
        //
        //   - `WorksConfigRepositorySyncService` cloned
        //     `<org>/<slug>-data` -> HTTP 404, so `.works/works.yml` never
        //     synced. Observed on production 2026-08-13: the real repo
        //     `ever-works-cloud/anon-1d565e12-ew027-verify-directory` had been
        //     created 4 seconds earlier and sat unused beside it.
        //   - `WorkRepository.findByDataRepoFullName` (routes inbound GitHub
        //     App push webhooks to a Work) requires the `data` role outright —
        //     `if (!data?.owner || !data?.repo) return false`. With the role
        //     absent it matched ZERO works, so webhooks were dropped with no
        //     error and no log at all.
        //
        // We pre-generate the Work UUID so `EverWorksGitProvider.buildRepoName`
        // can derive a deterministic collision suffix from it. The same UUID
        // is persisted on the DB row in a single TypeORM `save()`.
        let everWorksRepo: EverWorksGitRepoRef | undefined;
        if (
            storageProvider === 'ever-works-git' &&
            !repositorySource &&
            this.everWorksGit.isEnabled()
        ) {
            const workId = randomUUID();
            try {
                everWorksRepo = await this.everWorksGit.createRepository({
                    work: {
                        id: workId,
                        slug,
                        userId: user.id,
                        userSlug: user.username,
                        description,
                    },
                });
            } catch (error) {
                this.rethrowEverWorksGitError(error);
            }

            workData.id = workId;
            workData.owner = everWorksRepo!.owner;
            workData.organization = true;
            workData.sourceRepository = {
                url: everWorksRepo!.htmlUrl,
                owner: everWorksRepo!.owner,
                repo: everWorksRepo!.repo,
                type: 'data_repo',
                importedAt: new Date(),
                relatedRepositories: {
                    work: { owner: everWorksRepo!.owner, repo: everWorksRepo!.repo },
                    data: { owner: everWorksRepo!.owner, repo: everWorksRepo!.repo },
                },
            };
        }

        try {
            const dir = await this.workRepository.create(workData, user);
            dir.owner = dir.getRepoOwner();

            // The items probe clones the data repository looking for
            // directory content. A Repository Work's data repository is a
            // code repository with no items to find, and it is already
            // stamped `generated` — skip the clone.
            if (!repositorySource) {
                const items = await this.dataGenerator.getItems(dir, user).catch(() => []);
                if (items.length > 0) {
                    await this.workRepository.updateGenerateStatus(dir.id, {
                        status: GenerateStatusType.GENERATED,
                    });
                }
            }

            // Emit `WorkCreatedEvent` so downstream listeners (activity log,
            // work-proposal learning ingest) record the create. When the
            // platform provisioned the repo, carry that fact as a
            // `platformActor` payload so the audit row distinguishes
            // "platform created this on the user's behalf" from a regular
            // user-initiated repo create. EW-614.
            const platformActor: WorkCreatedPlatformActor | undefined = everWorksRepo
                ? {
                      actorKind: 'platform',
                      actor: everWorksRepo.owner,
                      repoFullName: everWorksRepo.fullName,
                      htmlUrl: everWorksRepo.htmlUrl,
                  }
                : undefined;
            // `emitAsync` awaits every listener's promise before the
            // controller returns. The audit-log-immutable + audit-log-
            // sequences specs query `/api/activity-log?workId=<new>`
            // immediately after createWork resolves — with the prior
            // fire-and-forget `emit`, the activity_log INSERT raced
            // with the response and the specs sometimes saw an empty
            // list (skip path). Listeners already catch their own
            // errors so awaiting can't turn a logging failure into a
            // create failure.
            await this.eventEmitter.emitAsync(
                WorkCreatedEvent.EVENT_NAME,
                new WorkCreatedEvent(dir, platformActor),
            );

            // EW-617 G8 — funnel step 5: repos pushed. Only emit when the
            // caller threaded a correlation id (i.e. this is part of the
            // zero-friction quick-create funnel). Skipped on error paths
            // because failure means no repos were actually pushed.
            if (createWorkDto.correlationId) {
                const repos: string[] = [];
                if (everWorksRepo) {
                    repos.push(everWorksRepo.fullName);
                }
                this.funnel.emit({
                    event: ZERO_FRICTION_FUNNEL_EVENTS.REPOS_PUSHED,
                    funnelStep: 5,
                    timestamp: new Date().toISOString(),
                    correlationId: createWorkDto.correlationId,
                    workId: dir.id,
                    repos,
                });
            }

            return {
                status: 'success',
                work: dir,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'creating work');
        }
    }

    /**
     * Repository Work (self-build slice D, EW-766) — turn the caller's
     * `repositoryUrl` into persisted coordinates, or fail the create.
     *
     * Four checks, in order, all BEFORE any persistence:
     *
     *   1. The URL parses. A `repo` Work without a repository is a
     *      contradiction, so a missing or unparseable URL is a 400 rather
     *      than a silently derived `<slug>-data` repository nobody ever
     *      created (the exact failure mode EW-028 fixed for managed storage).
     *   2. The URL's host agrees with the git provider the caller chose.
     *      `applyRepositoryWorkSource` overwrites `gitProvider` from the URL;
     *      overriding an explicit choice silently is how the web gate (which
     *      proves the SIDEBAR provider is connected) and the persisted row
     *      would end up disagreeing.
     *   3. The caller can read the repository through their own connected
     *      account. Every later operation — Task worktree provisioning, the
     *      KB mirror, webhook-less polling — runs with the owner's token, so
     *      a repository the owner cannot reach would fail late and
     *      repeatedly instead of once, here. Same probe the import analyser
     *      runs before it registers anything.
     *   4. No OTHER account already wraps the same repository. The on-disk
     *      checkout the git facade keeps is keyed by `owner/repo` alone, so
     *      two tenants pointing at one third-party repository would share —
     *      and clobber — a single working copy with two different tokens.
     *      Collaborators join the existing Work as members instead.
     */
    private async resolveRepositoryWorkSource(
        createWorkDto: CreateWorkDto,
        user: User,
    ): Promise<RepositoryWorkSource> {
        const source = parseRepositoryWorkSource(createWorkDto.repositoryUrl);
        if (!source) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'A Repository Work needs `repositoryUrl` — an existing https://github.com/<owner>/<repo> ' +
                    'your connected GitHub account can access (only GitHub is supported today).',
            });
        }

        if (createWorkDto.gitProvider && createWorkDto.gitProvider !== source.gitProvider) {
            throw new BadRequestException({
                status: 'error',
                message:
                    `Repository ${source.url} is hosted on ${source.gitProvider}, but the request selected ` +
                    `the "${createWorkDto.gitProvider}" git provider. Select the provider that hosts the repository.`,
            });
        }

        await this.assertRepositoryAccessible(source, user);
        await this.assertRepositoryNotWrappedByAnotherAccount(source, user);
        return source;
    }

    private async assertRepositoryAccessible(
        source: RepositoryWorkSource,
        user: User,
    ): Promise<void> {
        let accessible: boolean;
        try {
            accessible = await this.gitFacade.hasRepositoryAccess(source.owner, source.repo, {
                userId: user.id,
                providerId: source.gitProvider,
            });
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }
            // `NoGitCredentialsError` (nothing connected), `GitProviderNotFoundError`
            // (provider plugin not installed) or a provider outage. None of
            // these means the URL is wrong, but all of them mean the platform
            // cannot vouch for the repository — and registering it anyway would
            // only move the same failure to the first fleet run. Say what was
            // missing instead of persisting a Work nothing can clone.
            const reason = error instanceof Error ? error.message : String(error);
            throw new BadRequestException({
                status: 'error',
                message: `Could not verify access to ${source.url} with your connected ${source.gitProvider} account: ${reason}`,
            });
        }
        if (!accessible) {
            throw new BadRequestException({
                status: 'error',
                message:
                    `Repository ${source.url} was not found or is not accessible with your connected ` +
                    `${source.gitProvider} account. Check the URL and that the account can read the repository.`,
            });
        }
    }

    private async assertRepositoryNotWrappedByAnotherAccount(
        source: RepositoryWorkSource,
        user: User,
    ): Promise<void> {
        const existing = await this.workRepository.findRepositoryWorksWrapping(
            source.owner,
            source.repo,
        );
        // The same account registering the same repository twice shares one
        // token and one checkout, which is the situation every other kind
        // already lives with; only a DIFFERENT account is refused.
        if (existing.some((work) => work.userId !== user.id)) {
            throw new ConflictException({
                status: 'error',
                message:
                    `Repository ${source.url} is already registered as a Work by another account. ` +
                    "Ask that Work's owner to add you as a member instead of registering the repository again.",
            });
        }
    }

    /**
     * Repository Work (self-build slice D, EW-766) — register an EXISTING
     * code repository as the Work's data repository, provisioning nothing.
     *
     * The repository is written under the `data` role of
     * `sourceRepository.relatedRepositories` (plus `work.owner`), which is
     * what `Work.getDataRepo()` / `getRepoOwner()` read — and therefore what
     * `TaskWorkspaceService.provisionForRun` clones for an isolated Task
     * worktree and what `WorkRepository.findByDataRepoFullName` matches
     * inbound push webhooks against. Registering the `data` role explicitly
     * (rather than only the top-level `owner`/`repo`, as `link_existing`
     * imports do) is deliberate: `getRelatedRepository` falls back per
     * FIELD, so an unrecorded role would resolve the owner correctly and
     * the repo to the derived `<slug>-data` default.
     *
     * `type: 'link_existing'` is the closest existing `ImportSourceType`:
     * nothing was copied or generated, the Work simply points at a repo the
     * user already had. The `work` and `website` roles stay unset because
     * `WORK_KIND_CAPABILITIES.repo` provisions neither.
     */
    private applyRepositoryWorkSource(workData: Partial<Work>, source: RepositoryWorkSource): void {
        workData.owner = source.owner;
        workData.gitProvider = source.gitProvider;
        workData.storageProvider = source.storageProvider;
        // No website to deploy — and `null` keeps the row out of the
        // `deployProvider = 'ever-works'` quota count, exactly as
        // `createCompanyWork` does (Codex P2 on PR #1075).
        workData.deployProvider = null;
        workData.websiteTemplateId = null;
        workData.sourceRepository = {
            url: source.url,
            owner: source.owner,
            repo: source.repo,
            type: 'link_existing',
            importedAt: new Date(),
            relatedRepositories: {
                data: { owner: source.owner, repo: source.repo },
            },
        };
        // Nothing will ever be generated for this Work; stamp it the way a
        // linked import is stamped so the UI does not wait on a generation
        // that is never coming.
        workData.generateStatus = { status: GenerateStatusType.GENERATED, step: 'linked' };
        // EW-628's data-sync poller selects every Work with a positive
        // `syncIntervalMinutes` and no GitHub App installed, and the column
        // default is 5. A Repository Work has nothing to sync — the render
        // is a no-op for the kind — but the poller would still call the
        // wrapped repository's API with the owner's token every five
        // minutes, forever, and log a data-sync activity row each time.
        // 0 is the column's "not opted in".
        workData.syncIntervalMinutes = 0;
    }

    /**
     * EW-665 (Tenants & Organizations Phase 13) — create a lightweight
     * "Company" Work row WITHOUT the heavy repo/git side-effects that
     * `createWork` triggers.
     *
     * A Company Work is a registration record, not a directory/website,
     * so it has no data repo to provision. We persist a minimal row
     * (`kind = 'company'`, the caller-chosen initial `status`) directly
     * via the repository, bypassing the data/markdown/website generators.
     *
     * Returns the persisted Work. The caller is expected to follow up
     * with `transitionStatus(work.id, 'registered')` once registration
     * completes (or pass `status: 'registered'` directly when the
     * registration is already done, e.g. the manual-completion path).
     *
     * Emitting the `work.status.changed` event is deliberately NOT done
     * here — `createWork`-style "created" emission is a separate concern,
     * and the Org-spawning listener keys off the status TRANSITION, not
     * the create. Callers drive the transition explicitly so the flow
     * stays observable + testable.
     */
    async createCompanyWork(
        user: User,
        params: {
            name: string;
            slug: string;
            description?: string;
            companyName?: string | null;
            companyWebsite?: string | null;
            status?: WorkStatus;
        },
    ): Promise<Work> {
        const workData: Partial<Work> = {
            slug: params.slug,
            name: params.name,
            description: params.description ?? params.name,
            userId: user.id,
            kind: 'company',
            status: params.status ?? 'draft',
            companyName: params.companyName ?? params.name,
            companyWebsite: params.companyWebsite ?? null,
            // A Company Work is a registration record, NOT a deployable
            // website. `deployProvider` defaults to 'ever-works', and
            // `WorkRepository.countActiveByDeployProvider(userId,
            // 'ever-works')` counts every non-archived/deleted row with
            // that provider against the user's Ever Works Deploy quota.
            // Leaving the default would let registered companies eat the
            // deploy cap and block real website creation. Set it to null
            // so the `WHERE deployProvider = 'ever-works'` quota query
            // never matches these rows. (Codex P2 on PR #1075.)
            deployProvider: null,
        };

        try {
            return await this.workRepository.create(workData, user);
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'creating company work');
        }
    }

    /**
     * Campaign activation (roadmap 14.1) — a `campaign` Work row without
     * the repo/git side-effects `createWork` triggers.
     *
     * A campaign Work is where a go-to-market pipeline's output lives
     * (lead lists, drafts awaiting the review gate, period reports); it
     * produces no deployable site, so `WORK_KIND_CAPABILITIES.campaign`
     * turns `deploy` and the website repo off. Same posture as
     * {@link createCompanyWork}: minimal row, quota-safe
     * `deployProvider: null`, no generators.
     *
     * `campaign` is deliberately absent from `USER_SELECTABLE_WORK_KINDS`
     * — this method (driven by {@link CampaignActivationService}) is the
     * only way one gets minted, so the general create path can never
     * produce a campaign Work with none of its contents.
     */
    async createCampaignWork(
        user: User,
        params: {
            name: string;
            slug: string;
            description?: string;
            status?: WorkStatus;
        },
    ): Promise<Work> {
        const workData: Partial<Work> = {
            slug: params.slug,
            name: params.name,
            description: params.description ?? params.name,
            userId: user.id,
            kind: 'campaign',
            status: params.status ?? 'active',
            deployProvider: null,
        };

        try {
            return await this.workRepository.create(workData, user);
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'creating campaign work');
        }
    }

    /**
     * Teams & Prebuilt Companies (spec §6.2) — bare DRAFT Work row with
     * zero repo/git/generation side-effects. The company-template importer
     * maps each `PROJECT.md` in a package onto one of these; a later
     * "activation" reuses `transitionStatus(workId, 'active')`. Mirrors
     * `createCompanyWork` (same quota-safe `deployProvider: null`) but
     * keeps `kind: 'default'` — these are ordinary Works, not company
     * registration records.
     */
    async createDraftWork(
        user: User,
        params: { name: string; slug: string; description?: string },
    ): Promise<Work> {
        const workData: Partial<Work> = {
            slug: params.slug,
            name: params.name,
            description: params.description ?? params.name,
            userId: user.id,
            kind: 'default',
            status: 'draft',
            deployProvider: null,
        };
        // A draft is an ordinary Work whose website comes later, from the
        // template it inherits. Not from a retired saved default, though: see
        // `createWork` (templates-catalog FR-5 f).
        const pinnedWebsiteTemplateId =
            await this.templateCatalogService.getWebsiteTemplateIdForNewWork(
                user.id,
                workData.kind,
            );
        if (pinnedWebsiteTemplateId) {
            workData.websiteTemplateId = pinnedWebsiteTemplateId;
        }

        try {
            return await this.workRepository.create(workData, user);
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'creating draft work');
        }
    }

    /**
     * EW-665 (Tenants & Organizations Phase 13) — transition a Work's
     * lifecycle `status` and emit `work.status.changed` when (and only
     * when) the status actually changes.
     *
     * This is the single choke-point for Work-status mutations introduced
     * by Phase 13 — `status` is a brand-new column, so there was no
     * pre-existing update path to fold into. The Register-Company flow
     * drives a Company Work into `'registered'` through here, which fires
     * the event that the API-layer `WorkRegisteredListener` turns into an
     * `Organization`.
     *
     * No-op (no save, no emit) when the Work is already at `newStatus`,
     * so re-running a transition is idempotent and never double-fires the
     * downstream listener.
     */
    async transitionStatus(workId: string, newStatus: WorkStatus): Promise<Work> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException({ status: 'error', message: 'Work not found' });
        }

        const previousStatus: WorkStatus = work.status;
        if (previousStatus === newStatus) {
            // Idempotent no-op: same status in → same status out, no event.
            return work;
        }

        const updated = await this.workRepository.update(workId, { status: newStatus });
        if (!updated) {
            throw new NotFoundException({ status: 'error', message: 'Work not found' });
        }

        // Fire-and-forget the status-change notification. The Org-spawning
        // listener catches its own errors (detached handler — see
        // `WorkRegisteredListener`), so a failure there cannot turn this
        // transition into a request failure.
        const kind: WorkKind = updated.kind ?? 'default';
        this.eventEmitter.emit(
            WorkStatusChangedEvent.EVENT_NAME,
            new WorkStatusChangedEvent(workId, updated.userId, kind, previousStatus, newStatus),
        );

        return updated;
    }

    /**
     * Map EverWorks Git provider errors onto HTTP-shaped exceptions. The
     * deploy facade lives behind the same boundary so this keeps the
     * controller-level mapping consistent across both platform-default
     * providers.
     */
    private rethrowEverWorksGitError(error: unknown): never {
        if (error instanceof EverWorksGitDisabledError) {
            throw new BadRequestException({
                status: 'error',
                message: 'Ever Works Git storage is currently disabled.',
                code: error.code,
            });
        }
        if (error instanceof EverWorksGitMisconfiguredError) {
            throw new ServiceUnavailableException({
                status: 'error',
                message:
                    'Ever Works Git storage is misconfigured. Please contact support — your work was not created.',
                code: error.code,
            });
        }
        if (error instanceof EverWorksGitRequestError) {
            throw new ServiceUnavailableException({
                status: 'error',
                message: `Ever Works Git storage is temporarily unavailable: ${error.message}`,
                code: error.code,
            });
        }
        throw error;
    }

    async updateWork(id: string, updateDto: UpdateWorkDto, user: User) {
        // Require at least editor role to update work
        const { work } = await this.ownershipService.ensureCanEdit(id, user.id);

        // A Repository Work's `owner` is not a display field: it is the
        // GitHub owner of the wrapped repository, and
        // `WorkRepository.findRepositoryWorksWrapping` filters duplicate
        // registrations on that column. Letting it drift would hide the
        // existing Work from that check and let a second account register the
        // same repository, so the column is immutable for this kind.
        if (
            isRepositoryWork(work) &&
            updateDto.owner !== undefined &&
            updateDto.owner !== work.owner
        ) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'The owner of a Repository Work is the owner of the repository it wraps and cannot be changed. ' +
                    'Register a new Work for a different repository instead.',
            });
        }

        try {
            // Build update data object
            const updateData: Record<string, any> = {
                name: updateDto.name || work.name,
                description: updateDto.description || work.description,
                owner: updateDto.owner ?? work.owner,
                organization:
                    updateDto.organization !== undefined
                        ? updateDto.organization
                        : work.organization,
                readmeConfig: updateDto.readmeConfig ?? work.readmeConfig,
            };

            // Handle deployProvider update with validation
            if (updateDto.deployProvider !== undefined) {
                if (updateDto.deployProvider) {
                    // A Repository Work provisions no website repository, so
                    // there is nothing a deploy provider could ever ship and
                    // `DeployService.deploy` refuses the kind regardless.
                    // Refusing the setting keeps the row honest instead of
                    // persisting a provider that can never run.
                    assertNotRepositoryWork(work, 'choosing a deploy provider');
                    const availableProviders = this.deployFacade.getAvailableProviders();
                    const isSupported = availableProviders.some(
                        (p) => p.id === updateDto.deployProvider,
                    );
                    if (!isSupported) {
                        throw new BadRequestException({
                            status: 'error',
                            message: `Unsupported deploy provider: ${updateDto.deployProvider}`,
                        });
                    }
                }
                updateData.deployProvider = updateDto.deployProvider;
            }

            // Handle website template auto-update settings
            if (updateDto.websiteTemplateAutoUpdate !== undefined) {
                updateData.websiteTemplateAutoUpdate = updateDto.websiteTemplateAutoUpdate;
            }

            if (updateDto.websiteTemplateUseBeta !== undefined) {
                updateData.websiteTemplateUseBeta = updateDto.websiteTemplateUseBeta;
                // Clear last commit when switching branches to force re-check
                if (updateDto.websiteTemplateUseBeta !== work.websiteTemplateUseBeta) {
                    updateData.websiteTemplateLastCommit = null;
                }
            }

            if (updateDto.websiteTemplateId !== undefined) {
                const currentTemplateId = this.normalizeWebsiteTemplateSelection(
                    work.websiteTemplateId,
                );
                const nextTemplateId = await this.resolveValidatedWebsiteTemplateSelection(
                    updateDto.websiteTemplateId,
                    user.id,
                    currentTemplateId,
                );

                if (nextTemplateId !== currentTemplateId) {
                    const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(
                        work,
                        user,
                    );

                    if (websiteRepoInitialized) {
                        throw new BadRequestException({
                            status: 'error',
                            message:
                                'Website template cannot be changed after the website repository has been initialized.',
                        });
                    }
                }

                // Leaving an explicit template for "use my default" (null):
                // not onto a retired saved default (FR-5 f). A Work that
                // already inherits is not changing what it resolves.
                if (!nextTemplateId && currentTemplateId) {
                    await this.assertMayNewlyInheritWebsiteDefault(user.id, currentTemplateId);
                }

                updateData.websiteTemplateId = nextTemplateId;
            }

            // Provider ("{provider} Repository") generation opt-out.
            if (updateDto.providerRepositoryEnabled !== undefined) {
                updateData.providerRepositoryEnabled = updateDto.providerRepositoryEnabled;
            }

            // Task isolation settings (worktree-per-Task, Wave 2 M1).
            // DTO enum-validated; NULL baseBranch = repo default.
            if (updateDto.taskIsolation !== undefined) {
                updateData.taskIsolation = updateDto.taskIsolation;
            }
            if (updateDto.taskIsolationBaseBranch !== undefined) {
                updateData.taskIsolationBaseBranch = updateDto.taskIsolationBaseBranch;
            }
            if (updateDto.taskIsolationTargetRepo !== undefined) {
                updateData.taskIsolationTargetRepo = updateDto.taskIsolationTargetRepo;
            }
            if (updateDto.taskBranchCleanup !== undefined) {
                updateData.taskBranchCleanup = updateDto.taskBranchCleanup;
            }

            // Memory recall injection toggle (memory upgrades M3) —
            // boolean, on by default; false disables the pipeline
            // preamble splice for this Work.
            if (updateDto.memoryRecallEnabled !== undefined) {
                updateData.memoryRecallEnabled = updateDto.memoryRecallEnabled;
            }

            // Quality-gate settings. `checkDefaults: null` clears the
            // Work-level defaults; checksPolicy / maxGateAttempts are
            // NOT NULL columns, so only defined values flow through (the
            // DTO already constrains them to the known set / 1..5).
            if (updateDto.checkDefaults !== undefined) {
                updateData.checkDefaults = updateDto.checkDefaults;
            }
            if (updateDto.checksPolicy !== undefined) {
                updateData.checksPolicy = updateDto.checksPolicy;
            }
            if (updateDto.maxGateAttempts !== undefined) {
                updateData.maxGateAttempts = updateDto.maxGateAttempts;
            }

            // Repository-declared commands (EW-807). Normalized on the way
            // IN as well as on the way out: the column is `simple-json`, so
            // this is the last place the value is a validated DTO rather
            // than arbitrary stored JSON, and normalizing here means the
            // allow-list an owner reads back is the one the matcher will
            // actually compare against (whitespace collapsed, duplicates
            // gone, `off` carrying no live list). `null` clears the
            // override back to "this Work does not read its repository's
            // commands", which is where every Work starts.
            if (updateDto.repoDeclaredCommands !== undefined) {
                updateData.repoDeclaredCommands =
                    updateDto.repoDeclaredCommands === null
                        ? null
                        : normalizeWorkRepoDeclaredCommandPolicy(updateDto.repoDeclaredCommands);
            }

            // Merge-policy matrix (Wave 3, D4). A PARTIAL object is normal —
            // resolution is field-by-field, so a Work can set one knob and
            // inherit the rest. `null` clears the Work override entirely
            // (back to inheriting the org / tenant / platform default);
            // the column is nullable precisely so NULL can mean INHERIT.
            if (updateDto.mergePolicy !== undefined) {
                updateData.mergePolicy = updateDto.mergePolicy;
            }

            // Handle community PR processing settings
            if (updateDto.communityPrEnabled !== undefined) {
                updateData.communityPrEnabled = updateDto.communityPrEnabled;
            }
            if (updateDto.communityPrAutoClose !== undefined) {
                updateData.communityPrAutoClose = updateDto.communityPrAutoClose;
            }

            // Handle committer overrides (allow null to clear them)
            if (updateDto.committerName !== undefined) {
                updateData.committerName = updateDto.committerName || null;
            }
            if (updateDto.committerEmail !== undefined) {
                updateData.committerEmail = updateDto.committerEmail || null;
            }

            // EW-120 dual-mode Activity Feed sync mode. Writing here flips
            // the platform-side read path immediately; works.yml gets
            // round-tripped by the next WorksConfigRepositorySync trigger
            // (deploy / generation / explicit settings save).
            if (updateDto.activitySyncMode !== undefined) {
                updateData.activitySyncMode = updateDto.activitySyncMode;
            }

            // EW-639 Phase 2/e: pair the Work with an organization-scope KB
            // document set. `organizationId === null` clears the membership
            // (no inheritance); a UUID makes the Work inherit org-level KB
            // docs that aren't shadowed by a Work-scope override. The
            // org-overlay fan-out flow (row 37) reads this column to resolve
            // which Works receive `.content/kb/.org/...` materialization.
            if (updateDto.organizationId !== undefined) {
                // Security (EW-711 #27): a Work could be enrolled into an
                // ARBITRARY organizationId with no tenant check, fanning the
                // Work's KB into another tenant's org. Before persisting a
                // non-null target, resolve the Organization and require its
                // tenant to match the Work's tenant. Reject with
                // NotFoundException (not Forbidden) so a cross-tenant probe
                // can't distinguish "org exists in another tenant" from "org
                // does not exist" (existence-leak-safe). `organizationId ===
                // null` is the clear-membership path and stays unguarded.
                if (updateDto.organizationId !== null) {
                    const targetOrg = await this.organizationRepository.findById(
                        updateDto.organizationId,
                    );
                    if (!targetOrg || targetOrg.tenantId !== work.tenantId) {
                        throw new NotFoundException({
                            status: 'error',
                            message: 'Organization not found',
                        });
                    }
                }
                updateData.organizationId = updateDto.organizationId;
            }

            // Ingest routing claims (`works.externalRefs`). Two gates before
            // the write: shape validation against the closed kind set + the
            // per-kind cap, then an owner-scoped duplicate scan — two Works
            // owned by the same user claiming one channel is ambiguous, and
            // the resolver would silently pick whichever it saw first.
            if (updateDto.externalRefs !== undefined) {
                updateData.externalRefs = await this.resolveExternalRefsUpdate(
                    id,
                    user.id,
                    updateDto.externalRefs,
                );
            }

            // App Launcher exposure (APW-11 T7, plan §4.4, spec FR-19/FR-60/
            // FR-61). One Work-level field, and it is the ONLY field this
            // request writes: the value joins `updateData` only when the
            // `(value, explicit)` pair actually moved, so a save that leaves
            // the effective value and the explicit flag alone writes nothing
            // from this block and records nothing. Edit rights are already
            // enforced above by `ensureCanEdit` — a viewer never reaches this
            // line, and no second permission path is introduced (spec FR-20).
            const exposureChange =
                updateDto.appLauncherExposed !== undefined
                    ? this.resolveAppLauncherExposureChange(work, updateDto.appLauncherExposed)
                    : null;

            if (exposureChange?.changed) {
                updateData.appLauncherExposed = exposureChange.value;
            }

            const updatedWork = await this.workRepository.update(id, updateData);

            if (!updatedWork) {
                throw new NotFoundException({ status: 'error', message: 'Work not found' });
            }

            updatedWork.owner = updatedWork.getRepoOwner();

            // The record is written once per REAL change and only after the
            // column is persisted, so the row can never describe a write that
            // did not happen. A logging failure is reported and swallowed —
            // the setting is already saved, and turning that into a request
            // failure would tell the member their choice was lost when it was
            // not (the same posture `WorksController.updateWork` takes for its
            // own `work.updated` row).
            if (exposureChange?.changed) {
                await this.logAppLauncherExposure(id, user.id, exposureChange);
            }

            // EW-612: when `deployProvider` changes via the dashboard,
            // commit the new value to `.works/works.yml` in the data repo
            // so the next deploy doesn't hit the data-repo-wins precedence
            // and silently flip the provider back. We do this by emitting
            // the existing `WorksConfigSyncRequestedEvent`; the existing
            // `WorksConfigSyncListener` + `WorksConfigRepositorySyncService`
            // handle the YAML read-modify-write and the git commit/push.
            //
            // Only emit when the value actually changed — saving the same
            // provider should be a no-op for the data repo.
            if (
                updateDto.deployProvider !== undefined &&
                updateDto.deployProvider !== work.deployProvider
            ) {
                this.eventEmitter.emit(
                    WorksConfigSyncRequestedEvent.EVENT_NAME,
                    new WorksConfigSyncRequestedEvent(id, user.id, 'provider_changed'),
                );
            }

            return {
                status: 'success',
                work: updatedWork,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'updating work');
        }
    }

    /**
     * APW-11 (plan §4.4, spec FR-19/FR-61) — decide what a submitted
     * `appLauncherExposed` means for this Work.
     *
     * "Changed" is the PAIR `(storedValue, storedExplicit)` compared with
     * `(newValue, newExplicit)`, never `storedValue !== newValue`. The two
     * differ in exactly the cases the spec calls out:
     *
     *   - `null → true` on an `app` Work: the effective value was already on,
     *     and what moved is the **explicit flag** — a real change, recorded;
     *   - `null → false` on any other kind: the mirror image, also recorded;
     *   - `null → null`: the pair is identical, so it is a no-op — nothing is
     *     written and nothing is logged;
     *   - `true → true`: likewise a no-op.
     *
     * The kind default is `true` for an `app` Work and `false` for every
     * other kind (spec FR-19), and an explicit value always wins — which is
     * why the effective value is derived from the stored/submitted value
     * first and only falls back to the kind.
     */
    private resolveAppLauncherExposureChange(
        work: Pick<Work, 'kind' | 'appLauncherExposed'>,
        nextValue: boolean | null,
    ): AppLauncherExposureChange {
        const value: boolean | null = nextValue ?? null;
        const storedValue: boolean | null = work.appLauncherExposed ?? null;
        const explicit = value !== null;
        const storedExplicit = storedValue !== null;
        const kindDefault = isAppWorkKind(work.kind);

        return {
            changed: value !== storedValue || explicit !== storedExplicit,
            value,
            explicit,
            effective: value ?? kindDefault,
            previousEffective: storedValue ?? kindDefault,
        };
    }

    /**
     * APW-11 (plan §4.4, spec FR-21/FR-61) — record one exposure change.
     *
     * The row carries the actor (`userId`, the member who made the choice),
     * the direction through the dotted `action`, whether the new state is
     * explicit or the kind default, and the effective value it moved to.
     * `metadata` carries **exactly** `{ explicit, previousEffective }`.
     *
     * The summary is a fixed English sentence that names **neither the Work
     * nor its address** — Activity rows are readable by every member of a
     * Work, and the launcher's host must never leak into one (spec §5.2,
     * FR-43). The summary is not localized, like every other Activity row.
     */
    private async logAppLauncherExposure(
        workId: string,
        userId: string,
        change: AppLauncherExposureChange,
    ): Promise<void> {
        if (!this.activityLog) {
            return;
        }

        try {
            await this.activityLog.log({
                userId,
                workId,
                actionType: ActivityActionType.APP_LAUNCHER,
                action: change.effective ? 'app.launcher.exposed' : 'app.launcher.hidden',
                status: ActivityStatus.COMPLETED,
                summary: change.explicit
                    ? change.effective
                        ? 'Show in App Launcher turned on'
                        : 'Show in App Launcher turned off'
                    : 'Show in App Launcher reset to the default for this Work kind',
                metadata: {
                    explicit: change.explicit,
                    previousEffective: change.previousEffective,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Failed to record app_launcher activity for work ${workId}: ${message}`,
            );
        }
    }

    /**
     * Validate a claim map and prove no sibling Work of the same owner
     * already claims any of its identifiers.
     *
     * Returns the normalized map, or `null` when the caller cleared every
     * claim (`null` is the column's canonical "claims nothing" value).
     *
     * @throws BadRequestException on a malformed map (unknown kind,
     *   non-string / empty / oversized id, over the per-kind cap).
     * @throws ConflictException when another Work owned by the same user
     *   already claims one of the identifiers — the message names both
     *   the identifier and the Work holding it.
     */
    private async resolveExternalRefsUpdate(workId: string, userId: string, value: unknown) {
        let normalized: ReturnType<typeof validateWorkExternalRefs>;
        try {
            normalized = validateWorkExternalRefs(value);
        } catch (error) {
            if (error instanceof WorkExternalRefsValidationError) {
                throw new BadRequestException({ status: 'error', message: error.message });
            }
            throw error;
        }

        if (normalized) {
            const siblings = await this.workRepository.findByUser(userId);
            const conflicts = findExternalRefConflicts(normalized, siblings, workId);
            if (conflicts.length > 0) {
                throw new ConflictException({
                    status: 'error',
                    message: describeExternalRefConflicts(conflicts),
                    conflicts,
                });
            }
        }

        return normalized;
    }

    async switchWebsiteTemplate(
        id: string,
        websiteTemplateId: string | null | undefined,
        user: User,
    ): Promise<SwitchWebsiteTemplateResponseDto> {
        const { work } = await this.ownershipService.ensureCanEdit(id, user.id);
        const nextTemplateId = await this.resolveValidatedWebsiteTemplateSelection(
            websiteTemplateId,
            user.id,
            this.normalizeWebsiteTemplateSelection(work.websiteTemplateId),
        );

        const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(work, user);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const currentExplicitTemplateId = this.normalizeWebsiteTemplateSelection(
            work.websiteTemplateId,
        );
        const currentEffectiveTemplateId = await this.getEffectiveWebsiteTemplateId(work, user.id);
        if (!nextTemplateId) {
            // "Use my default": not onto a retired saved default the Work does
            // not already use (FR-5 f) — refused before anything is reset or
            // saved.
            await this.assertMayNewlyInheritWebsiteDefault(user.id, currentEffectiveTemplateId);
        }
        const nextEffectiveTemplateId =
            nextTemplateId ||
            (await this.templateCatalogService.getDefaultTemplateIdForUser('website', user.id)) ||
            getDefaultWebsiteTemplateId();

        if (
            nextTemplateId === currentExplicitTemplateId &&
            nextEffectiveTemplateId === currentEffectiveTemplateId
        ) {
            return {
                status: 'success',
                slug: work.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                previousWebsiteTemplateId: currentEffectiveTemplateId,
                websiteTemplateId: currentEffectiveTemplateId,
                repositoryRecreated: false,
                switchMode: 'no_change',
                message: websiteRepoInitialized
                    ? 'Website template is already selected for this work.'
                    : 'Website template preference is already saved for this work.',
            };
        }

        const updateData = {
            websiteTemplateId: nextTemplateId,
            websiteTemplateLastCommit: null,
            websiteTemplateLastError: null,
            websiteTemplateLastUpdatedAt: null,
            websiteTemplateLastCheckedAt: null,
        };

        const previousTemplateId = currentExplicitTemplateId;
        const previousTemplateLastCommit = work.websiteTemplateLastCommit;
        const previousTemplateLastError = work.websiteTemplateLastError;
        const previousTemplateLastUpdatedAt = work.websiteTemplateLastUpdatedAt;
        const previousTemplateLastCheckedAt = work.websiteTemplateLastCheckedAt;

        work.websiteTemplateId = nextTemplateId;

        if (nextEffectiveTemplateId === currentEffectiveTemplateId) {
            await this.workRepository.update(id, {
                websiteTemplateId: nextTemplateId,
            });

            return {
                status: 'success',
                slug: work.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                previousWebsiteTemplateId: currentEffectiveTemplateId,
                websiteTemplateId: nextEffectiveTemplateId,
                repositoryRecreated: false,
                switchMode: 'no_change',
                message: nextTemplateId
                    ? 'Website template is now pinned explicitly for this work.'
                    : 'Work now inherits your default website template.',
            };
        }

        work.websiteTemplateLastCommit = null;
        work.websiteTemplateLastError = null;
        work.websiteTemplateLastUpdatedAt = null;
        work.websiteTemplateLastCheckedAt = null;

        if (websiteRepoInitialized) {
            let repositoryRecreated = false;

            try {
                await this.websiteUpdateService.updateRepository(work, user);
            } catch (error) {
                if (!this.isMissingWebsiteRepositoryError(error)) {
                    work.websiteTemplateId = previousTemplateId;
                    work.websiteTemplateLastCommit = previousTemplateLastCommit;
                    work.websiteTemplateLastError = previousTemplateLastError;
                    work.websiteTemplateLastUpdatedAt = previousTemplateLastUpdatedAt;
                    work.websiteTemplateLastCheckedAt = previousTemplateLastCheckedAt;
                    throw error;
                }

                this.logger.warn(
                    `Website repository for work ${work.id} was missing during template switch. Recreating from template.`,
                );

                try {
                    await this.websiteGenerator.initialize(
                        work,
                        user,
                        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                    );
                    repositoryRecreated = true;
                } catch (initializeError) {
                    work.websiteTemplateId = previousTemplateId;
                    work.websiteTemplateLastCommit = previousTemplateLastCommit;
                    work.websiteTemplateLastError = previousTemplateLastError;
                    work.websiteTemplateLastUpdatedAt = previousTemplateLastUpdatedAt;
                    work.websiteTemplateLastCheckedAt = previousTemplateLastCheckedAt;
                    throw initializeError;
                }
            }

            await this.workRepository.update(id, updateData);

            return {
                status: 'success',
                slug: work.slug,
                owner: websiteOwner,
                repository: `${websiteOwner}/${websiteRepo}`,
                previousWebsiteTemplateId: currentEffectiveTemplateId,
                websiteTemplateId: nextEffectiveTemplateId,
                repositoryRecreated,
                switchMode: repositoryRecreated ? 'repository_recreated' : 'repository_reset',
                message: repositoryRecreated
                    ? 'Website template switched successfully. The website repository was recreated from the selected template.'
                    : 'Website template switched successfully. The existing website repository was reset from the selected template.',
            };
        }

        await this.workRepository.update(id, updateData);

        return {
            status: 'success',
            slug: work.slug,
            owner: websiteOwner,
            repository: `${websiteOwner}/${websiteRepo}`,
            previousWebsiteTemplateId: currentEffectiveTemplateId,
            websiteTemplateId: nextEffectiveTemplateId,
            repositoryRecreated: false,
            switchMode: 'saved_for_initialization',
            message:
                'Website template updated successfully. It will be used when the website repository is first created.',
        };
    }

    async syncFromDataRepository(workId: string, user: User) {
        // Require at least editor role to sync
        const { work } = await this.ownershipService.ensureCanEdit(workId, user.id);
        // The snapshot clones the data repository looking for directory
        // items and a README template. For a Repository Work that is a full
        // clone of somebody's code repository into the shared checkout, for
        // content that cannot be there.
        assertNotRepositoryWork(work, 'syncing from the data repository');
        // A kind that provisions no data repository (`repos.data: false` in
        // the capability registry — today the App Work) has nothing to sync
        // FROM. Without this the snapshot below cloned the derived
        // `<slug>-data` name, failed, and logged "Error syncing work from data
        // repository" on every Work page mount. Answer the same shape as the
        // "already up to date" case below (`updated: []`, on which the
        // controller invalidates nothing and records no activity) so the
        // controller and the web action need no new branch.
        if (!hasRepositoryRole(work, 'data')) {
            return {
                status: 'success',
                updated: [] as string[],
                message: `Nothing to sync: a "${work.kind}" Work has no data repository.`,
            };
        }
        const updates: Record<string, any> = {};

        try {
            const snapshot = await this.dataGenerator.getDataSyncSnapshot(work, user);

            if (
                typeof snapshot.itemsCount === 'number' &&
                work.itemsCount !== snapshot.itemsCount
            ) {
                updates.itemsCount = snapshot.itemsCount;
            }

            const prUpdate = snapshot.prUpdate;
            if (prUpdate && (!work.lastPullRequest || !work.lastPullRequest.data)) {
                updates.lastPullRequest = {
                    ...(work.lastPullRequest || {}),
                    data: prUpdate,
                };
            }

            // Adopt the data repository's markdown template header/footer for
            // a Work that has none of its own. The candidate is a COPY: it used
            // to alias `work.readmeConfig` and was put into `updates`
            // unconditionally, so every call — i.e. every page mount of a
            // website/directory Work — rewrote the row (bumping `updatedAt`)
            // and reported a change, and "Work already up to date." below was
            // unreachable. Only a config that really differs is written.
            const readmeConfig: MarkdownReadmeConfig = { ...(work.readmeConfig ?? {}) };
            const markdownTemplate = snapshot.readmeTemplate;
            if (markdownTemplate?.header && !readmeConfig.header) {
                readmeConfig.header = markdownTemplate.header;
                readmeConfig.overwriteDefaultHeader = true;
            }

            if (markdownTemplate?.footer && !readmeConfig.footer) {
                readmeConfig.footer = markdownTemplate.footer;
                readmeConfig.overwriteDefaultFooter = true;
            }

            if (!isSameReadmeConfig(work.readmeConfig, readmeConfig)) {
                updates.readmeConfig = readmeConfig;
            }

            if (Object.keys(updates).length > 0) {
                await this.workRepository.update(work.id, updates);
            }

            return {
                status: 'success',
                updated: Object.keys(updates),
                message:
                    Object.keys(updates).length > 0
                        ? 'Work synced from data repository.'
                        : 'Work already up to date.',
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'syncing work from data repository');
        }
    }

    async deleteWork(
        workId: string,
        deleteWorkDto: DeleteWorkDto,
        user: User,
    ): Promise<DeleteWorkResponseDto> {
        // Only owners can delete works
        const { work } = await this.ownershipService.ensureIsOwner(workId, user.id);

        // Repository Work (self-build slice D, EW-766) — the data repository
        // IS the user's code repository, and the `work` / `website` roles were
        // never provisioned. Worse, the derived fallbacks are live names:
        // `getMainRepo()` falls back to `<slug>` under the third-party owner
        // — for a slug derived from the wrapped repo that is the wrapped repo
        // AGAIN — and `getWebsiteRepo()` to `<slug>-website`, whatever real
        // repository happens to carry that name in that org. Deleting the
        // Work row must therefore never reach the git provider for this
        // kind. An EXPLICIT request to delete the data repository is refused
        // rather than ignored: the caller asked for the one thing the
        // platform must never do to a repository it did not create.
        const wrapsExistingRepository = isRepositoryWork(work);
        if (wrapsExistingRepository && deleteWorkDto.delete_data_repository === true) {
            throw new BadRequestException({
                status: 'error',
                message:
                    `Work "${work.name}" ${REPOSITORY_WORK_REFUSAL} — its data repository is the code repository ` +
                    `${work.getRepoOwner()}/${work.getDataRepo()} you registered, which the platform never deletes. ` +
                    'Delete the Work without `delete_data_repository`.',
            });
        }

        // What the caller must be told about a repository that STAYS: a role this
        // kind never provisions, a repository this Work did not create, or a
        // removal that failed (FR-40: "the response MUST say which repository
        // remains and why"). Empty for every kind that deletes everything it was
        // asked for, so their message is byte-identical to before.
        const keptNotes: string[] = [];

        // APW-01 T39 (FR-37 … FR-40b, Resolution R-15) — the App Work delete
        // surface, ALL of it before the first repository step: a linked-repository
        // request is refused, the typed-slug confirmation is enforced server-side,
        // and the App runtime is asked to remove the workloads.
        let appDeletionPending = false;
        if (isAppWorkKind(work.kind)) {
            this.refuseAppWorkRepositoryDeletion(work, deleteWorkDto);

            const deleteStoredData = deleteWorkDto.delete_stored_data === true;
            if (deleteStoredData && deleteWorkDto.confirm_slug !== work.slug) {
                throw new UnprocessableEntityException({
                    status: 'error',
                    code: 'confirmation_mismatch',
                    message:
                        `Deleting the stored data of Work "${work.name}" needs its slug typed exactly ` +
                        `("${work.slug}"), and nothing was removed.`,
                });
            }

            appDeletionPending = await this.requestAppWorkRemoval(
                work,
                user,
                deleteStoredData,
                keptNotes,
            );
        }

        try {
            const deletedRepositories: string[] = [];

            // Role gates (self-build slice D, EW-766 for `repo`; APW-01 T39 for
            // `app`): a kind that provisions no data repository must never have a
            // DERIVED `<slug>-data` name deleted on its behalf. For an App Work
            // that name is nobody's: `buildWorkData` records only the `website`
            // role, so `getDataRepo()` is a fabrication that resolves to whatever
            // real repository happens to carry it under the Work's owner.
            if (
                hasRepositoryRole(work, 'data') &&
                !wrapsExistingRepository &&
                deleteWorkDto.delete_data_repository !== false
            ) {
                try {
                    await this.dataGenerator.removeRepository(work, user);
                    deletedRepositories.push(`${work.getRepoOwner()}/${work.getDataRepo()}`);
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete data repository:', error);
                }
            } else if (isAppWorkKind(work.kind) && deleteWorkDto.delete_data_repository === true) {
                keptNotes.push(
                    `${work.getRepoOwner()}/${work.getDataRepo()} (an App Work provisions no data ` +
                        'repository, so this name was never created and was not touched)',
                );
            }

            // Roles this kind never provisions are skipped, not attempted:
            // there is nothing of ours to delete, and the derived fallback
            // name may well belong to somebody else (see above). Applies to
            // Company / Campaign Works' missing website repo as much as to a
            // Repository Work's missing work + website repos.
            if (
                hasRepositoryRole(work, 'work') &&
                deleteWorkDto.delete_markdown_repository !== false
            ) {
                try {
                    await this.markdownGenerator.removeRepository(work, user);
                    deletedRepositories.push(`${work.getRepoOwner('work')}/${work.getMainRepo()}`);
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete markdown repository:', error);
                }
            }

            // The `website` role. For every kind but `app` it is the generated
            // website repository and the rule is unchanged (`!== false`, so an
            // omitted flag keeps the MCP / CLI default it always had).
            //
            // For an App Work the role IS the Work Repository: `buildWorkData`
            // writes `relatedRepositories.website` and nothing else
            // (`app-work-create.service.ts:1181-1183`), so this single branch
            // resolves to the fork, the private copy, or the repository the
            // member LINKED. `websiteRoleRemoval` decides whether it is the
            // platform's to remove, and every refusal it makes is reported in
            // the response.
            const websiteRoleRemoval = this.websiteRoleRemoval(work, deleteWorkDto);
            // For an App Work the `website` role IS the Work Repository (see above), so
            // this is FR-53's `repositoryDeleted` for `app_work.deleted`.
            let workRepositoryDeleted = false;
            if (hasRepositoryRole(work, 'website') && websiteRoleRemoval.remove) {
                try {
                    await this.websiteGenerator.removeRepository(work, user);
                    deletedRepositories.push(
                        `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
                    );
                    workRepositoryDeleted = true;
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete website repository:', error);
                    // FR-40: the Work is still deleted, but the caller is told
                    // which repository remains and why.
                    keptNotes.push(
                        `${work.getRepoOwner('website')}/${work.getWebsiteRepo()} ` +
                            `(its removal failed: ${describeFailureCode(error)})`,
                    );
                }
            } else if (hasRepositoryRole(work, 'website') && websiteRoleRemoval.keepBecause) {
                keptNotes.push(
                    `${work.getRepoOwner('website')}/${work.getWebsiteRepo()} ` +
                        `(${websiteRoleRemoval.keepBecause})`,
                );
            }

            // APW-01 T39 / FR-40a: the App runtime owns the removal from here. The
            // Work row stays (it reads **Deleting…**) and the local checkouts stay
            // with it until APW-06 calls `completeAppWorkDeletion(workId)` — the
            // same two steps the `done` branch below performs. The CNAME teardown is
            // skipped for the same reason: the Work has not gone anywhere yet.
            if (appDeletionPending) {
                this.trackAppWorkDeleted(work, workRepositoryDeleted, user);
                return {
                    status: 'pending',
                    slug: work.slug,
                    deleting: true,
                    message: withDeleteNotes(
                        `Work '${work.slug}' is being deleted and keeps its row until the App runtime ` +
                            'has removed its workloads',
                        keptNotes,
                    ),
                    deleted_repositories: deletedRepositories,
                };
            }

            await this.workRepository.delete(work.id);
            this.trackAppWorkDeleted(work, workRepositoryDeleted, user);

            // Local checkouts are keyed by `owner/repo`, not by Work. Nothing
            // was ever cloned for a Repository Work by the generators, so the
            // only checkout that could sit under the wrapped repository's key
            // belongs to another Work — possibly another account's — and is
            // not ours to remove.
            if (!wrapsExistingRepository) {
                await Promise.all([
                    this.dataGenerator.cleanup(work),
                    this.markdownGenerator.cleanup(work),
                    this.websiteGenerator.cleanup(work),
                ]).catch((error) => this.logger.error('Failed to cleanup repositories:', error));
            }

            // EW-617 G5: tear down the platform-managed CNAME so the slug is
            // immediately reusable. Only applies when the work deployed to
            // `ever-works` — for other providers ensureWorkSubdomain was never
            // called so the DNS record won't exist. No-ops when Cloudflare env
            // is not configured (dev).
            if (work.deployProvider === 'ever-works') {
                await this.everWorksDns.removeWorkSubdomain(work.slug);
            }

            return {
                status: 'success',
                slug: work.slug,
                message: withDeleteNotes(
                    `Work '${work.slug}' and associated repositories have been deleted`,
                    keptNotes,
                ),
                deleted_repositories: deletedRepositories,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'deleting work', {
                slug: work?.slug || '',
            });
        }
    }

    /**
     * APW-01 T36 (FR-53, plan §9.1) — `app_work.deleted`, once per accepted App Work
     * delete REQUEST: when the row goes, or when the App runtime holds it pending (the
     * member's request is complete either way). `completeAppWorkDeletion` emits
     * nothing, so the runtime finishing a pending removal does not count it again. A
     * member who repeats the delete while the row is still held pending DOES count
     * again: that request reaches `requestAppWorkRemoval` like the first (the port
     * answers `pending` once more, typically `already_deleting`), exactly as the
     * controller writes a second `work.deleted` Activity row for it. The relation and
     * whether the Work Repository was removed — never its name. A no-op for every
     * other kind.
     */
    private trackAppWorkDeleted(work: Work, repositoryDeleted: boolean, user: User): void {
        if (!isAppWorkKind(work.kind)) {
            return;
        }
        this.appWorksTelemetry?.track(
            APP_WORKS_TELEMETRY_EVENTS.deleted,
            { mode: appWorkRepositoryRelation(work), repositoryDeleted },
            user?.id,
        );
    }

    /**
     * APW-01 T39 (FR-40a, Resolution R-15) — the second half of an App Work's
     * deletion, called by APW-06's `AppRuntimeDeletionService` once the workloads are
     * gone (or given up on after 3 attempts).
     *
     * It deletes exactly what the `done` branch of {@link deleteWork} deletes — the row
     * and the local checkouts, which are keyed by `owner/repo` — and **never touches a
     * repository**: the fork / copy decision was carried out during the request, when
     * the member's answer was still in hand. Idempotent: a Work that is already gone is
     * a no-op, so a retried or replayed completion cannot fail a caller that is only
     * trying to finish a deletion.
     */
    async completeAppWorkDeletion(workId: string): Promise<boolean> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            return false;
        }

        // A row deleted between the read and the write is the same no-op.
        await this.workRepository.delete(workId).catch((error) => {
            this.logger.warn(
                `Work ${workId} could not be removed after its App deletion completed: ` +
                    `${describeFailureCode(error)}`,
            );
        });

        await Promise.all([
            this.dataGenerator.cleanup(work),
            this.markdownGenerator.cleanup(work),
            this.websiteGenerator.cleanup(work),
        ]).catch((error) => this.logger.error('Failed to cleanup repositories:', error));

        return true;
    }

    /**
     * APW-01 T39 (FR-37) — an App Work's repository is never deleted unless this Work
     * created it, and asking for one anyway is REFUSED rather than ignored.
     *
     * Two cases reach the refusal, and both name what is protected:
     *
     *   - a **link**: the Work Repository is the repository the member registered with
     *     the platform. FR-37 — "an explicit request to delete a linked repository MUST
     *     be refused" — because the platform never created it;
     *   - an **adopted fork** (`createdByThisWork: false`, R-4): it exists because the
     *     member already had it, not because this Work asked for it.
     *
     * `delete_data_repository` and `delete_website_repository` are both checked because
     * for this kind the two legacy field names resolve to app-code repositories: the
     * Work Repository under the `website` role, and — for a link — the derived
     * `<slug>-data` name under `data` (`app-work-create.service.ts:1151-1156`).
     */
    private refuseAppWorkRepositoryDeletion(work: Work, dto: DeleteWorkDto): void {
        const askedForARepository =
            dto.delete_data_repository === true || dto.delete_website_repository === true;
        if (!askedForARepository || appWorkCreatedItsRepository(work)) {
            return;
        }

        const fullName = `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`;
        const relation = appWorkRepositoryRelation(work);
        throw new BadRequestException({
            status: 'error',
            code:
                relation === 'link'
                    ? 'linked_repository_not_deletable'
                    : 'app_repository_not_created_by_this_work',
            message:
                relation === 'link'
                    ? `Work "${work.name}" is linked to ${fullName}, which the platform never created and ` +
                      'never deletes. Delete the Work without asking for that repository.'
                    : `Work "${work.name}" uses the existing fork ${fullName}, which this Work did not ` +
                      'create, so the platform never deletes it. Delete the Work without asking for that ' +
                      'repository.',
        });
    }

    /**
     * APW-01 T39 — ask the App runtime to remove the Work's workloads (FR-40a).
     *
     * Returns `true` when the removal is `pending`, i.e. the caller must keep the row
     * and answer `200 { deleting: true }`. An **unbound** port means APW-06 has not
     * merged, so no App runtime exists and nothing can be running: the outcome is taken
     * as `done`, which is what keeps today's behaviour byte-identical until it lands. A
     * **throw** is caught, logged by reason code, reported in the response message and
     * also taken as `done` — the Work is still deleted, and the member is told what may
     * remain and where (FR-40a; plan §7 `:978-980`).
     */
    private async requestAppWorkRemoval(
        work: Work,
        user: User,
        deleteStoredData: boolean,
        keptNotes: string[],
    ): Promise<boolean> {
        if (!this.appWorkDeletion) {
            return false;
        }

        let outcome: AppWorkDeletionOutcome;
        try {
            outcome = await this.appWorkDeletion.requestDeletion({
                workId: work.id,
                userId: user.id,
                deleteStoredData,
            });
        } catch (error) {
            const target = appDeployTargetOf(work);
            const code = describeFailureCode(error);
            this.logger.error(`App Work ${work.id} could not be removed from ${target}: ${code}`);
            keptNotes.push(
                `the App runtime could not remove the workloads from ${target} (${code}), so they may ` +
                    'still be running there',
            );
            return false;
        }

        if (outcome.status !== 'pending') {
            return false;
        }

        // The runtime owns the rest; a reason code, never a value.
        if (outcome.reason) {
            this.logger.log(
                `App Work ${work.id} deletion pending on ${outcome.target}: ${outcome.reason}`,
            );
        }
        return true;
    }

    /**
     * APW-01 T39 (FR-38, FR-39, FR-40) — may the `website` role be removed?
     *
     * For every kind but `app` this is the unchanged rule: remove unless the caller
     * said `false`.
     *
     * For an App Work the role is the Work Repository, and the platform's to remove
     * only when **this Work created it** (`sourceRepository.createdByThisWork`, written
     * at create time — `true` only for a fork or private copy this Work requested, and
     * `false` for an adopted fork, a link and a pasted fork) **and the caller asked
     * explicitly**. `=== true` rather than `!== false` is the whole point: a caller
     * whose DTO object simply lacks the field — a positional construction, or
     * `apps/internal-cli`, whose prompt defaults all three flags to `true` — must mean
     * KEEP, per FR-39 ("omitting the flag MUST mean 'keep the repository' for every
     * caller, including chat and MCP"). A repository that IS the upstream is refused
     * for the same reason FR-37 refuses a link: the platform never created it.
     */
    private websiteRoleRemoval(
        work: Work,
        dto: DeleteWorkDto,
    ): { remove: boolean; keepBecause?: string } {
        if (!isAppWorkKind(work.kind)) {
            return { remove: dto.delete_website_repository !== false };
        }

        const askedForTheRepository =
            dto.delete_data_repository === true || dto.delete_website_repository === true;
        if (!askedForTheRepository) {
            return { remove: false, keepBecause: 'kept: no explicit request named it' };
        }
        if (!appWorkCreatedItsRepository(work)) {
            const relation = appWorkRepositoryRelation(work);
            return {
                remove: false,
                keepBecause:
                    relation === 'link'
                        ? 'kept: the platform never created the linked repository'
                        : 'kept: this Work did not create that fork',
            };
        }
        if (appWorkRepositoryIsUpstream(work)) {
            return { remove: false, keepBecause: 'kept: it is the upstream repository' };
        }

        return { remove: true };
    }
}

/**
 * Whether two README configs are the same once stored. The column is
 * `simple-json` and nullable, so the comparison is canonical: key order does
 * not count, an `undefined` key equals a missing one (JSON drops it), and a
 * `null`/absent config equals `{}` — every reader treats them alike, so
 * writing `{}` over `null` would be a change nobody can see.
 */
function isSameReadmeConfig(
    stored: MarkdownReadmeConfig | null | undefined,
    candidate: MarkdownReadmeConfig,
): boolean {
    return canonicalJson(stored ?? {}) === canonicalJson(candidate);
}

/**
 * APW-01 T39 (FR-40a) — the sentence a partial or refused deletion ends with.
 *
 * Notes are only ever APPENDED, so a caller that matched on the base sentence (the
 * `have been deleted` e2e assertions) keeps matching, and a caller that reads the
 * whole message learns which repositories stayed and why.
 */
function withDeleteNotes(base: string, notes: string[]): string {
    if (notes.length === 0) {
        return base;
    }
    return `${base}. Kept: ${notes.join('; ')}.`;
}

/**
 * The relation an App Work was created with, read the way
 * `AppWorkCreateService.appSourceViewOf` reads it (`:1363-1368`) so the two surfaces
 * cannot disagree about what a row means. Anything unrecognised reads as `link`, which
 * is the safe reading: the platform cannot prove it created the repository.
 */
function appWorkRepositoryRelation(work: Work): 'link' | 'fork' | 'private-copy' {
    const type = (work.sourceRepository as unknown as AppSourceRecord | undefined)?.type;
    if (type === 'app_fork') {
        return 'fork';
    }
    if (type === 'app_private_copy') {
        return 'private-copy';
    }
    return 'link';
}

/** Did THIS Work create the Work Repository? (R-4: only a fork or private copy it asked for.) */
function appWorkCreatedItsRepository(work: Work): boolean {
    return (
        (work.sourceRepository as unknown as AppSourceRecord | undefined)?.createdByThisWork ===
        true
    );
}

/** Is the `website` role literally the upstream repository? Full-name compare, case-insensitive. */
function appWorkRepositoryIsUpstream(work: Work): boolean {
    const upstream = (work.sourceRepository as unknown as AppSourceRecord | undefined)?.upstream;
    if (!upstream?.owner || !upstream.repo) {
        return false;
    }
    return sameFullName(
        upstream.owner,
        upstream.repo,
        work.getRepoOwner('website'),
        work.getWebsiteRepo(),
    );
}

function sameFullName(ownerA: string, repoA: string, ownerB: string, repoB: string): boolean {
    return (
        ownerA.toLowerCase() === ownerB.toLowerCase() && repoA.toLowerCase() === repoB.toLowerCase()
    );
}

/**
 * The deploy target an App Work's workloads live on, derived the way
 * `AppWorkCreateService.appSourceViewOf` derives it (`:1372-1378`): `null` ⇒ **None**,
 * the managed choice ⇒ **Ever Works Apps**, anything else ⇒ **Your cluster**.
 *
 * Used only for the failure message of a removal the App runtime could not confirm —
 * the authoritative reader is APW-06's `GET /api/works/:id/app-target`, which is not
 * mounted yet (a `404` there means **None**).
 */
function appDeployTargetOf(work: Work): AppWorkDeletionOutcome['target'] {
    const persisted = (work.deployProvider ?? '').trim();
    if (!persisted) {
        return 'none';
    }
    return persisted.toLowerCase() === 'ever-works-apps' ? 'ever-works-apps' : 'your-cluster';
}

/**
 * The reason CODE of a failed removal — never a message body, which could carry a
 * provider's response text, and never a value (plan §7's "reason code only").
 */
function describeFailureCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.length > 0) {
        return code;
    }
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number') {
        return `http_${status}`;
    }
    const name = (error as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.length > 0 && name !== 'Error' ? name : 'unknown';
}
