import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { type AppsTierPolicy, APPS_TIER_POLICY } from '../app-runtime/ports';
import { detectedLicenseSpdx } from '../app-license/license-classify';
import {
    APP_INSPECT_CACHE_TTL_MS,
    APP_INSPECT_MAX_PROVIDER_CALLS,
    APP_INSPECT_OWNER_MIN_CALLS_REMAINING,
    APP_TARGET_OWNER_SCAN_LIMIT_P1,
    canStartTargetOwnerScan,
    resolveAppRepositoryModes,
    type AppBlueprintPreview,
    type AppDeployTargetAvailability,
    type AppDeployTargetChoice,
    type AppModeAvailability,
    type AppRepositoryMode,
    type AppRepositoryModeFacts,
    type AppSourceBlueprintMatchSource,
    type AppSourceInspectResponse,
    type AppSourceLicensePreview,
    type AppSourceReasonCode,
    type AppTargetOwner,
    type AppUpstreamRef,
} from '@ever-works/contracts';
import {
    PLUGIN_CAPABILITIES,
    isAppDeploymentPlugin,
    type GitOrganization,
    type GitProviderErrorReason,
    type GitProviderRequestError,
    type GitRepository,
    type GitRepositoryWithPermissions,
    type IDeploymentPlugin,
} from '@ever-works/plugin';
import { config } from '../config';
import type { User } from '../entities/user.entity';
// NOTE: `GitFacadeService`, `DeployFacadeService` and `WorkRepository` are
// **value** imports, not `import type`, and that is load-bearing: both services of
// this epic inject them as constructor parameters, and `emitDecoratorMetadata`
// emits `Object` for a parameter whose type was elided by a type-only import —
// which Nest then cannot resolve, so the module fails to compile with
// "Nest can't resolve dependencies of the AppSourceInspectorService (?)". A
// type-only import here compiles and type-checks perfectly; it only breaks at
// module compile, which is exactly the failure mode
// `apps/api/src/__tests__/nest-injectable-constructor.spec.ts` exists to prevent.
import {
    GitFacadeService,
    GitProviderNotFoundError,
    NoGitCredentialsError,
    NoGitProviderError,
} from '../facades/git.facade';
import { DeployFacadeService } from '../facades/deploy.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { pluginLoadFailure } from '../plugins/services/plugin-operation.util';
import {
    parseRepositoryWorkSource,
    type RepositoryWorkSource,
} from '../works/repository-work-source';
import { WorkRepository } from '../database/repositories/work.repository';
import { ProviderCallBudget } from './app-upstream-sync.service';
import { APP_SOURCE_CATALOG_PORT, type AppSourceCatalogPort } from './app-source-catalog.port';
import {
    APP_WORKS_TELEMETRY_EVENTS,
    AppWorksTelemetryService,
} from './app-works-telemetry.service';

/**
 * APW-01 T12 — the App source inspector: everything the create form (and the
 * create path itself) learns about a pasted repository URL **before** anything is
 * written.
 *
 * Spec: `docs/specs/features/app-works/APW-01-app-work-kind/spec.md` FR-5…FR-10,
 * FR-12, FR-17, FR-18, FR-33, FR-34, FR-55, FR-56, FR-8.
 * Plan: `…/plan.md` §2.2 (`plan.md:165-194` — the inspect flow and its binding
 * call budget) and §4.1 (`plan.md:465-490` — the route's answers).
 * Contracts: `@ever-works/contracts` `apps/app-source.ts`. Every response field,
 * every reason code and every numeric limit is **imported** from there and never
 * restated, so the preview and the create path cannot drift.
 *
 * ## The rules this file exists to keep
 *
 * 1. **The instance setting is checked FIRST** (`config.everWorks.apps.worksEnabled()`,
 *    Resolution R-6). Checking it here — rather than in the web app, chat, the MCP
 *    server or the CLI — is what refuses every client alike. It runs before the
 *    parser and before any provider call.
 * 2. **Inspect writes nothing** (FR-5, ACC-01-06): no repository, no row, no
 *    Activity entry, no file. Every provider call below is a READ, and the only
 *    two collaborators it touches are repositories it reads through.
 * 3. **Provider-side refusals answer 200 with a reason** (plan §4.1): a 404, an
 *    SSO wall, a restricted OAuth app, a rate limit or an empty repository is
 *    something the preview has to *render*, not an error of ours. Only our own
 *    validation — the flag, the URL, a provider mismatch — is a 4xx.
 * 4. **The 15-call budget is real** (FR-7, FR-9). {@link ProviderCallBudget}
 *    charges one unit per actual provider call; the fixed checks come first and are
 *    bounded; a new owner is started only while
 *    {@link APP_INSPECT_OWNER_MIN_CALLS_REMAINING} calls remain, because APW-02's
 *    `findExistingFork` is a three-call operation in its worst case. An owner the
 *    budget did not reach keeps its computed `available`, reports
 *    `existingForkChecked: false` and carries **no** reason code — never
 *    `rate_limited`, never `unavailable` — and the response sets
 *    `scanIncomplete: true` (FR-9, ACC-01-26).
 * 5. **No mode is ever `available: true` beside a reason code**, and **no
 *    non-`none` deploy target is ever `available: true` without the `providerId`
 *    the create request will persist** (FR-33, FR-34).
 *
 * ## Why the budget is a counter and not a call log
 *
 * `plan.md:187-194` fixes both the total (15) and the fixed prefix (5) so the fork
 * scan always has room. A scan that "starts one more owner" without re-checking
 * the remainder can overshoot by the three calls that owner may cost, which is
 * exactly the failure the budget exists to prevent. The counter is incremented
 * **before** each call is awaited — a call that threw, timed out or was refused
 * still happened — and the scan asks {@link canStartTargetOwnerScan} before every
 * new owner.
 */

/** What `inspect` was asked for: the route's body, plus the two extras create passes. */
export interface AppSourceInspectOptions {
    /**
     * Bypass the 60 s in-memory cache. The create path always passes `true`
     * (plan §4.2 step 6): a create decides on today's provider answer, never on a
     * preview the member may have triggered a minute ago.
     */
    fresh?: boolean;
    /** The account the member chose. When given it is validated case-insensitively. */
    targetOwner?: string;
    /**
     * The mode the member chose — accepted for the create path's fixed call shape
     * (plan §4.2 step 6) and deliberately **not** branched on: the `modes` map is
     * the single authority, so no caller can make inspect agree with a mode by
     * asking for it.
     */
    mode?: AppRepositoryMode;
    /** A catalog id the member picked, so the preview shows exactly that entry. */
    blueprintId?: string;
    /** The provider the caller selected; a mismatch with the URL's host is a 400. */
    gitProvider?: string;
}

/** One deployment plugin, reduced to the four facts the deploy-target resolver needs. */
export interface AppDeployProviderFact {
    id: string;
    /** The registry's own "loaded **and** enabled for this user" answer. */
    enabled: boolean;
    /** `isAppDeploymentPlugin` — `supportsApps === true` **with** a real `deployApp`. */
    supportsApps: boolean;
    /** Declares the `apps-tier` capability (APW-10's managed tier). */
    appsTier: boolean;
}

/** The error body every refusal of this epic answers with (plan §4.2, openapi `AppSourceError`). */
export interface AppSourceErrorBody {
    status: 'error';
    code: AppSourceReasonCode;
    message: string;
    details?: {
        owner?: string;
        fullName?: string;
        workId?: string;
        workName?: string;
        retryAfter?: string;
    };
}

/**
 * A provider-call budget: `calls` counts **actual** provider calls, and the only
 * way to make one is {@link ProviderCallBudget.call}, which increments before the
 * call is awaited.
 *
 * The class is **FR-49's**, declared by `AppUpstreamSyncService`
 * (`app-upstream-sync.service.ts`) for a sync run, and reused here with FR-7's
 * ceiling instead of a second copy of the same arithmetic: "a call that threw still
 * happened" is the same rule in both places, and a second implementation would be
 * one more place to get it wrong. APW-01 T12 adds only `callsRemaining`, which is
 * what {@link canStartTargetOwnerScan} reads.
 */

/* -------------------------------------------------------------------------- *
 * Pure helpers — shared with the create path (T13), so one rule has one home
 * -------------------------------------------------------------------------- */

/**
 * The upstream an App Work follows, derived from an inspected repository
 * (plan §2.2's "own-fork paste (parent becomes upstream)").
 *
 * The pasted repository is only the *starting point*: when it is itself a fork,
 * the upstream is the **fork network's root** (`source`), falling back to the
 * immediate parent (`parent`) and finally to the pasted coordinates. That is the
 * rule APW-02's `findExistingFork` is built on — "a fork of a fork has
 * `source.fullName` = the upstream everyone shares, while `parent` is only the
 * immediate ancestor" (`git-provider.interface.ts`, "Repository facts") — and the
 * one that makes an own-fork paste fork into the network the member expects
 * instead of creating a fork-of-a-fork nobody can find again.
 *
 * `null` for a repository that is not a fork: there is nothing upstream of it, and
 * presenting the pasted coordinates as an "upstream" is what would make a `link`
 * look like a `fork` on the state row (APW-02 §3.1: the upstream columns are NULL
 * for a link).
 */
export function resolveAppUpstreamRef(
    repository: Pick<
        AppSourceInspectResponse['repository'],
        'owner' | 'repo' | 'defaultBranch' | 'isFork' | 'parent' | 'source'
    >,
): AppUpstreamRef | null {
    if (repository.isFork !== true) {
        return null;
    }
    const root = repository.source ?? repository.parent;
    if (root && root.includes('/')) {
        const [owner, ...rest] = root.split('/');
        const repo = rest.join('/');
        if (owner && repo) {
            return { owner, repo, defaultBranch: repository.defaultBranch };
        }
    }
    // A provider that reports `isFork` without `source` or `parent`: the pasted
    // coordinates are the only ones we can prove, and they are the fork.
    return {
        owner: repository.owner,
        repo: repository.repo,
        defaultBranch: repository.defaultBranch,
    };
}

/**
 * The `apps-tier` capability APW-10's plugin declares **in addition to**
 * `deployment`. It is not in `PLUGIN_CAPABILITIES` — that enum is the SDK's closed
 * list and this capability is APW-10's own declaration — so it is named once here,
 * with the same spelling `AppRuntimeFacadeService.APP_TIER_CAPABILITY` fixes.
 */
export const APP_TIER_CAPABILITY = 'apps-tier' as const;

/** The deploy target the managed choice resolves to (R-12). */
export const APP_MANAGED_TARGET_CHOICE: AppDeployTargetChoice = 'ever-works-apps';

/**
 * The pre-existing platform id that must **never** be persisted for an App Work
 * (plan §7, §3.1): it is the platform's own website managed hosting, its quota
 * counts it, and the deploy facade maps it to the shared cluster. It is accepted
 * on the create request only as an input **alias** for the managed target.
 */
export const APP_MANAGED_TARGET_INPUT_ALIAS = 'ever-works';

/**
 * Which provider ids can serve each non-`none` target, decided once
 * (`plan.md:512-522` step 4, `plan.md:1453-1455` R-5):
 *
 *   - **your-cluster** — an enabled deployment plugin that advertises App support
 *     (`supportsApps`) and does **not** declare `apps-tier`. The tier's plugin
 *     serves the managed target and nothing else.
 *   - **ever-works-apps** — the enabled `apps-tier` plugin, and only while
 *     `AppsTierPolicy.isOpen()`. An unbound policy means CLOSED (R-5): the
 *     environment variable behind the tier's ceiling is APW-10's alone and is never
 *     read here.
 *
 * A non-`none` target carries its `providerId` **only** when it is available, so
 * the invariant "available without a providerId" is unrepresentable rather than
 * merely tested for.
 */
export function resolveAppDeployTargets(
    providers: readonly AppDeployProviderFact[],
    tierOpen: boolean,
): Record<AppDeployTargetChoice, AppDeployTargetAvailability> {
    const usable = providers.filter((provider) => provider.enabled && provider.supportsApps);
    const cluster = usable.find((provider) => !provider.appsTier);
    const managed = tierOpen ? usable.find((provider) => provider.appsTier) : undefined;

    return {
        none: { available: true },
        'your-cluster': cluster
            ? { available: true, providerId: cluster.id }
            : { available: false, reason: 'cluster_target_unavailable' },
        'ever-works-apps': managed
            ? { available: true, providerId: managed.id }
            : { available: false, reason: 'managed_hosting_unavailable' },
    };
}

/**
 * Read the deployment plugins the member can actually use, reduced to the four
 * facts {@link resolveAppDeployTargets} needs.
 *
 * The registry is the only collaborator that knows a plugin's **true** shape: a
 * lazily registered plugin is a proxy that answers a forwarding function for every
 * property it does not define, so `isAppDeploymentPlugin` against the stub would
 * tell us about the proxy rather than about the plugin. That is why the entry is
 * materialised before it is judged — exactly as
 * `AppRuntimeFacadeService.resolveTierPlugin` does for the same question.
 *
 * ## Fail-closed, and why "no registry" is not "no plugins"
 *
 * An installation with no registry bound cannot prove that any plugin advertises
 * App support, so it reports no apps-capable provider and both non-`none` targets
 * come back unavailable with their reason code. That is the honest answer: offering
 * "Your cluster" on a promise nobody can keep is worse than offering nothing, and
 * the member is told which capability is missing.
 *
 * `DeployFacadeService` is asked too — plan §4.2 step 4 names it, and it is what
 * carries the user-scoped credential state — but only as a **confirmation** of the
 * registry's list: a provider the facade does not list for this member is dropped.
 * When the facade is unbound or throws (it is `@Optional()`, and a registry can be
 * present without it) the registry's own `isPluginEnabledForScope` answer stands,
 * because dropping every provider on a facade hiccup would silently disable a
 * target the member can really use.
 */
export async function collectAppDeployProviderFacts(
    deps: {
        registry?: PluginRegistryService;
        deployFacade?: DeployFacadeService;
        logger?: Logger;
    },
    userId: string,
): Promise<AppDeployProviderFact[]> {
    const registry = deps.registry;
    if (!registry) {
        return [];
    }

    let registered: RegisteredPlugin[] = [];
    try {
        // No `workId`: at inspect time the Work does not exist yet, so the
        // user-scoped half of `resolvePluginEnabled` is the whole question.
        registered = await registry.getEnabledPluginsScoped(
            PLUGIN_CAPABILITIES.DEPLOYMENT,
            undefined,
            userId,
        );
    } catch (error) {
        deps.logger?.warn(
            `App source inspect: the plugin registry could not list deployment plugins (${errorText(error)}).`,
        );
        return [];
    }

    const facts: AppDeployProviderFact[] = [];
    for (const entry of registered) {
        if (entry.state !== 'loaded') {
            continue;
        }
        const plugin = await materialiseDeploymentPlugin(entry, deps.logger);
        if (!plugin || !isAppDeploymentPlugin(plugin)) {
            continue;
        }
        facts.push({
            id: entry.plugin.id,
            enabled: true,
            supportsApps: true,
            appsTier: declaresCapability(entry, plugin, APP_TIER_CAPABILITY),
        });
    }

    if (!facts.length || !deps.deployFacade) {
        return facts;
    }

    try {
        const available = await deps.deployFacade.getAvailableProvidersForUser(userId);
        const listed = new Set(available.map((provider) => provider.id));
        return facts.filter((fact) => listed.has(fact.id));
    } catch (error) {
        deps.logger?.warn(
            `App source inspect: the deploy facade could not list providers for this member ` +
                `(${errorText(error)}); the registry answer stands.`,
        );
        return facts;
    }
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

interface CachedInspection {
    response: AppSourceInspectResponse;
    expiresAt: number;
}

/** A hard ceiling on cached inspections, so a singleton cannot grow without bound. */
const CACHE_MAX_ENTRIES = 500;

@Injectable()
export class AppSourceInspectorService {
    private readonly logger = new Logger(AppSourceInspectorService.name);

    /**
     * The 60 s in-memory cache (plan §2.2, `spec.md:291`), keyed
     * `userId + lower(owner/repo)` exactly as the plan fixes it.
     *
     * It is deliberately **per process and not shared**: the preview is a read, the
     * create path always bypasses it (`fresh: true`), and a distributed cache would
     * be a second source of truth for an answer whose whole purpose is to be
     * current.
     */
    private readonly cache = new Map<string, CachedInspection>();

    constructor(
        // `@Optional()` on the two cross-module collaborators as well, and for the
        // reason `AppUpstreamStateService` records for its own: a graph that does
        // not import `DatabaseModule` / `FacadesModule` must still COMPILE this
        // module (that is what `__tests__/app-works.module.spec.ts` pins), and an
        // absent collaborator must degrade to a named refusal rather than to
        // `undefined.something`. They are still **value** imports — a type-only
        // import would emit `Object` as the injection token and Nest would inject
        // `undefined` even on the real graph — and `AppWorksModule` imports both
        // modules, so on every real installation they are present.
        @Optional()
        private readonly gitFacade: GitFacadeService,
        @Optional()
        private readonly workRepository: WorkRepository,
        // Everything below is `@Optional()`: an installation that has not bound it
        // gets a NAMED reason code rather than a guessed answer.
        @Optional()
        @Inject(APP_SOURCE_CATALOG_PORT)
        private readonly catalog?: AppSourceCatalogPort,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tierPolicy?: AppsTierPolicy,
        @Optional()
        private readonly registry?: PluginRegistryService,
        @Optional()
        private readonly deployFacade?: DeployFacadeService,
        // APW-01 T36 — appended LAST so every positional construction keeps its
        // slots. Absent, no event is emitted; the service's own sink being unbound is
        // the usual way that happens, and it is the service that counts it.
        @Optional()
        private readonly telemetry?: AppWorksTelemetryService,
    ) {}

    /**
     * Everything the preview — and the create path's step 6 — learns about
     * `repositoryUrl`.
     *
     * Throws only for OUR validation: the instance setting, an unparseable URL, a
     * provider mismatch. Every provider-side refusal is a `200` carrying the reason
     * codes on the modes (plan §4.1).
     *
     * Every answer — built, refused by the provider or served from the cache — emits
     * one `app_source.inspected` (FR-53, plan §9.1) with codes and counters only; a
     * throw emits nothing, because nothing was inspected.
     */
    async inspect(
        repositoryUrl: string,
        user: User,
        opts: AppSourceInspectOptions = {},
    ): Promise<AppSourceInspectResponse> {
        const startedAt = Date.now();
        const answer = await this.inspectUnobserved(repositoryUrl, user, opts);
        this.trackInspected(answer.response, answer.providerCalls, startedAt, user);
        return answer.response;
    }

    /** `inspect`'s body, answering the provider calls it made beside the response. */
    private async inspectUnobserved(
        repositoryUrl: string,
        user: User,
        opts: AppSourceInspectOptions,
    ): Promise<{ response: AppSourceInspectResponse; providerCalls: number }> {
        // 1. The instance setting, before the parser and before any provider call
        //    (R-6: it refuses the web app, chat, the MCP server and the CLI alike).
        if (!config.everWorks.apps.worksEnabled()) {
            throw new BadRequestException({
                status: 'error',
                code: 'app_works_disabled',
                message: 'Creating App Works is turned off on this installation.',
            } satisfies AppSourceErrorBody);
        }

        // 2. The URL — the same parser the Repository Work create path uses, so a
        //    URL that parses for one kind parses for the other.
        const source = parseRepositoryWorkSource(repositoryUrl);
        if (!source) {
            throw new BadRequestException({
                status: 'error',
                code: 'invalid_url',
                message:
                    'A repository URL is required — an existing https://github.com/<owner>/<repo> your ' +
                    'connected GitHub account can reach (only GitHub is supported today).',
            } satisfies AppSourceErrorBody);
        }

        if (opts.gitProvider && opts.gitProvider !== source.gitProvider) {
            throw new BadRequestException({
                status: 'error',
                code: 'invalid_url',
                message:
                    `Repository ${source.url} is hosted on ${source.gitProvider}, but the request selected ` +
                    `the "${opts.gitProvider}" git provider. Select the provider that hosts the repository.`,
            } satisfies AppSourceErrorBody);
        }

        // The git facade is `@Optional()` so a graph without `FacadesModule`
        // compiles; an inspection that cannot reach a provider is a NAMED refusal
        // rather than a crash on `undefined.getRepository`.
        if (!this.gitFacade) {
            throw new ServiceUnavailableException({
                status: 'error',
                code: 'provider_not_connected',
                message:
                    'No Git provider is available in this installation, so repositories cannot be read.',
            } satisfies AppSourceErrorBody);
        }

        // 3. The cache. `fresh` bypasses it (the create path), and so does an
        //    explicit catalog pick: "which Blueprint applies" is a different
        //    question from "what is this repository", and the plan's key
        //    (`userId + lower(owner/repo)`) does not carry the id.
        const cacheKey = `${user.id}:${source.owner.toLowerCase()}/${source.repo.toLowerCase()}`;
        if (!opts.fresh && !opts.blueprintId) {
            const cached = this.cache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                return {
                    response: applyTargetOwner(cached.response, opts.targetOwner),
                    providerCalls: 0,
                };
            }
            if (cached) {
                this.cache.delete(cacheKey);
            }
        }

        const budget = new ProviderCallBudget(APP_INSPECT_MAX_PROVIDER_CALLS);
        const response = await this.build(source, user, opts, budget);

        if (!opts.blueprintId) {
            this.remember(cacheKey, response);
        }

        return {
            response: applyTargetOwner(response, opts.targetOwner),
            providerCalls: budget.calls,
        };
    }

    /**
     * `app_source.inspected` (plan §9.1): which modes were offered, why the others
     * were not, the Blueprint status, the licence class, the time and the provider
     * calls. Never the repository, its owner, its URL or its description.
     */
    private trackInspected(
        response: AppSourceInspectResponse,
        providerCalls: number,
        startedAt: number,
        user: User,
    ): void {
        const modes = Object.entries(response.modes ?? {}) as Array<
            [AppRepositoryMode, AppModeAvailability]
        >;
        this.telemetry?.track(
            APP_WORKS_TELEMETRY_EVENTS.sourceInspected,
            {
                defaultMode: response.defaultMode ?? null,
                modesAvailable: modes
                    .filter(([, availability]) => availability?.available === true)
                    .map(([mode]) => mode),
                reasons: [
                    ...new Set(
                        modes
                            .map(([, availability]) => availability?.reason)
                            .filter((reason): reason is AppSourceReasonCode => !!reason),
                    ),
                ].sort(),
                blueprint: response.blueprint?.status ?? 'unavailable',
                licenseClass: response.license?.class ?? 'unknown',
                durationMs: Date.now() - startedAt,
                providerCalls,
            },
            user?.id,
        );
    }

    /* ---------------------------------------------------------------------- *
     * The build
     * ---------------------------------------------------------------------- */

    private async build(
        source: RepositoryWorkSource,
        user: User,
        opts: AppSourceInspectOptions,
        budget: ProviderCallBudget,
    ): Promise<AppSourceInspectResponse> {
        const gitOptions = { userId: user.id, providerId: source.gitProvider };

        // Fixed check 1 — the repository read. Everything else depends on it, so
        // its failure classes answer the whole response.
        let repository: GitRepositoryWithPermissions | null;
        try {
            repository = await budget.call(() =>
                this.gitFacade.getRepository(source.owner, source.repo, gitOptions),
            );
        } catch (error) {
            return this.unavailableResponse(
                source,
                classifyProviderFailure(error),
                retryAfterOf(error),
            );
        }
        if (!repository) {
            return this.unavailableResponse(source, 'not_found');
        }

        const canonical = canonicalCoordinates(repository, source);
        const defaultBranch = firstNonEmpty(repository.defaultBranch) ?? 'main';

        // Fixed check 2 — at most one default-branch read, and only when the
        // provider reported a zero-size repository without saying whether it is
        // empty. `getLatestCommit` answering `null` is what "empty" means.
        let empty = repository.empty === true;
        if (repository.empty === undefined && repository.sizeKb === 0) {
            try {
                const head = await budget.call(() =>
                    this.gitFacade.getLatestCommit(
                        canonical.owner,
                        canonical.repo,
                        defaultBranch,
                        gitOptions,
                    ),
                );
                empty = head === null;
            } catch (error) {
                return this.unavailableResponse(
                    source,
                    classifyProviderFailure(error),
                    retryAfterOf(error),
                );
            }
        }

        // These three fixed checks and the `.gitattributes` probe below can also
        // end the whole inspect: a rate limit is not an answer about one
        // repository, it is "the platform cannot look right now" (plan §4.1).
        let login: string | null = null;
        let organizations: GitOrganization[] = [];
        let usesLfs = false;
        try {
            // Fixed check 3 — the caller's own account.
            const gitUser = await budget.call(() => this.gitFacade.getUser(gitOptions));
            login = firstNonEmpty(gitUser?.login);

            // Fixed check 4 — the organizations the caller can fork into.
            organizations = ((await budget.call(() =>
                this.gitFacade.getOrganizations(gitOptions),
            )) ?? []) as GitOrganization[];

            // Fixed check 5 — the `.gitattributes` LFS probe. Skipped for an empty
            // repository: with no default branch there is no file to read, and
            // spending the call would buy nothing.
            usesLfs = empty
                ? false
                : await this.probeLfs(canonical, defaultBranch, gitOptions, budget);
        } catch (error) {
            return this.unavailableResponse(
                source,
                classifyProviderFailure(error),
                retryAfterOf(error),
            );
        }

        // The upstream, and with it the coordinates the fork scan and the conflict
        // lookups run on: a pasted fork is scanned at the network root, never at the
        // fork itself.
        const upstream = resolveAppUpstreamRef({
            owner: canonical.owner,
            repo: canonical.repo,
            defaultBranch,
            isFork: repository.isFork === true,
            parent: repository.parent
                ? `${repository.parent.owner}/${repository.parent.name}`
                : undefined,
            source: repository.source
                ? `${repository.source.owner}/${repository.source.name}`
                : undefined,
        });
        const scanTarget = upstream ?? {
            owner: canonical.owner,
            repo: canonical.repo,
            defaultBranch,
        };

        // The conflict lookups. These are DATABASE reads, not provider calls, so
        // they sit outside the budget — and they expose another account's usage as
        // a BOOLEAN only (FR-26, FR-51: never the other account's identity).
        const inUseByAnotherAccount = await this.isInUseByAnotherAccount(
            scanTarget.owner,
            scanTarget.repo,
            user.id,
        );
        const existingAppWork = await this.findOwnAppWork(
            user.id,
            scanTarget.owner,
            scanTarget.repo,
        );

        // The fork scan: the caller first, then the organizations A–Z (FR-9).
        const owners = buildTargetOwnerOrder(login, organizations);
        let targetOwners: AppTargetOwner[];
        try {
            targetOwners = await this.scanOwners(owners, scanTarget, gitOptions, user.id, budget);
        } catch (error) {
            return this.unavailableResponse(
                source,
                classifyProviderFailure(error),
                retryAfterOf(error),
            );
        }

        const scanIncomplete =
            targetOwners.length < owners.length ||
            targetOwners.some((owner) => !owner.existingForkChecked);

        const facts = this.modeFacts(
            repository,
            canonical,
            login,
            opts.targetOwner,
            empty,
            usesLfs,
            inUseByAnotherAccount,
        );
        const { modes, defaultMode } = resolveAppRepositoryModes(facts);

        const catalog = await this.readCatalog(scanTarget, repository, opts.blueprintId);
        const deployTargets = resolveAppDeployTargets(
            await collectAppDeployProviderFacts(
                { registry: this.registry, deployFacade: this.deployFacade, logger: this.logger },
                user.id,
            ),
            this.tierPolicy?.isOpen() === true,
        );

        return {
            repository: {
                owner: canonical.owner,
                repo: canonical.repo,
                fullName: `${canonical.owner}/${canonical.repo}`,
                url: repository.url || `https://github.com/${canonical.owner}/${canonical.repo}`,
                description: repository.description,
                defaultBranch,
                stars: typeof repository.stars === 'number' ? repository.stars : 0,
                sizeKb: typeof repository.sizeKb === 'number' ? repository.sizeKb : 0,
                visibility: visibilityOf(repository),
                archived: repository.archived === true,
                empty,
                isFork: repository.isFork === true,
                parent: repository.parent
                    ? `${repository.parent.owner}/${repository.parent.name}`
                    : undefined,
                source: repository.source
                    ? `${repository.source.owner}/${repository.source.name}`
                    : undefined,
                allowForking: repository.allowForking !== false,
                movedFrom: repository.movedFrom,
                usesLfs,
            },
            access: {
                canPush: repository.permissions?.push === true,
                canAdmin: repository.permissions?.admin === true,
            },
            modes,
            defaultMode,
            targetOwners,
            blueprint: catalog.blueprint,
            license: catalog.license,
            existingAppWork,
            scanIncomplete,
            deployTargets,
        };
    }

    /**
     * The facts `resolveAppRepositoryModes` reads (FR-17, FR-18), taken from the
     * provider read and the two conflict lookups.
     *
     * `allowForking` is `undefined`-tolerant on purpose: the plugin contract says an
     * absent value is "the provider did not report it, never `false`", while
     * `resolveAppRepositoryModes` reads a falsy value as `forking_disabled`.
     * Reporting "not reported" as "forks are disabled" would refuse a fork the
     * provider allows, so the flag is only `false` when it was **reported** false.
     */
    private modeFacts(
        repository: GitRepositoryWithPermissions,
        canonical: { owner: string; repo: string },
        login: string | null,
        requestedOwner: string | undefined,
        empty: boolean,
        usesLfs: boolean,
        inUseByAnotherAccount: boolean,
    ): AppRepositoryModeFacts {
        return {
            canPush: repository.permissions?.push === true,
            archived: repository.archived === true,
            empty,
            allowForking: repository.allowForking !== false,
            usesLfs,
            sizeKb: typeof repository.sizeKb === 'number' ? repository.sizeKb : null,
            visibility: visibilityOf(repository),
            isFork: repository.isFork === true,
            isOwnRepository:
                sameLogin(canonical.owner, requestedOwner) || sameLogin(canonical.owner, login),
            isInUseByAnotherAccount: inUseByAnotherAccount,
        };
    }

    /**
     * The `.gitattributes` `filter=lfs` probe (FR-20, the private-copy refusal).
     *
     * The file is read from the default branch. A missing file, or a provider that
     * cannot read one, is an answer rather than an error: it has not told us the
     * repository uses LFS, which is exactly what `false` means here. A **rate
     * limit** is the one failure that is not an answer — it propagates so the whole
     * inspect is refused, because the platform would otherwise offer a private copy
     * it never finished checking.
     */
    private async probeLfs(
        canonical: { owner: string; repo: string },
        defaultBranch: string,
        gitOptions: { userId: string; providerId: string },
        budget: ProviderCallBudget,
    ): Promise<boolean> {
        let file: { content: string; encoding: string } | null;
        try {
            file = await budget.call(() =>
                this.gitFacade.getFileContent(
                    canonical.owner,
                    canonical.repo,
                    '.gitattributes',
                    gitOptions,
                    defaultBranch,
                ),
            );
        } catch (error) {
            if (isRateLimited(error)) {
                throw error;
            }
            return false;
        }
        if (!file?.content) {
            return false;
        }
        const content =
            file.encoding === 'base64' ? safeBase64Decode(file.content) : String(file.content);
        return /filter\s*=\s*lfs/i.test(content);
    }

    /**
     * Walk the offered owners in order, charging each `findExistingFork` to the
     * budget and stopping as soon as one more owner would not fit.
     *
     * Three outcomes per owner, and the difference between them is the whole point
     * of ACC-01-26:
     *
     *   - **reached, no fork** — `existingForkChecked: true`, no `existingFork`.
     *   - **reached, fork found** — `existingForkChecked: true` plus the fork.
     *   - **not reached** (budget) or **the check itself failed** — the owner keeps
     *     its computed `available`, reports `existingForkChecked: false` and carries
     *     **no** reason code; the response is `scanIncomplete`. "We did not look" is
     *     never rendered as "there is no fork".
     *
     * A rate limit aborts the whole scan (it is a fact about the credential, not
     * about one owner) and is rethrown to {@link build}, which answers the plan
     * §4.1 rate-limit row.
     */
    private async scanOwners(
        owners: ReadonlyArray<{ login: string; type: 'user' | 'organization' }>,
        upstream: { owner: string; repo: string },
        gitOptions: { userId: string; providerId: string },
        userId: string,
        budget: ProviderCallBudget,
    ): Promise<AppTargetOwner[]> {
        const result: AppTargetOwner[] = [];
        let reachedAll = true;

        for (const owner of owners) {
            if (!canStartTargetOwnerScan(budget.callsRemaining)) {
                reachedAll = false;
                result.push({
                    login: owner.login,
                    type: owner.type,
                    available: true,
                    existingForkChecked: false,
                });
                continue;
            }

            let fork: GitRepository | null = null;
            try {
                fork = await budget.call(() =>
                    this.gitFacade.findExistingFork(
                        upstream.owner,
                        upstream.repo,
                        owner.login,
                        gitOptions,
                    ),
                );
            } catch (error) {
                if (isRateLimited(error)) {
                    throw error;
                }
                reachedAll = false;
                result.push({
                    login: owner.login,
                    type: owner.type,
                    available: true,
                    existingForkChecked: false,
                });
                continue;
            }

            if (!fork) {
                result.push({
                    login: owner.login,
                    type: owner.type,
                    available: true,
                    existingForkChecked: true,
                });
                continue;
            }

            const forkOwner = firstNonEmpty(fork.owner) ?? owner.login;
            const forkRepo = firstNonEmpty(fork.name) ?? upstream.repo;

            result.push({
                login: owner.login,
                type: owner.type,
                available: true,
                existingForkChecked: true,
                existingFork: {
                    owner: forkOwner,
                    repo: forkRepo,
                    fullName: fork.fullName || `${forkOwner}/${forkRepo}`,
                    url: fork.url || `https://github.com/${forkOwner}/${forkRepo}`,
                    inUseByAnotherAccount: await this.isInUseByAnotherAccount(
                        forkOwner,
                        forkRepo,
                        userId,
                    ),
                },
            });
        }

        if (!reachedAll) {
            this.logger.log('App source inspect: the fork scan did not reach every offered owner.');
        }
        return result;
    }

    /** Whether another Ever Works account already uses this repository (FR-26) — a boolean, nothing else. */
    private async isInUseByAnotherAccount(
        owner: string,
        repo: string,
        userId: string,
    ): Promise<boolean> {
        if (!owner || !repo || !this.workRepository) {
            // No Works table ⇒ no evidence that ANY account uses this repository.
            // The conflict check protects the OTHER account's working copy, so
            // "we cannot look" must not be reported as "somebody else has it".
            return false;
        }
        const rows = await this.workRepository.findWorksUsingRepository(owner, repo, {
            kinds: ['repo', 'app'],
        });
        return rows.some((row) => row.userId !== userId);
    }

    /** The caller's own existing App Work on this repository — never another account's (FR-23, FR-51). */
    private async findOwnAppWork(
        userId: string,
        owner: string,
        repo: string,
    ): Promise<{ id: string; name: string; slug: string } | undefined> {
        if (!owner || !repo || !this.workRepository) {
            return undefined;
        }
        const works = await this.workRepository.findAppWorksByDataRepository(userId, owner, repo);
        const work = works[0];
        return work ? { id: work.id, name: work.name, slug: work.slug } : undefined;
    }

    /**
     * The Blueprint and license previews (FR-8, FR-55, FR-56; plan §7).
     *
     * `APP_SOURCE_CATALOG_PORT` is `@Optional()` and the two calls are wrapped
     * separately, so a catalog that is unbound — or that throws — answers
     * `blueprint.status = 'unavailable'` and `license.class = 'unknown'`: a real
     * answer, never a guessed class and never a refused create.
     *
     * The license class is the matched entry's when a Blueprint matched
     * (`source: 'blueprint'`), and `classifyLicense` on the provider-detected SPDX
     * otherwise (`source: 'detected'`). It is matched on the **upstream**
     * coordinates, so a fork of a catalogued project previews that project's
     * Blueprint (D4's resolution order includes the fork-network root).
     */
    private async readCatalog(
        coordinates: { owner: string; repo: string },
        repository: GitRepository,
        blueprintId: string | undefined,
    ): Promise<{ blueprint: AppBlueprintPreview; license: AppSourceLicensePreview }> {
        // The plugin contract's `null` is GitHub's NOASSERTION ("a licence file it cannot
        // name") and `undefined` is "no licence file": the first is carried as
        // `NOASSERTION`, which classifies red (owner decision 2026-09-25, ACC-NEG-01).
        const spdx = detectedLicenseSpdx(repository.licenseSpdx);

        if (!this.catalog) {
            return {
                blueprint: { status: 'unavailable' },
                license: { spdx, class: 'unknown', source: 'detected' },
            };
        }

        let match: Awaited<ReturnType<AppSourceCatalogPort['matchBlueprint']>> = null;
        try {
            match = await this.catalog.matchBlueprint({
                owner: coordinates.owner,
                repo: coordinates.repo,
                ...(blueprintId ? { blueprintId } : {}),
            });
        } catch (error) {
            this.logger.warn(
                `App source inspect: the Apps catalog could not resolve a Blueprint (${errorText(error)}).`,
            );
            return {
                blueprint: { status: 'unavailable' },
                license: { spdx, class: 'unknown', source: 'detected' },
            };
        }

        if (!match) {
            return {
                blueprint: { status: 'none' },
                license: { spdx, class: await this.classify(spdx), source: 'detected' },
            };
        }

        return {
            blueprint: {
                status: 'matched',
                id: match.id,
                version: match.version,
                verified: match.verified,
                // The display name is what the preview renders; `name` is the
                // fallback, so a catalog entry without one still has a label.
                name: firstNonEmpty(match.displayName) ?? firstNonEmpty(match.name) ?? undefined,
                matchSource: normaliseMatchSource(match.matchSource),
                prompts: match.prompts,
            },
            license: {
                spdx,
                class: match.licenseClass ?? 'unknown',
                source: 'blueprint',
            },
        };
    }

    /** `classifyLicense`, fail-closed to `unknown` — never a guessed class (R-3). */
    private async classify(spdx: string | null): Promise<AppSourceLicensePreview['class']> {
        if (!this.catalog) {
            return 'unknown';
        }
        try {
            return await this.catalog.classifyLicense(spdx);
        } catch (error) {
            this.logger.warn(
                `App source inspect: the license could not be classified (${errorText(error)}).`,
            );
            return 'unknown';
        }
    }

    /**
     * The shape a provider-side refusal answers with: every mode unavailable with
     * the SAME reason (plan §4.1's rows), plus `retryAfter` when the provider named
     * one.
     *
     * The repository block is what the parser knows — the coordinates the member
     * pasted, canonicalised — because there is nothing else to report and a preview
     * that renders "we could not read this repository" must still be able to name
     * it. `scanIncomplete` is `true`: nothing was scanned, and a refusal must never
     * claim a completed scan.
     */
    private unavailableResponse(
        source: RepositoryWorkSource,
        reason: AppSourceReasonCode,
        retryAfter?: string,
    ): AppSourceInspectResponse {
        const modes: Record<AppRepositoryMode, AppModeAvailability> = {
            link: { available: false, reason },
            fork: { available: false, reason },
            'private-copy': { available: false, reason },
        };

        return {
            repository: {
                owner: source.owner,
                repo: source.repo,
                fullName: `${source.owner}/${source.repo}`,
                url: source.url,
                defaultBranch: 'main',
                stars: 0,
                sizeKb: 0,
                visibility: 'public',
                archived: false,
                empty: false,
                isFork: false,
                allowForking: true,
                usesLfs: false,
            },
            access: { canPush: false, canAdmin: false },
            modes,
            defaultMode: null,
            targetOwners: [],
            blueprint: { status: 'unavailable' },
            license: { spdx: null, class: 'unknown', source: 'detected' },
            deployTargets: {
                none: { available: true },
                'your-cluster': { available: false, reason: 'cluster_target_unavailable' },
                'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
            },
            scanIncomplete: true,
            ...(retryAfter ? { retryAfter } : {}),
        };
    }

    /** Store one inspection, dropping what has expired first and keeping the map bounded. */
    private remember(key: string, response: AppSourceInspectResponse): void {
        const now = Date.now();
        for (const [existingKey, entry] of this.cache) {
            if (entry.expiresAt <= now) {
                this.cache.delete(existingKey);
            }
        }
        while (this.cache.size >= CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next();
            if (oldest.done) {
                break;
            }
            this.cache.delete(oldest.value);
        }
        this.cache.set(key, { response, expiresAt: now + APP_INSPECT_CACHE_TTL_MS });
    }
}

/* -------------------------------------------------------------------------- *
 * Module-private helpers
 * -------------------------------------------------------------------------- */

/**
 * Apply the member's requested owner to a built response.
 *
 * The built (and cached) response is **owner-independent**: it lists the owners
 * the member can fork into and the state of each one's fork check. The requested
 * owner is a question about that list — "may I use THIS one" — and the answer is
 * either an existing entry (case-insensitively the same login) or an entry that is
 * not available with `target_owner_unavailable`, which is the code the create path
 * answers `400` with (FR-13).
 *
 * Applying it here rather than inside the build is what keeps the plan's cache key
 * (`userId + lower(owner/repo)`) honest: the cached payload never depends on a
 * field that is not part of the key.
 */
function applyTargetOwner(
    response: AppSourceInspectResponse,
    requestedOwner: string | undefined,
): AppSourceInspectResponse {
    const requested = firstNonEmpty(requestedOwner);
    if (!requested) {
        return response;
    }

    if (response.targetOwners.some((owner) => sameLogin(owner.login, requested))) {
        return response;
    }

    return {
        ...response,
        targetOwners: [
            ...response.targetOwners,
            {
                login: requested,
                // The account is neither the member's own account nor one of their
                // organizations, so we cannot say which it is. `user` is the
                // conservative label: it claims nothing about the account.
                type: 'user',
                available: false,
                reason: 'target_owner_unavailable',
                existingForkChecked: false,
            },
        ],
        // The requested owner was not reached — it is not offered at all.
        scanIncomplete: true,
    };
}

/** The owner list: the caller first, then the organizations A–Z (`spec.md:300`). */
function buildTargetOwnerOrder(
    login: string | null,
    organizations: readonly GitOrganization[],
): Array<{ login: string; type: 'user' | 'organization' }> {
    const owners: Array<{ login: string; type: 'user' | 'organization' }> = [];
    const seen = new Set<string>();

    if (login) {
        owners.push({ login, type: 'user' });
        seen.add(login.toLowerCase());
    }

    const sorted = [...organizations]
        .filter((org) => typeof org?.login === 'string' && org.login.trim() !== '')
        .sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));

    for (const org of sorted.slice(0, APP_TARGET_OWNER_SCAN_LIMIT_P1)) {
        if (seen.has(org.login.toLowerCase())) {
            continue;
        }
        seen.add(org.login.toLowerCase());
        owners.push({ login: org.login, type: 'organization' });
    }

    return owners;
}

/** The coordinates every later call uses: the provider's canonical answer, or the pasted pair. */
function canonicalCoordinates(
    repository: GitRepository,
    source: RepositoryWorkSource,
): { owner: string; repo: string } {
    return {
        owner: firstNonEmpty(repository.owner) ?? source.owner,
        repo: firstNonEmpty(repository.name) ?? source.repo,
    };
}

/** The provider's visibility, with the pre-`visibility` boolean as the fallback. */
function visibilityOf(repository: GitRepository): 'public' | 'private' | 'internal' {
    if (
        repository.visibility === 'public' ||
        repository.visibility === 'private' ||
        repository.visibility === 'internal'
    ) {
        return repository.visibility;
    }
    return repository.isPrivate ? 'private' : 'public';
}

/** Case-insensitive login comparison; two absent values are NOT the same login. */
function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
    const left = firstNonEmpty(a);
    const right = firstNonEmpty(b);
    return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

/** A trimmed non-empty string, or `null`. */
function firstNonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/** A match source the contract's closed set accepts, else the least-claiming member. */
function normaliseMatchSource(value: unknown): AppSourceBlueprintMatchSource {
    return value === 'manifest' ||
        value === 'alias' ||
        value === 'fork' ||
        value === 'probe' ||
        value === 'explicit'
        ? value
        : 'manifest';
}

/** Whether a caught value is the provider's rate-limit answer (primary or secondary). */
function isRateLimited(error: unknown): boolean {
    const reason = providerErrorReason(error);
    return reason === 'rate_limited' || reason === 'secondary_rate_limited';
}

/** The typed provider reason, when the error carries one. */
function providerErrorReason(error: unknown): GitProviderErrorReason | null {
    const reason = (error as Partial<GitProviderRequestError> | null)?.reason;
    return typeof reason === 'string' ? reason : null;
}

/** The provider's own `retryAt`, when it named one. */
function retryAfterOf(error: unknown): string | undefined {
    const retryAt = (error as Partial<GitProviderRequestError> | null)?.details?.retryAt;
    return typeof retryAt === 'string' && retryAt ? retryAt : undefined;
}

/**
 * APW-02's typed provider reasons onto this epic's closed reason set (FR-12).
 *
 * Every member of the input union maps onto exactly one output code, and the two
 * directions the plan names are kept exactly: no usable connection is
 * `provider_not_connected`, and a connection missing a scope is
 * `insufficient_scope` (plan §4.1).
 *
 * `not_found` is the fallback for a `GitProviderRequestError` whose reason this
 * build does not know: the repository could not be read through the member's
 * connection, and "we cannot see it" is the answer a member can act on. It is
 * never `rate_limited` and never `app_works_disabled` — a code that names a
 * different situation is worse than a coarse one.
 */
function classifyProviderFailure(error: unknown): AppSourceReasonCode {
    if (
        error instanceof NoGitCredentialsError ||
        error instanceof GitProviderNotFoundError ||
        error instanceof NoGitProviderError
    ) {
        return 'provider_not_connected';
    }

    switch (providerErrorReason(error)) {
        case 'not_found':
            return 'not_found';
        case 'unauthorized':
            return 'provider_not_connected';
        case 'permission_missing':
            return 'insufficient_scope';
        case 'sso_authorization_required':
            return 'sso_authorization_required';
        case 'oauth_app_restricted':
            return 'oauth_app_restricted';
        case 'rate_limited':
        case 'secondary_rate_limited':
            return 'rate_limited';
        default:
            return 'not_found';
    }
}

/** A plugin capability from the materialised instance or from the manifest that registered it. */
function declaresCapability(
    registered: RegisteredPlugin | undefined,
    plugin: IDeploymentPlugin | undefined,
    capability: string,
): boolean {
    const fromInstance = Array.isArray(plugin?.capabilities) ? plugin.capabilities : [];
    const fromManifest = Array.isArray(registered?.manifest?.capabilities)
        ? registered.manifest.capabilities
        : [];
    return fromInstance.includes(capability) || fromManifest.includes(capability);
}

/**
 * The real plugin behind a possibly-lazy registry entry, or `null` when
 * materialisation failed — its import failed, or its first load left the entry
 * in `error` (an `onLoad` that fails on this first use does not reject the
 * materialise; the eager boot skipped such a plugin). A lazy proxy answers a
 * forwarding function for every property it does not define, so
 * `isAppDeploymentPlugin` against the stub would tell us about the proxy rather
 * than about the plugin.
 */
async function materialiseDeploymentPlugin(
    registered: RegisteredPlugin,
    logger?: Logger,
): Promise<IDeploymentPlugin | null> {
    const plugin = registered?.plugin as
        | (IDeploymentPlugin & { __materialize?: () => Promise<IDeploymentPlugin> })
        | undefined;
    if (!plugin) {
        return null;
    }
    if (typeof plugin.__materialize !== 'function') {
        return plugin;
    }
    let real: IDeploymentPlugin;
    try {
        real = (await plugin.__materialize()) ?? plugin;
    } catch (error) {
        logger?.warn(
            `App source inspect: plugin '${registered.plugin.id}' could not be materialised ` +
                `(${errorText(error)}).`,
        );
        return null;
    }
    const failure = pluginLoadFailure(registered, registered.plugin.id);
    if (failure) {
        logger?.warn(`App source inspect: ${failure}`);
        return null;
    }
    return real;
}

/** Base64 → utf-8, and the raw value when the provider sent something else. */
function safeBase64Decode(value: string): string {
    try {
        return Buffer.from(value, 'base64').toString('utf8');
    } catch {
        return value;
    }
}

/** An error as a short, log-safe string — never a payload, a credential or a provider URL. */
function errorText(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`.slice(0, 300);
    }
    return String(error).slice(0, 300);
}
