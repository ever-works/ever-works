import {
    BadRequestException,
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    APP_CREATE_IDEMPOTENCY_WINDOW_MS,
    APP_CREATE_LOCK_TTL_MS,
    APP_PRIVATE_COPY_MAX_SIZE_KB,
    APP_PRIVATE_COPY_NAME_ATTEMPTS,
    APP_REPOSITORY_MODES,
    APP_SOURCE_REPOSITORY_TYPE_BY_MODE,
    isAppWorkKind,
    type AppDeployTargetChoice,
    type AppRepositoryMode,
    type AppSourceBlueprintMatchSource,
    type AppSourceCreatedView,
    type AppSourceInspectResponse,
    type AppSourceReasonCode,
    type AppSourceRecord,
    type AppUpstreamRef,
} from '@ever-works/contracts';
import { type AppsTierPolicy, APPS_TIER_POLICY } from '../app-runtime/ports';
import { config } from '../config';
import type { User } from '../entities/user.entity';
import { GenerateStatusType } from '../entities/types';
import type { Work } from '../entities/work.entity';
import { WorkCreatedEvent } from '../events';
import { CreateWorkDto } from '../dto/create-work.dto';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import {
    GitFacadeService,
    GitOperationNotSupportedError,
    type GitFacadeOptions,
} from '../facades/git.facade';
import { DeployFacadeService } from '../facades/deploy.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import {
    parseRepositoryWorkSource,
    type RepositoryWorkSource,
} from '../works/repository-work-source';
import {
    APP_FORK_READINESS_DISPATCHER,
    type AppForkReadinessDispatcher,
} from './app-upstream-state.service';
import { APP_SOURCE_CATALOG_PORT, type AppSourceCatalogPort } from './app-source-catalog.port';
import { APP_PROMPTED_VALUES_PORT, type AppPromptedValuesPort } from './app-prompted-values.port';
import {
    APP_MANAGED_TARGET_CHOICE,
    APP_MANAGED_TARGET_INPUT_ALIAS,
    APP_TIER_CAPABILITY,
    AppSourceInspectorService,
    resolveAppUpstreamRef,
    type AppSourceErrorBody,
} from './app-source-inspector.service';

/**
 * APW-01 T13 — the App Work create path.
 *
 * Spec: `docs/specs/features/app-works/APW-01-app-work-kind/spec.md` FR-11…FR-30,
 * FR-45, FR-55, FR-56, FR-59.
 * Plan: `…/plan.md` §2.3 (`plan.md:196-221`, the create flow) and §4.2
 * (`plan.md:492-619`, the twelve steps and the `stateRow(work)` table).
 *
 * ## The one sentence this file implements
 *
 * An `app`-kind create ACTS on `repositoryMode` / `targetOwner` / `blueprintId` /
 * `autoProvision`: it links, forks or privately copies the upstream repository,
 * writes the Work row **and** its `WorkUpstreamState` row in one transaction, and
 * dispatches readiness.
 *
 * ## The ordering rules, and why they are what they are
 *
 * 1. **Nothing is persisted and nothing is written before step 9** (plan `:502`).
 *    Every refusal below — the instance setting, the URL, the mode, the owner, the
 *    deploy target, the slug, the lock, the own-Work lookup, the Blueprint —
 *    answers with ZERO provider writes and ZERO repository writes. That is the
 *    property the whole refusal matrix exists to guarantee, and it is why the
 *    provider write sits between the last validation and the transaction.
 * 2. **The provider write happens AFTER every validation and BEFORE persistence**
 *    (`plan.md:219-221`): GitHub decides a fork's final name, so the rows cannot be
 *    written first. If persistence then fails, the fork stays on GitHub and the
 *    next identical request ADOPTS it (FR-25) — never a second fork. There is
 *    deliberately no compensating delete.
 * 3. **One transaction, through the repository wrappers — never an injected
 *    `DataSource`** (plan `:551-559`): `DatabaseModule` exports repository wrappers
 *    only (`database.module.spec.ts`). Both `create` calls receive the SAME
 *    transaction manager, so a throw rolls both rows back and leaves the fork.
 * 4. **The Blueprint is settled server-side** (FR-29b, step 6a): it is persisted
 *    from the resolution, never from the request alone. A member never gets a
 *    Blueprint they did not see, and a `blueprintId` the resolver does not return is
 *    `400 blueprint_mismatch` with nothing written.
 * 5. **Steps 11 and 12 run only after the transaction resolves** (plan `:567`).
 *
 * ## The values that are captured, never re-read
 *
 * `sourceRepository.createdByThisWork` is `true` **only** when this request issued
 * the fork request or created the private-copy repository (R-4); an adopted fork, a
 * link and a pasted fork are all `false`. `deployProvider` is the resolved plugin
 * id — the managed choice is the `apps-tier` plugin's id and **never** the literal
 * `'ever-works'` (plan §7). `sourceRepository.autoProvision` is written **only**
 * when the member declined, so an absent field means "on" and no existing caller or
 * row changes (plan §3.1, §4.2 step 10). And the readiness payload's `providerId` /
 * `credentialVersion` are captured at the enqueue site, before the transaction.
 */

/** The lock key prefix; the full key is `app-create:<userId>:<provider>:<upstream>:<mode>:<owner>`. */
export const APP_CREATE_LOCK_PREFIX = 'app-create:';

/** The `appSource` block plus the Work, as the route answers it (plan `:599-611`). */
export interface AppWorkCreateResult {
    status: 'success';
    work: Work;
    appSource: AppSourceCreatedView;
    /** Present and `true` when an equivalent App Work already existed (FR-23). */
    alreadyExisted?: boolean;
}

/** Everything step 4 decided about the deploy target. */
interface ResolvedDeployTarget {
    target: AppDeployTargetChoice;
    /** The plugin id to persist, or `null` for **None**. */
    providerId: string | null;
}

/**
 * The `(providerId, credentialVersion)` pair the readiness dispatch carries,
 * captured at the enqueue site (plan `:573-581`).
 */
interface DispatchBinding {
    providerId: string;
    credentialVersion?: number;
}

/** The Blueprint step 6a settled: an id, or nothing at all. */
interface ResolvedBlueprint {
    id?: string;
    version?: string;
    name?: string;
    matchSource?: AppSourceBlueprintMatchSource;
}

/** What step 9 produced: the Work Repository, its tracked branch and its upstream. */
interface ResolvedRelation {
    owner: string;
    repo: string;
    dataDefaultBranch: string;
    /** `null` for a link — a link has no upstream (APW-02 §3.1). */
    upstream: AppUpstreamRef | null;
    createdByThisWork: boolean;
}

@Injectable()
export class AppWorkCreateService {
    private readonly logger = new Logger(AppWorkCreateService.name);

    constructor(
        private readonly inspector: AppSourceInspectorService,
        private readonly locks: DistributedTaskLockService,
        // `@Optional()` on the three cross-module collaborators and on
        // `EventEmitter2`, for the reason `AppUpstreamStateService` records for its
        // own: a graph that does not import `DatabaseModule` / `FacadesModule` (or
        // does not register the global `EventEmitterModule`) must still COMPILE
        // this module, and an absent collaborator must degrade to a named refusal
        // rather than to `undefined.something`. Each one is a **value** import — a
        // type-only import would emit `Object` as the injection token and Nest
        // would inject `undefined` even on the real graph — and `AppWorksModule`
        // imports both modules while every application root registers the global
        // event emitter, so on every real installation they are present.
        @Optional()
        private readonly gitFacade: GitFacadeService,
        @Optional()
        private readonly deployFacade: DeployFacadeService,
        @Optional()
        private readonly workRepository: WorkRepository,
        private readonly workUpstreamStates: WorkUpstreamStateRepository,
        @Optional()
        private readonly eventEmitter?: EventEmitter2,
        // Everything below is a token or `@Optional()`, and each absence has a
        // DOCUMENTED answer rather than a crash.
        @Optional()
        @Inject(APP_FORK_READINESS_DISPATCHER)
        private readonly readinessDispatcher?: AppForkReadinessDispatcher,
        @Optional()
        @Inject(APP_SOURCE_CATALOG_PORT)
        private readonly catalog?: AppSourceCatalogPort,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tierPolicy?: AppsTierPolicy,
        @Optional()
        @Inject(APP_PROMPTED_VALUES_PORT)
        private readonly promptedValues?: AppPromptedValuesPort,
        /**
         * Read for TWO questions only, both of which are "what does this plugin
         * declare": whether an explicitly requested `deployProvider` names the
         * `apps-tier` plugin (plan §4.2 step 4 names `PluginRegistryService` for
         * exactly this lookup), and which target an ALREADY existing App Work's
         * persisted `deployProvider` names, for the idempotent answer. Every other
         * target decision comes from the inspection.
         */
        @Optional()
        private readonly registry?: PluginRegistryService,
    ) {}

    /**
     * Create one App Work. See the class docstring for the ordering contract.
     *
     * The caller is `WorkLifecycleService.createWork`, which branches here for
     * `isAppWorkKind(normalizedKind)` and therefore never runs
     * `resolveProviderDefaults` for this kind — onboarding defaults are never
     * applied to an App Work (plan §4.2 step 4).
     */
    async create(dto: CreateWorkDto, user: User): Promise<AppWorkCreateResult> {
        // ── Step 1 — the instance setting (R-6) ──────────────────────────────
        // Checked here as well as in the inspector: a direct service call must be
        // refused identically to an HTTP one, and this is the check that refuses
        // with zero provider calls.
        if (!config.everWorks.apps.worksEnabled()) {
            throw this.refuse(
                'app_works_disabled',
                400,
                'Creating App Works is turned off on this installation.',
            );
        }

        // The three cross-module collaborators are `@Optional()` so the module
        // compiles without `DatabaseModule` / `FacadesModule`; a graph that lacks
        // them cannot create anything, and it says so by name instead of failing
        // on `undefined.findAppWorksByDataRepository`.
        if (!this.gitFacade || !this.workRepository || !this.deployFacade) {
            throw this.refuse(
                'app_works_disabled',
                503,
                'App Works are not available in this deployment: the Git, deploy or Work repository ' +
                    'providers are not wired into the App Works module.',
            );
        }

        // ── Step 2 — the URL, and the provider it names ──────────────────────
        const source = parseRepositoryWorkSource(dto.repositoryUrl);
        if (!source) {
            throw this.refuse(
                'invalid_url',
                400,
                'A repository URL is required — an existing https://github.com/<owner>/<repo> your ' +
                    'connected GitHub account can reach (only GitHub is supported today).',
            );
        }
        if (dto.gitProvider && dto.gitProvider !== source.gitProvider) {
            throw this.refuse(
                'invalid_url',
                400,
                `Repository ${source.url} is hosted on ${source.gitProvider}, but the request selected the ` +
                    `"${dto.gitProvider}" git provider. Select the provider that hosts the repository.`,
            );
        }

        // ── Step 3 — the mode, the owner and the provisioning choice ─────────
        // The same two rules `CreateWorkDto` enforces through `@ValidateIf` +
        // `@IsDefined`, repeated so a caller that reached the service without the
        // pipe (the internal CLI, a direct service call) is refused IDENTICALLY —
        // hence the same Nest-rendered body the validation pipe produces.
        const mode = dto.repositoryMode;
        if (!mode) {
            throw new BadRequestException('repositoryMode must be defined');
        }
        if (!(APP_REPOSITORY_MODES as readonly string[]).includes(mode)) {
            throw new BadRequestException(
                `repositoryMode must be one of ${APP_REPOSITORY_MODES.join(', ')}`,
            );
        }
        const requiresTargetOwner = mode === 'fork' || mode === 'private-copy';
        const requestedOwner = firstNonEmpty(dto.targetOwner);
        if (requiresTargetOwner && !requestedOwner) {
            throw new BadRequestException('targetOwner must be defined');
        }

        // `autoProvision` is the only one of the four fields that is not a
        // validation rule: absent means ON, and only an explicit `false` is carried
        // to step 10 (plan §3.3, §4.2 step 3).
        const autoProvision = dto.autoProvision !== false;

        // ── Step 4 — the deploy target ───────────────────────────────────────
        const deploy = await this.resolveDeployTarget(dto.deployProvider, user);

        // ── Step 5 — the slug ────────────────────────────────────────────────
        // The same per-user uniqueness rule `WorkQueryService.checkSlugAvailability`
        // applies, read through `WorkRepository` so no `WorkModule` provider is
        // injected (T11's no-cycle condition).
        //
        // One collision is NOT refused here: a request identical enough for FR-23's
        // idempotent answer always carries the slug the first request took, so
        // refusing every taken slug at this step made `alreadyExisted` unreachable
        // (C9). When the slug's holder is the caller's own App Work created inside
        // the idempotency window, the refusal is DEFERRED to step 8, which either
        // finds that Work on this request's repository and returns it, or throws
        // this same `409` — still before any provider write. Every other collision
        // is refused here, before the inspector, exactly as before.
        let slugConflictDeferred = false;
        if (await this.workRepository.existsByUserAndSlug(user.id, dto.slug)) {
            if (!(await this.slugHeldByFreshOwnAppWork(user.id, dto.slug))) {
                throw slugTakenConflict(dto.slug);
            }
            slugConflictDeferred = true;
        }

        // ── Step 6 — the fresh inspection ────────────────────────────────────
        // `fresh: true`: a create decides on today's provider answer, never on a
        // preview the member triggered a minute ago.
        const inspect = await this.inspector.inspect(dto.repositoryUrl, user, {
            fresh: true,
            targetOwner: requestedOwner ?? undefined,
            mode,
            ...(dto.blueprintId ? { blueprintId: dto.blueprintId } : {}),
        });

        // A rate limit is a `503` with `Retry-After`, not a `400`: nothing about the
        // request was wrong, and the member can act on the instant.
        if (inspect.modes[mode]?.reason === 'rate_limited' || inspect.retryAfter) {
            throw this.refuse(
                'rate_limited',
                503,
                'GitHub is rate-limiting this account. Try again shortly.',
                inspect.retryAfter ? { retryAfter: inspect.retryAfter } : undefined,
            );
        }

        // The mode must be available FOR THE CHOSEN OWNER: an owner the caller asked
        // for that is not among their accounts is refused here, with the
        // inspector's own code (FR-13).
        const ownerEntry = requestedOwner
            ? inspect.targetOwners.find((owner) => sameLogin(owner.login, requestedOwner))
            : undefined;
        if (requiresTargetOwner && (!ownerEntry || !ownerEntry.available)) {
            throw this.refuse(
                ownerEntry?.reason ?? 'target_owner_unavailable',
                400,
                `The account "${requestedOwner}" is not one your connected GitHub account can create ` +
                    'repositories in.',
            );
        }

        const modeAvailability = inspect.modes[mode];
        if (!modeAvailability?.available) {
            const code = modeAvailability?.reason ?? 'not_found';
            throw this.refuse(
                code,
                code === 'in_use_by_another_account' ? 409 : 400,
                this.modeRefusalMessage(code, mode, inspect),
                code === 'in_use_by_another_account'
                    ? { fullName: inspect.repository.fullName }
                    : undefined,
            );
        }

        // Step 6's confirmation of step 4, from the SAME fresh inspection: the
        // requested target must be available and carry the `providerId` this create
        // persists. One answer, so the two steps cannot disagree.
        deploy.providerId = this.confirmDeployTarget(deploy, inspect);

        // ── Step 6a — the Blueprint, settled server-side (FR-29b) ────────────
        const upstreamCoordinates = resolveAppUpstreamRef(inspect.repository);
        const catalogCoordinates = upstreamCoordinates ?? {
            owner: inspect.repository.owner,
            repo: inspect.repository.repo,
        };
        const blueprint = await this.resolveBlueprint(dto.blueprintId, inspect, catalogCoordinates);

        // ── Step 7 — the lock (FR-22) ────────────────────────────────────────
        // Concurrent identical creates are serialised; the loser answers `409`
        // rather than racing a second fork or a second Work row.
        const lockKey = appCreateLockKey({
            userId: user.id,
            providerId: source.gitProvider,
            upstream: `${catalogCoordinates.owner}/${catalogCoordinates.repo}`,
            mode,
            owner: requestedOwner ?? inspect.repository.owner,
        });

        const locked = await this.locks.runExclusive(
            lockKey,
            () =>
                this.createLocked({
                    dto,
                    user,
                    source,
                    mode,
                    inspect,
                    deploy,
                    blueprint,
                    autoProvision,
                    requestedOwner,
                    upstreamCoordinates,
                    slugConflictDeferred,
                }),
            { ttlMs: APP_CREATE_LOCK_TTL_MS },
        );

        if (!locked.acquired) {
            throw this.refuse(
                'create_in_progress',
                409,
                'Another request is already creating this App Work. Try again in a moment.',
            );
        }

        return locked.result!;
    }

    /* ---------------------------------------------------------------------- *
     * Everything below runs inside the lock (steps 8 … 12)
     * ---------------------------------------------------------------------- */

    private async createLocked(input: {
        dto: CreateWorkDto;
        user: User;
        source: RepositoryWorkSource;
        mode: AppRepositoryMode;
        inspect: AppSourceInspectResponse;
        deploy: ResolvedDeployTarget;
        blueprint: ResolvedBlueprint;
        autoProvision: boolean;
        requestedOwner: string | null;
        upstreamCoordinates: AppUpstreamRef | null;
        /** Step 5 found the slug taken by a fresh own App Work (see step 5). */
        slugConflictDeferred: boolean;
    }): Promise<AppWorkCreateResult> {
        const {
            dto,
            user,
            source,
            mode,
            inspect,
            deploy,
            blueprint,
            autoProvision,
            requestedOwner,
        } = input;
        const gitOptions: GitFacadeOptions = { userId: user.id, providerId: source.gitProvider };

        // The dispatch binding is captured HERE — at the enqueue site, before the
        // provider write and before the transaction — so APW-02 T32's drained
        // credential skip can drop a run whose connection rotated in between. It is
        // never re-read after the transaction (plan `:573-581`).
        const dispatchBinding = this.captureDispatchBinding(source);

        const target = inspect.targetOwners.find((owner) => sameLogin(owner.login, requestedOwner));
        const adoptedFork = target?.existingFork;

        // ── Step 8, part one — the own-Work lookup for coordinates we know ───
        // Known up front for a link and for an adopted fork: those coordinates
        // already exist, so an equivalent Work can be found before any provider
        // write. A brand-new fork or copy has no coordinates yet — that half is
        // re-checked after step 9.
        if (mode === 'link') {
            const existing = await this.findEquivalentWork(
                user.id,
                inspect.repository.owner,
                inspect.repository.repo,
                dto.slug,
            );
            if (existing) {
                return existing;
            }
        } else if (mode === 'fork' && adoptedFork) {
            const existing = await this.findEquivalentWork(
                user.id,
                adoptedFork.owner,
                adoptedFork.repo,
                dto.slug,
            );
            if (existing) {
                return existing;
            }
        }

        // The deferred half of step 5: the taken slug was not this request's own
        // idempotent answer, so it is refused exactly as step 5 refuses it — and,
        // like every refusal, before the provider write. A deferred request that
        // would create a brand-new fork or private copy always lands here: it has
        // no coordinates yet, so it cannot be the equivalent of a Work that already
        // exists (a private-copy double-submit therefore still answers this 409).
        if (input.slugConflictDeferred) {
            throw slugTakenConflict(dto.slug);
        }

        // ── Step 9 — the provider write ──────────────────────────────────────
        const relation = await this.applyRelation({
            mode,
            source,
            inspect,
            gitOptions,
            upstream: input.upstreamCoordinates,
            requestedOwner,
            targetOwnerIsOrganization: target?.type === 'organization',
            adoptedFork,
            // FR-19: an owner the 15-call budget did not reach is NOT reported as
            // having no fork, so the create path has to answer the question the scan
            // could not — otherwise it would fork into an account that already holds
            // a fork of this network, which GitHub refuses.
            ownerForkChecked: target?.existingForkChecked === true,
        });

        // The post-step-9 half of step 8: a Work that appeared on the coordinates
        // this request just created is a genuine conflict (the idempotent case was
        // answered above, where the coordinates already existed), and it is refused
        // — never a second Work row.
        await this.findEquivalentWork(user.id, relation.owner, relation.repo, dto.slug, {
            idempotent: false,
        });

        // ── Step 10 — one transaction, both rows ─────────────────────────────
        const workData = this.buildWorkData({
            dto,
            user,
            source,
            mode,
            inspect,
            deploy,
            blueprint,
            autoProvision,
            relation,
            targetOwnerIsOrganization: target?.type === 'organization',
        });

        const work = await this.workRepository.withTransaction(async (manager) => {
            const created = await this.workRepository.create(workData, user, manager);
            await this.workUpstreamStates.create(
                {
                    workId: created.id,
                    relation: mode,
                    dataOwner: relation.owner,
                    dataRepo: relation.repo,
                    // A private copy's shell is empty and reports whatever branch it
                    // likes; the tracked branch is the UPSTREAM's, because that is
                    // what the copy's history is pushed onto (plan §4.2 step 10).
                    dataDefaultBranch: relation.dataDefaultBranch,
                    upstreamOwner: relation.upstream?.owner ?? null,
                    upstreamRepo: relation.upstream?.repo ?? null,
                    upstreamDefaultBranch: relation.upstream?.defaultBranch ?? null,
                    // The per-relation table of plan §4.2 step 10, column by column.
                    upstreamStatus: mode === 'link' ? 'none' : 'unknown',
                    actionsState: mode === 'link' ? 'not_applicable' : 'pending',
                    nextSyncAt: null,
                    readinessStartedAt: new Date(),
                },
                manager,
            );
            return created;
        });

        // ── Step 11 — dispatch readiness, after the commit ───────────────────
        const runId = await this.dispatchReadiness(work.id, dispatchBinding);
        if (runId === null) {
            // A dispatch the platform could not hand to a runner is recorded ON the
            // row, so APW-02's sweeper re-dispatches it instead of the Work resting
            // in `preparing` forever (plan `:580-581`).
            await this.workUpstreamStates.update(work.id, {
                readinessReason: 'dispatch_unavailable',
            });
        }

        // Write-only prompted values (FR-55): handed over as soon as the transaction
        // committed, never persisted here and never echoed by a read.
        await this.storePromptedValues(work.id, dto.appEnv);

        // ── Step 12 — the create event, exactly as `createWork` emits it ─────
        // `emitAsync` awaits every listener, exactly as `createWork` does, so the
        // activity-log rows exist before the controller answers. `EventEmitter2` is
        // global on every real graph; a graph without it logs that the event was
        // not emitted rather than failing the create.
        if (this.eventEmitter) {
            await this.eventEmitter.emitAsync(
                WorkCreatedEvent.EVENT_NAME,
                new WorkCreatedEvent(work),
            );
        } else {
            this.logger.warn(
                `App Work create: no event emitter is bound, so '${WorkCreatedEvent.EVENT_NAME}' was not ` +
                    `emitted for work ${work.id}.`,
            );
        }

        return {
            status: 'success',
            work,
            appSource: this.buildAppSourceView({
                mode,
                dataOwner: relation.owner,
                dataRepo: relation.repo,
                upstream: relation.upstream,
                deployTarget: deploy.target,
                blueprint,
            }),
        };
    }

    /* ---------------------------------------------------------------------- *
     * Step 4 and step 6 — the deploy target
     * ---------------------------------------------------------------------- */

    /**
     * Resolve the requested `deployProvider` into a target choice and the plugin id
     * to persist (plan §4.2 step 4).
     *
     * Three inputs, each answering a different question:
     *
     *   - the **registry** says whether an explicitly requested id declares
     *     `apps-tier` — which is what makes it the managed target rather than a
     *     cluster one, and what routes a closed tier to
     *     `managed_hosting_unavailable` instead of `cluster_target_unavailable`;
     *   - the **facade** says whether the id is a provider this member can use at
     *     all (`getAvailableProvidersForUser`, the call the plan names);
     *   - the **fresh inspection** supplies the id to persist for the managed target
     *     when the member sent the `'ever-works'` alias instead of a real id — see
     *     {@link confirmDeployTarget}.
     *
     * **`'ever-works'` is an input ALIAS and is never persisted.** That pre-existing
     * id is the platform's own website managed hosting: its quota counts it and the
     * deploy facade maps it to the shared cluster, so writing it here would put
     * user-controlled code on the platform's own hosting path (plan §7 — a
     * launch-gate violation, not a naming nit).
     */
    private async resolveDeployTarget(
        requestedProvider: string | undefined,
        user: User,
    ): Promise<ResolvedDeployTarget> {
        const requested = firstNonEmpty(requestedProvider);
        if (!requested) {
            // Absent ⇒ **None — don't deploy yet** (R-12), and nothing is persisted.
            return { target: 'none', providerId: null };
        }

        const isAlias = sameLogin(requested, APP_MANAGED_TARGET_INPUT_ALIAS);
        const isTierPlugin = isAlias || (await this.requestedIdIsAppsTier(requested, user.id));

        if (isTierPlugin) {
            // R-5: an unbound policy means CLOSED, and the environment variable
            // behind the tier's ceiling is never read here.
            if (this.tierPolicy?.isOpen() !== true) {
                throw this.refuse(
                    'managed_hosting_unavailable',
                    400,
                    'Ever Works Apps hosting is not open on this installation yet. Choose "Your cluster" or ' +
                        '"None — don\'t deploy yet".',
                );
            }
            // The real id comes from the inspection in `confirmDeployTarget`: step 4
            // must not name a plugin itself (plan §7: never a hard-coded id).
            return { target: APP_MANAGED_TARGET_CHOICE, providerId: null };
        }

        // Any other id must be a deployment provider this member can actually use,
        // otherwise the target does not exist for them.
        let enabled = false;
        try {
            const providers = await this.deployFacade.getAvailableProvidersForUser(user.id);
            enabled = providers.some(
                (provider) => sameLogin(provider.id, requested) && provider.enabled === true,
            );
        } catch (error) {
            this.logger.warn(
                `App Work create: the deploy facade could not list providers (${errorText(error)}).`,
            );
            enabled = false;
        }
        if (!enabled) {
            throw this.refuse(
                'cluster_target_unavailable',
                400,
                `The deploy provider "${requested}" is not available for your account.`,
            );
        }

        return { target: 'your-cluster', providerId: requested };
    }

    /**
     * Whether the requested id names the enabled `apps-tier` plugin.
     *
     * The registry is the only collaborator that can answer this, and it is
     * `@Optional()`: unbound (or a registry that does not list the id), the answer
     * is `false` and the request is treated as a cluster target — which then fails
     * on its own merits with `cluster_target_unavailable` if no cluster provider
     * carries that id. Fail-closed in both directions: nothing reaches the managed
     * tier by a guess.
     */
    private async requestedIdIsAppsTier(providerId: string, userId: string): Promise<boolean> {
        if (!this.registry) {
            return false;
        }
        try {
            const registered = await this.registry.getEnabledPluginsScoped(
                'deployment',
                undefined,
                userId,
            );
            return registered.some(
                (entry) =>
                    sameLogin(entry.plugin.id, providerId) &&
                    declaresCapability(entry, APP_TIER_CAPABILITY),
            );
        } catch (error) {
            this.logger.warn(
                `App Work create: the plugin registry could not classify "${providerId}" ` +
                    `(${errorText(error)}).`,
            );
            return false;
        }
    }

    /**
     * Step 6's confirmation of step 4, from the SAME fresh inspection the rest of
     * the create acts on: the requested target must be `available` and — for
     * anything but **None** — carry the `providerId` this request persists, which it
     * returns.
     *
     * The managed target is the one case step 4 cannot finish alone: the member may
     * have sent the `'ever-works'` alias, so the real id comes from here. And the
     * reverse guard matters just as much — an *available* managed target whose
     * `providerId` is missing is a state the contracts make unrepresentable, so
     * reaching it is a refusal rather than an `undefined` in the database.
     */
    private confirmDeployTarget(
        deploy: ResolvedDeployTarget,
        inspect: AppSourceInspectResponse,
    ): string | null {
        if (deploy.target === 'none') {
            return null;
        }

        const availability = inspect.deployTargets[deploy.target];
        const providerId = availability?.providerId;

        if (!availability?.available || !providerId) {
            const managedTarget = deploy.target === APP_MANAGED_TARGET_CHOICE;
            const code: AppSourceReasonCode =
                availability?.reason ??
                (managedTarget ? 'managed_hosting_unavailable' : 'cluster_target_unavailable');
            throw this.refuse(
                code,
                400,
                managedTarget
                    ? 'Ever Works Apps hosting is not available for this App Work yet.'
                    : `The deploy provider "${deploy.providerId}" cannot serve this App Work.`,
            );
        }

        // The resolved id is the persisted one, for both non-`none` targets: the
        // member's explicit choice must be the plugin the inspection resolved, so
        // "the providerId the create request persists" is a single value.
        if (deploy.providerId && !sameLogin(deploy.providerId, providerId)) {
            throw this.refuse(
                'cluster_target_unavailable',
                400,
                `The deploy provider "${deploy.providerId}" is not the provider the App source inspection ` +
                    'resolved for this target.',
            );
        }

        return providerId;
    }

    /* ---------------------------------------------------------------------- *
     * Step 6a — the Blueprint
     * ---------------------------------------------------------------------- */

    /**
     * Settle the Blueprint server-side (FR-29b, the D4 order).
     *
     * Uses step 6's already-fresh inspection, so no extra catalog call is made for
     * the two cases the inspection can answer:
     *
     *   - **no `blueprintId` sent** — a `matched` preview supplies its `{ id,
     *     matchSource }`; `none` or `unavailable` supplies nothing and creation is
     *     never refused for it. This is the D4 order for every client: the web form,
     *     chat, the MCP server and the command-line client all get the Blueprint the
     *     catalog matched.
     *   - **`blueprintId` sent and equal to the preview's id** — that match, with its
     *     own source.
     *   - **`blueprintId` sent and different** — the catalog is asked about THAT id:
     *     it returns that id ⇒ `matchSource: 'explicit'`; anything else ⇒
     *     `400 blueprint_mismatch` with nothing written. A member never gets a
     *     Blueprint they did not see.
     */
    private async resolveBlueprint(
        requestedId: string | undefined,
        inspect: AppSourceInspectResponse,
        coordinates: { owner: string; repo: string },
    ): Promise<ResolvedBlueprint> {
        const requested = firstNonEmpty(requestedId);
        const preview = inspect.blueprint;

        if (!requested) {
            if (preview.status === 'matched' && preview.id) {
                return {
                    id: preview.id,
                    version: preview.version,
                    name: preview.name,
                    matchSource: preview.matchSource ?? 'manifest',
                };
            }
            return {};
        }

        if (preview.status === 'matched' && preview.id === requested) {
            return {
                id: preview.id,
                version: preview.version,
                name: preview.name,
                matchSource: preview.matchSource ?? 'manifest',
            };
        }

        // An explicit pick the automatic resolution did not return: ask for THAT id.
        // An unbound catalog cannot confirm it, and "we cannot confirm" must never be
        // persisted as "it matched".
        let match: Awaited<ReturnType<AppSourceCatalogPort['matchBlueprint']>> = null;
        if (this.catalog) {
            try {
                match = await this.catalog.matchBlueprint({
                    owner: coordinates.owner,
                    repo: coordinates.repo,
                    blueprintId: requested,
                });
            } catch (error) {
                this.logger.warn(
                    `App Work create: the Apps catalog could not resolve "${requested}" ` +
                        `(${errorText(error)}).`,
                );
                match = null;
            }
        }

        if (!match || match.id !== requested) {
            throw this.refuse(
                'blueprint_mismatch',
                400,
                `The Blueprint "${requested}" cannot be applied to ${coordinates.owner}/${coordinates.repo}.`,
            );
        }

        return {
            id: match.id,
            version: match.version,
            name: firstNonEmpty(match.displayName) ?? firstNonEmpty(match.name) ?? undefined,
            // The plan fixes this branch's source: the caller named the entry, so the
            // match is `explicit` whatever the resolver's own source was.
            matchSource: 'explicit',
        };
    }

    /* ---------------------------------------------------------------------- *
     * Step 9 — link / fork / private copy
     * ---------------------------------------------------------------------- */

    /**
     * Turn the chosen mode into the Work Repository's coordinates, issuing the ONE
     * provider write this create is allowed.
     *
     *   - **link** — no write at all. The upstream IS the Work Repository, and its
     *     upstream columns stay NULL (APW-02 §3.1).
     *   - **fork** — an existing fork is ADOPTED (`createdByThisWork: false`); only
     *     when none exists is the fork request issued (`true`). A GitHub `403` on the
     *     target becomes `target_owner_forbidden`.
     *     When the inspection did **not** check this owner's fork (the 15-call
     *     budget did not reach it, FR-9), the question is asked here instead:
     *     "creating into that owner still adopts a fork that exists there"
     *     (FR-19, ACC-01-26) — otherwise the platform would ask GitHub to fork onto
     *     an account that already holds one, which GitHub refuses.
     *   - **private-copy** — only the empty private shell is created here; pushing the
     *     upstream's history is APW-02's job (FR-21), because it clones. A
     *     pre-existing repository of a candidate name is adopted only when it is
     *     EMPTY — otherwise the next name is tried, and when every name is taken the
     *     answer is `409 copy_name_unavailable`.
     */
    private async applyRelation(input: {
        mode: AppRepositoryMode;
        source: RepositoryWorkSource;
        inspect: AppSourceInspectResponse;
        gitOptions: GitFacadeOptions;
        upstream: AppUpstreamRef | null;
        requestedOwner: string | null;
        targetOwnerIsOrganization: boolean;
        adoptedFork?: { owner: string; repo: string };
        ownerForkChecked?: boolean;
    }): Promise<ResolvedRelation> {
        const {
            mode,
            inspect,
            gitOptions,
            upstream,
            requestedOwner,
            targetOwnerIsOrganization,
            adoptedFork,
        } = input;

        if (mode === 'link') {
            return {
                owner: inspect.repository.owner,
                repo: inspect.repository.repo,
                dataDefaultBranch: inspect.repository.defaultBranch,
                upstream: null,
                createdByThisWork: false,
            };
        }

        const upstreamRef: AppUpstreamRef = upstream ?? {
            owner: inspect.repository.owner,
            repo: inspect.repository.repo,
            defaultBranch: inspect.repository.defaultBranch,
        };
        const organization = targetOwnerIsOrganization ? requestedOwner! : undefined;

        if (mode === 'fork') {
            if (adoptedFork) {
                return {
                    owner: adoptedFork.owner,
                    repo: adoptedFork.repo,
                    // The fork carries the upstream's history, so its tracked branch
                    // is the upstream's — which is also what the state row's
                    // `dataDefaultBranch` must describe.
                    dataDefaultBranch: upstreamRef.defaultBranch,
                    upstream: upstreamRef,
                    createdByThisWork: false,
                };
            }

            // FR-19: the inspection could not answer "is there a fork here?" for an
            // owner the budget did not reach, so the create path asks — once, for the
            // one owner it is about to write into.
            if (input.ownerForkChecked === false && requestedOwner) {
                let unlookedFor: Awaited<ReturnType<GitFacadeService['findExistingFork']>> = null;
                try {
                    unlookedFor = await this.gitFacade.findExistingFork(
                        upstreamRef.owner,
                        upstreamRef.repo,
                        requestedOwner,
                        gitOptions,
                    );
                } catch (error) {
                    // A failed lookup is not a refusal: the fork request below is the
                    // authority, and GitHub answers 422 when one already exists.
                    this.logger.warn(
                        `App Work create: the existing-fork lookup for "${requestedOwner}" failed ` +
                            `(${errorText(error)}); issuing the fork request instead.`,
                    );
                }
                if (unlookedFor) {
                    return {
                        owner: firstNonEmpty(unlookedFor.owner) ?? requestedOwner,
                        repo: firstNonEmpty(unlookedFor.name) ?? upstreamRef.repo,
                        dataDefaultBranch:
                            firstNonEmpty(unlookedFor.defaultBranch) ?? upstreamRef.defaultBranch,
                        upstream: upstreamRef,
                        createdByThisWork: false,
                    };
                }
            }

            let fork: Awaited<ReturnType<GitFacadeService['forkRepository']>> = null;
            try {
                fork = await this.gitFacade.forkRepository(
                    upstreamRef.owner,
                    upstreamRef.repo,
                    // `waitForReady: false` — the request returns as soon as GitHub
                    // accepts it, and APW-02's readiness job owns the wait (FR-21,
                    // R-4). The response budget is 10 s and never waits for a fork.
                    { organization, waitForReady: false },
                    gitOptions,
                );
            } catch (error) {
                throw this.classifyProviderWriteFailure(error, requestedOwner);
            }
            if (!fork) {
                throw this.refuse(
                    'target_owner_unavailable',
                    503,
                    'GitHub did not accept the fork request. Try again, or pick another account.',
                    { owner: requestedOwner ?? undefined },
                );
            }

            return {
                owner: firstNonEmpty(fork.owner) ?? requestedOwner!,
                repo: firstNonEmpty(fork.name) ?? upstreamRef.repo,
                dataDefaultBranch: firstNonEmpty(fork.defaultBranch) ?? upstreamRef.defaultBranch,
                upstream: upstreamRef,
                createdByThisWork: true,
            };
        }

        // ── private-copy ─────────────────────────────────────────────────────
        for (const candidate of privateCopyNameCandidates(upstreamRef.repo)) {
            let existing: Awaited<ReturnType<GitFacadeService['getRepository']>> = null;
            try {
                existing = await this.gitFacade.getRepository(
                    requestedOwner!,
                    candidate,
                    gitOptions,
                );
            } catch (error) {
                throw this.classifyProviderWriteFailure(error, requestedOwner);
            }

            if (existing) {
                // An occupied name is adopted only when the repository is EMPTY:
                // writing into somebody's repository is never what "private copy"
                // means, and adopting a non-empty one is a decision this request has
                // no basis for.
                if (existing.empty !== true) {
                    continue;
                }
                return {
                    owner: firstNonEmpty(existing.owner) ?? requestedOwner!,
                    repo: firstNonEmpty(existing.name) ?? candidate,
                    // The UPSTREAM's branch, never the shell's reported one: the shell
                    // has no history, so its branch is not the tracked one.
                    dataDefaultBranch: upstreamRef.defaultBranch,
                    upstream: upstreamRef,
                    createdByThisWork: false,
                };
            }

            let created: Awaited<ReturnType<GitFacadeService['createRepository']>> = null;
            try {
                created = await this.gitFacade.createRepository(
                    { name: candidate, isPrivate: true, organization },
                    gitOptions,
                );
            } catch (error) {
                throw this.classifyProviderWriteFailure(error, requestedOwner);
            }
            if (!created) {
                continue;
            }
            return {
                owner: firstNonEmpty(created.owner) ?? requestedOwner!,
                repo: firstNonEmpty(created.name) ?? candidate,
                dataDefaultBranch: upstreamRef.defaultBranch,
                upstream: upstreamRef,
                createdByThisWork: true,
            };
        }

        throw this.refuse(
            'copy_name_unavailable',
            409,
            `Every candidate name for the private copy of ${upstreamRef.owner}/${upstreamRef.repo} is taken. ` +
                'Rename the repository or choose another account.',
            { owner: requestedOwner ?? undefined },
        );
    }

    /**
     * A provider-write failure, in this epic's vocabulary.
     *
     * A GitHub `403` on the TARGET account is the one the member can act on
     * (`target_owner_forbidden`: the account exists but this connection may not
     * create repositories in it). A provider that cannot fork or create at all is
     * `forking_disabled` — a real reason code from the closed set, and the honest
     * one. Everything else is `target_owner_unavailable` (the owner is not usable
     * right now), never a raw provider message.
     */
    private classifyProviderWriteFailure(
        error: unknown,
        requestedOwner: string | null,
    ): HttpException {
        if (error instanceof HttpException) {
            return error;
        }
        if (error instanceof GitOperationNotSupportedError) {
            return this.refuse(
                'forking_disabled',
                400,
                'The connected Git provider cannot fork or create repositories, so this mode is not ' +
                    'available.',
            );
        }
        if (isForbidden(error)) {
            return this.refuse(
                'target_owner_forbidden',
                400,
                `Your GitHub connection may not create repositories in ` +
                    `"${requestedOwner ?? 'that account'}". Grant repository-creation access, or pick ` +
                    'another account.',
                { owner: requestedOwner ?? undefined },
            );
        }
        this.logger.warn(`App Work create: the provider write failed (${errorText(error)}).`);
        return this.refuse(
            'target_owner_unavailable',
            503,
            `GitHub could not complete the request for "${requestedOwner ?? 'that account'}". Try again ` +
                'shortly.',
            { owner: requestedOwner ?? undefined },
        );
    }

    /* ---------------------------------------------------------------------- *
     * Steps 8 and 10 — persistence
     * ---------------------------------------------------------------------- */

    /**
     * Whether a taken slug may be FR-23's idempotent answer (step 5, C9): its
     * holder is the caller's own **App** Work, created inside
     * {@link APP_CREATE_IDEMPOTENCY_WINDOW_MS}. Only then is the slug refusal
     * deferred to step 8; any other holder — a Repository Work, an App Work older
     * than the window, or a row that vanished between the count and this read — is
     * refused at step 5, before the inspector, exactly as before.
     *
     * `owner: ''` makes the repository look the slug up by `{ userId, slug }`, the
     * same key `existsByUserAndSlug` counted.
     */
    private async slugHeldByFreshOwnAppWork(userId: string, slug: string): Promise<boolean> {
        const holder = await this.workRepository!.findByOwnerAndSlug({ userId, owner: '', slug });
        return (
            !!holder &&
            holder.userId === userId &&
            isAppWorkKind(holder.kind) &&
            withinIdempotencyWindow(holder.createdAt)
        );
    }

    /**
     * The own-Work lookup (step 8).
     *
     * `idempotent: true` (the up-front half) answers FR-23: the SAME slug created
     * within {@link APP_CREATE_IDEMPOTENCY_WINDOW_MS} returns the existing App Work
     * with `alreadyExisted: true` — a double-submit yields one Work and at most one
     * fork. Anything else on the same repository is `409 app_work_exists`, and the
     * other account's Work is never visible here: the lookup is scoped to the
     * caller's own Works and the answer names only theirs (FR-51).
     *
     * @returns the idempotent answer, or `null` when this request must continue.
     * @throws `409 app_work_exists` when an equivalent App Work already exists.
     */
    private async findEquivalentWork(
        userId: string,
        dataOwner: string,
        dataRepo: string,
        slug: string,
        options: { idempotent?: boolean } = { idempotent: true },
    ): Promise<AppWorkCreateResult | null> {
        const works = await this.workRepository.findAppWorksByDataRepository(
            userId,
            dataOwner,
            dataRepo,
        );
        if (!works.length) {
            return null;
        }

        if (options.idempotent !== false) {
            const fresh = works.find(
                (work) => work.slug === slug && withinIdempotencyWindow(work.createdAt),
            );
            if (fresh) {
                // The existing Work's own readiness is reported, not a hopeful
                // `preparing`: the client reads the same value the Upstream card
                // does.
                const state = await this.workUpstreamStates.findByWorkId(fresh.id);
                return {
                    status: 'success',
                    work: fresh,
                    appSource: await this.appSourceViewOf(fresh, state?.readinessState),
                    alreadyExisted: true,
                };
            }
        }

        const first = works[0];
        throw this.refuse(
            'app_work_exists',
            409,
            `An App Work for ${dataOwner}/${dataRepo} already exists.`,
            { workId: first.id, workName: first.name },
        );
    }

    /**
     * The Work row, exactly as plan §3.1's table fixes it.
     *
     * Two things are worth reading twice:
     *
     *   - **`owner` / `repo` and `relatedRepositories.website` are the SAME Work
     *     Repository**, and it is the `website` role — never `data`. The `data` role
     *     holds a Work's *content*; an App Work's app code is the Work Repository,
     *     whose UI label is literally "Work Repository" (README §1, plan §3.1).
     *     Top-level `owner`/`repo` carry it too because `GitFacadeService.getRepoDir`
     *     clones that pair.
     *   - **`autoProvision` is written ONLY when the member declined.** Absent means
     *     on, so no migration and no existing caller moves (plan §3.3).
     */
    private buildWorkData(input: {
        dto: CreateWorkDto;
        user: User;
        source: RepositoryWorkSource;
        mode: AppRepositoryMode;
        inspect: AppSourceInspectResponse;
        deploy: ResolvedDeployTarget;
        blueprint: ResolvedBlueprint;
        autoProvision: boolean;
        relation: ResolvedRelation;
        targetOwnerIsOrganization: boolean;
    }): Partial<Work> {
        const { dto, user, source, mode, deploy, blueprint, autoProvision, relation } = input;

        const repositoryUrl = `https://github.com/${relation.owner}/${relation.repo}`;
        const sourceRepository: AppSourceRecord<Date> = {
            url: repositoryUrl,
            owner: relation.owner,
            repo: relation.repo,
            type: APP_SOURCE_REPOSITORY_TYPE_BY_MODE[mode],
            importedAt: new Date(),
            relatedRepositories: {
                website: { owner: relation.owner, repo: relation.repo },
            },
            ...(relation.upstream ? { upstream: relation.upstream } : {}),
            ...(blueprint.id ? { blueprintId: blueprint.id } : {}),
            ...(blueprint.id && blueprint.matchSource
                ? { blueprintMatchSource: blueprint.matchSource }
                : {}),
            createdByThisWork: relation.createdByThisWork,
            ...(autoProvision ? {} : { autoProvision: false }),
        };

        return {
            slug: dto.slug,
            name: dto.name,
            description: dto.description,
            userId: user.id,
            // The Work Repository's owner is the Work's owner: it is what every
            // repository operation resolves through.
            owner: relation.owner,
            organization: input.targetOwnerIsOrganization,
            gitProvider: source.gitProvider,
            storageProvider: source.storageProvider,
            // The resolved plugin id, or `null` for **None** — which also keeps the
            // row out of the `deployProvider = 'ever-works'` quota count.
            deployProvider: deploy.providerId,
            // No website template for this kind, and no generation to wait for:
            // `generated` keeps `WorkStatusCard` hidden, because readiness lives on
            // the `work_upstream_states` row (plan §3.1).
            websiteTemplateId: null,
            generateStatus: { status: GenerateStatusType.GENERATED, step: 'linked' },
            syncIntervalMinutes: 0,
            readmeConfig: dto.readmeConfig,
            lastDeployCorrelationId: dto.correlationId ?? null,
            kind: 'app',
            sourceRepository,
        };
    }

    /* ---------------------------------------------------------------------- *
     * Steps 11 … 12, and the response
     * ---------------------------------------------------------------------- */

    /**
     * The `(providerId, credentialVersion)` pair the readiness payload carries,
     * captured at the ENQUEUE SITE — before the provider write and before the
     * transaction (plan `:573-581`).
     *
     * `providerId` is the git provider the parsed URL names (`github` for every host
     * the parser accepts today), taken from the parse rather than from any later
     * read.
     *
     * `credentialVersion` is `undefined`, and that is a deliberate, documented answer
     * rather than an omission: the only credential-version helper this tree has is
     * `CredentialVersionService`, which versions a **tenant's job-runtime overlay**,
     * not a member's git connection — reading it here would stamp a version that
     * describes something else. APW-02 defines `undefined` as "this provider has no
     * credential-version helper, so the credential is always current". The capture
     * POINT is fixed now so a git-credential-version helper can be swapped in without
     * moving it.
     */
    private captureDispatchBinding(source: RepositoryWorkSource): DispatchBinding {
        return { providerId: source.gitProvider, credentialVersion: undefined };
    }

    /**
     * Queue the readiness job (step 11) and answer the run id, or `null` when the
     * platform could not hand it to a runner.
     *
     * `null` covers all three failures the row has to survive: no dispatcher bound
     * (APW-02 T31 has not landed, or the operator runs without a job runtime), a
     * dispatch that threw, and a dispatcher that answered `null`. The caller records
     * `readinessReason = 'dispatch_unavailable'` so the sweeper re-dispatches,
     * instead of the Work resting in `preparing` forever.
     */
    private async dispatchReadiness(
        workId: string,
        binding: DispatchBinding,
    ): Promise<string | null> {
        if (!this.readinessDispatcher) {
            this.logger.warn(
                `App Work create: no readiness dispatcher is bound, so work ${workId} was not queued.`,
            );
            return null;
        }
        try {
            return (
                (await this.readinessDispatcher.dispatch({
                    workId,
                    attempt: 1,
                    reason: 'initial',
                    providerId: binding.providerId,
                    credentialVersion: binding.credentialVersion,
                })) ?? null
            );
        } catch (error) {
            this.logger.warn(
                `App Work create: dispatching readiness for work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * Hand the write-only prompted values to APW-07 (FR-55).
     *
     * One call carrying every name the member answered. An unbound port logs that the
     * values were dropped and NEVER refuses the create: the member asked for a Work,
     * and a missing env store is not a reason to refuse one. Names may be logged;
     * values never are (Constitution VII).
     */
    private async storePromptedValues(
        workId: string,
        appEnv: Record<string, string> | undefined,
    ): Promise<void> {
        const values = appEnv && typeof appEnv === 'object' ? appEnv : undefined;
        if (!values || !Object.keys(values).length) {
            return;
        }
        if (!this.promptedValues) {
            this.logger.warn(
                `App Work create: no prompted-values port is bound, so ${Object.keys(values).length} ` +
                    `provided value(s) for work ${workId} were dropped.`,
            );
            return;
        }
        try {
            await this.promptedValues.storePrompted(workId, values);
        } catch (error) {
            this.logger.warn(
                `App Work create: the prompted values for work ${workId} could not be stored ` +
                    `(${errorText(error)}).`,
            );
        }
    }

    /** The `appSource` block of the create answer (plan `:601-611`). */
    private buildAppSourceView(input: {
        mode: AppRepositoryMode;
        dataOwner: string;
        dataRepo: string;
        upstream: AppUpstreamRef | null;
        deployTarget: AppDeployTargetChoice;
        blueprint: ResolvedBlueprint;
    }): AppSourceCreatedView {
        return {
            relation: input.mode,
            // `preparing` on create; the readiness job owns every later state.
            readiness: 'preparing',
            dataRepository: {
                owner: input.dataOwner,
                repo: input.dataRepo,
                url: `https://github.com/${input.dataOwner}/${input.dataRepo}`,
            },
            ...(input.upstream ? { upstream: input.upstream } : {}),
            deployTarget: input.deployTarget,
            ...(input.blueprint.id
                ? {
                      blueprint: {
                          id: input.blueprint.id,
                          version: input.blueprint.version,
                          name: input.blueprint.name,
                          matchSource: input.blueprint.matchSource,
                      },
                  }
                : {}),
        };
    }

    /**
     * The `appSource` block for a Work that ALREADY existed (FR-23's idempotent
     * answer): rebuilt from what the row itself persisted, so a retried request sees
     * the same relation, repository, upstream, deploy target and Blueprint the first
     * one recorded — never a re-resolution that could disagree.
     *
     * The deploy target is derived the way APW-06 will derive its own: `null` ⇒
     * **None**, the `apps-tier` plugin ⇒ **Ever Works Apps**, anything else ⇒ **Your
     * cluster** (plan §3.1). The registry is `@Optional()`, so without it the literal
     * `'ever-works-apps'` is the fallback spelling.
     */
    private async appSourceViewOf(work: Work, readiness?: string): Promise<AppSourceCreatedView> {
        const record = work.sourceRepository as unknown as AppSourceRecord | undefined;
        const relation: AppRepositoryMode =
            record?.type === 'app_fork'
                ? 'fork'
                : record?.type === 'app_private_copy'
                  ? 'private-copy'
                  : 'link';

        const dataOwner = record?.relatedRepositories?.website?.owner ?? work.owner ?? '';
        const dataRepo = record?.relatedRepositories?.website?.repo ?? work.slug ?? '';
        const persisted = firstNonEmpty(work.deployProvider);
        const deployTarget: AppDeployTargetChoice = !persisted
            ? 'none'
            : sameLogin(persisted, APP_MANAGED_TARGET_CHOICE) ||
                (await this.requestedIdIsAppsTier(persisted, work.userId))
              ? APP_MANAGED_TARGET_CHOICE
              : 'your-cluster';

        return {
            relation,
            readiness: (readiness as AppSourceCreatedView['readiness']) ?? 'preparing',
            dataRepository: {
                owner: dataOwner,
                repo: dataRepo,
                url: `https://github.com/${dataOwner}/${dataRepo}`,
            },
            ...(record?.upstream ? { upstream: record.upstream } : {}),
            deployTarget,
            ...(record?.blueprintId
                ? {
                      blueprint: {
                          id: record.blueprintId,
                          matchSource: record.blueprintMatchSource,
                      },
                  }
                : {}),
        };
    }

    /** One refusal, in the shared error body (plan §4.2, openapi `AppSourceError`). */
    private refuse(
        code: AppSourceReasonCode,
        status: number,
        message: string,
        details?: AppSourceErrorBody['details'],
    ): HttpException {
        const body: AppSourceErrorBody = {
            status: 'error',
            code,
            message,
            ...(details ? { details } : {}),
        };
        if (status === 409) {
            return new ConflictException(body);
        }
        if (status === 503) {
            return new ServiceUnavailableException(body);
        }
        return new BadRequestException(body);
    }

    /** The member-facing sentence for a mode refusal, one per reason code. */
    private modeRefusalMessage(
        code: AppSourceReasonCode,
        mode: AppRepositoryMode,
        inspect: AppSourceInspectResponse,
    ): string {
        const fullName = inspect.repository.fullName;
        switch (code) {
            case 'no_push_access':
                return `Your GitHub connection cannot push to ${fullName}, so it cannot be linked. Fork it instead.`;
            case 'archived':
                return `${fullName} is archived and read-only. Fork it or make a private copy instead.`;
            case 'in_use_by_another_account':
                return `${fullName} is already used by another Ever Works account. Fork it instead.`;
            case 'forking_disabled':
                return `Forking is disabled on ${fullName}. Link it or make a private copy instead.`;
            case 'empty_repository':
                return `${fullName} is empty, so there is nothing to fork yet.`;
            case 'too_large_for_private_copy':
                return (
                    `${fullName} is larger than ${Math.round(APP_PRIVATE_COPY_MAX_SIZE_KB / 1000)} MB, ` +
                    'which the private copy ceiling does not allow.'
                );
            case 'uses_lfs':
                return `${fullName} stores files with Git LFS, which a private copy cannot carry yet.`;
            case 'not_found':
                return `${fullName} was not found or is not accessible with your connected GitHub account.`;
            case 'provider_not_connected':
                return 'Connect your GitHub account before creating an App Work from a repository.';
            case 'insufficient_scope':
                return 'Your GitHub connection is missing a permission this repository needs. Reconnect GitHub.';
            case 'sso_authorization_required':
                return 'This organization requires SAML SSO authorization for your GitHub token.';
            case 'oauth_app_restricted':
                return 'This organization restricts third-party OAuth apps.';
            default:
                return `The "${mode}" mode is not available for ${fullName}.`;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Module-private helpers
 * -------------------------------------------------------------------------- */

/**
 * The private-copy name ladder (FR-20).
 *
 * `APP_PRIVATE_COPY_NAME_ATTEMPTS` fixes how many names may be tried and the plan
 * fixes the last one as `-copy-5`, so the ladder is the repository's own name plus
 * `-copy-2` … `-copy-5`. (The plan's prose also lists a bare `-copy`; that would make
 * six candidates for a five-name budget and push `-copy-5` out of reach — the one
 * name the plan and this epic's tests both pin. Reported rather than guessed at
 * silently.)
 */
export function privateCopyNameCandidates(
    repo: string,
    attempts = APP_PRIVATE_COPY_NAME_ATTEMPTS,
): string[] {
    const bounded = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
    const candidates = [repo];
    for (let index = 2; index <= bounded; index += 1) {
        candidates.push(`${repo}-copy-${index}`);
    }
    return candidates;
}

/** The lock key of one create attempt (plan §4.2 step 7). */
export function appCreateLockKey(input: {
    userId: string;
    providerId: string;
    upstream: string;
    mode: AppRepositoryMode;
    owner: string;
}): string {
    return (
        `${APP_CREATE_LOCK_PREFIX}${input.userId}:${input.providerId}:` +
        `${input.upstream.toLowerCase()}:${input.mode}:${input.owner.toLowerCase()}`
    );
}

/**
 * The per-user slug refusal. One helper, because step 5 throws it directly and
 * step 8 throws it when step 5 deferred it — a member must not be able to tell
 * the two apart.
 */
function slugTakenConflict(slug: string): ConflictException {
    return new ConflictException(
        `A Work with the slug "${slug}" already exists. Choose another slug.`,
    );
}

/** FR-23's window: an identical create inside it returns the same App Work. */
function withinIdempotencyWindow(createdAt: Date | string | undefined): boolean {
    if (!createdAt) {
        return false;
    }
    const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
    if (!Number.isFinite(created)) {
        return false;
    }
    return Date.now() - created <= APP_CREATE_IDEMPOTENCY_WINDOW_MS;
}

/** A trimmed non-empty string, or `null`. */
function firstNonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/** Case-insensitive comparison for provider, account and plugin identifiers. */
function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
    const left = firstNonEmpty(a);
    const right = firstNonEmpty(b);
    return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

/** Whether a caught error is a provider `403` (or the permission the provider named). */
function isForbidden(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 403) {
        return true;
    }
    return (error as { reason?: unknown } | null)?.reason === 'permission_missing';
}

/** A plugin capability from the materialised instance or from the manifest that registered it. */
function declaresCapability(registered: RegisteredPlugin, capability: string): boolean {
    const fromManifest = Array.isArray(registered?.manifest?.capabilities)
        ? registered.manifest.capabilities
        : [];
    const capabilities = (registered?.plugin as { capabilities?: readonly string[] } | undefined)
        ?.capabilities;
    const fromInstance = Array.isArray(capabilities) ? capabilities : [];
    return fromInstance.includes(capability) || fromManifest.includes(capability);
}

/** An error as a short, log-safe string — never a payload, a credential or a provider URL. */
function errorText(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`.slice(0, 300);
    }
    return String(error).slice(0, 300);
}
