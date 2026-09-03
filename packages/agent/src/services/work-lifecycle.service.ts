import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
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
    normalizeCreateWorkKind,
    Work,
    type WorkKind,
    type WorkStatus,
} from '@src/entities/work.entity';
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
import { isRepositoryWorkKind } from '@ever-works/contracts';
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

    private async resolveValidatedWebsiteTemplateSelection(
        value: string | null | undefined,
        userId: string,
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

        return normalizedTemplateId;
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

        // Repository Work (self-build slice D, EW-766) — resolve and verify
        // the source repository FIRST so a bad, missing, unreachable or
        // already-wrapped URL fails before any side effect. A `repo` Work
        // has no website template and no deploy, so template validation and
        // the deploy quota are skipped for it.
        const repositorySource = isRepositoryWorkKind(normalizedKind)
            ? await this.resolveRepositoryWorkSource(createWorkDto, user)
            : null;

        const selectedWebsiteTemplateId = repositorySource
            ? null
            : await this.resolveValidatedWebsiteTemplateSelection(websiteTemplateId, user.id);

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
                const nextTemplateId = await this.resolveValidatedWebsiteTemplateSelection(
                    updateDto.websiteTemplateId,
                    user.id,
                );

                if (
                    nextTemplateId !==
                    this.normalizeWebsiteTemplateSelection(work.websiteTemplateId)
                ) {
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

            const updatedWork = await this.workRepository.update(id, updateData);

            if (!updatedWork) {
                throw new NotFoundException({ status: 'error', message: 'Work not found' });
            }

            updatedWork.owner = updatedWork.getRepoOwner();

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
        );

        const websiteRepoInitialized = await this.hasInitializedWebsiteRepository(work, user);
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const currentExplicitTemplateId = this.normalizeWebsiteTemplateSelection(
            work.websiteTemplateId,
        );
        const currentEffectiveTemplateId = await this.getEffectiveWebsiteTemplateId(work, user.id);
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

            updates.readmeConfig = work.readmeConfig || {};

            // Sync readme config from markdown templates
            const markdownTemplate = snapshot.readmeTemplate;
            if (markdownTemplate?.header && !work.readmeConfig?.header) {
                updates.readmeConfig.header = markdownTemplate.header;
                updates.readmeConfig.overwriteDefaultHeader = true;
            }

            if (markdownTemplate?.footer && !work.readmeConfig?.footer) {
                updates.readmeConfig.footer = markdownTemplate.footer;
                updates.readmeConfig.overwriteDefaultFooter = true;
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

        try {
            const deletedRepositories: string[] = [];

            if (!wrapsExistingRepository && deleteWorkDto.delete_data_repository !== false) {
                try {
                    await this.dataGenerator.removeRepository(work, user);
                    deletedRepositories.push(`${work.getRepoOwner()}/${work.getDataRepo()}`);
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete data repository:', error);
                }
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

            if (
                hasRepositoryRole(work, 'website') &&
                deleteWorkDto.delete_website_repository !== false
            ) {
                try {
                    await this.websiteGenerator.removeRepository(work, user);
                    deletedRepositories.push(
                        `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
                    );
                } catch (error) {
                    if (error instanceof HttpException) {
                        throw error;
                    }

                    this.logger.error('Failed to delete website repository:', error);
                }
            }

            await this.workRepository.delete(work.id);

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
                message: `Work '${work.slug}' and associated repositories have been deleted`,
                deleted_repositories: deletedRepositories,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'deleting work', {
                slug: work?.slug || '',
            });
        }
    }
}
