import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_SOURCE_REPOSITORY_TYPE_BY_MODE,
    APP_SOURCE_SPEC_FILE,
    APP_SOURCE_SPEC_KIND,
    APP_SOURCE_SPEC_VERSION,
    type AppLicenseEvaluationReason,
    type AppRepositoryMode,
    type AppSourceBlock,
    type AppSourceRecord,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import * as yaml from 'yaml';
import { APP_LICENSE_SERVICE } from '../app-runtime/app-license-gate';
import { AppSpecService } from '../app-spec/app-spec.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import type { Work } from '../entities/work.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import {
    GitFacadeService,
    GitOperationNotSupportedError,
    type GitFacadeOptions,
} from '../facades/git.facade';
import { WorksConfigService } from '../works-config/services/works-config.service';
import type { AppForkReadyHandler, AppForkReadyOutcome } from './app-fork-ready-handler.port';
import {
    APP_WORKS_TELEMETRY_EVENTS,
    AppWorksTelemetryService,
} from './app-works-telemetry.service';

/**
 * APW-01 T15 — `AppSourceInitializerService`, the ready handler (Resolution R-4).
 *
 * Spec: `docs/specs/features/app-works/APW-01-app-work-kind/spec.md` FR-29…FR-31,
 * FR-36, FR-38; plan §6 (`plan.md:789-870`) is normative and is followed step for step.
 * Acceptance: **ACC-01-19** (Blueprint path), **ACC-01-02** (a created fork gets the
 * source file as ONE commit and no clone), **ACC-01-01** (a link gets a setup pull
 * request and nothing is pushed to the default branch), ACC-01-04 (an adopted fork
 * behaves like a link), ACC-01-17 (a retry reuses the open setup pull request),
 * ACC-01-28 (`autoProvision: false`).
 *
 * ## Why this service exists at all (C32)
 *
 * `docs/internal/app-works-build-progress.md` §5.2 row **C32** measured that nothing in
 * the shipped runtime calls `AppSpecService.initialize`: with no `work_app_spec_states`
 * row, `GET /api/works/:id/app-spec` answers
 * `404 not_found "Work <id> has no App spec state yet."` for **every** App Work and every
 * role, so APW-03's whole App spec surface is unreachable in every environment. Step 1
 * below is that missing caller: an App Work's repository becomes ready, the readiness job
 * calls this handler, and the state row exists from then on.
 *
 * ## The five rules this file exists to keep
 *
 * 1. **It never clones** (R-4). Every read is `getLatestCommit` + `getFileContent`
 *    through `GitFacadeService`; every write is one `commitFiles` on a branch the platform
 *    either created (`createdByThisWork`) or a setup pull request. There is no
 *    `cloneOrPull` call anywhere in this file, which is what the spec pins with a facade
 *    spy.
 * 2. **The platform never pushes to a default branch it did not create.** A link, a
 *    pasted fork or an adopted fork gets `ever-works/app-setup` + a pull request; only a
 *    repository THIS App Work created gets a direct commit (plan `:839-854`).
 * 3. **The Blueprint path writes nothing here.** When a Blueprint is requested, the file
 *    is APW-03's apply job's to write — "this handler writes nothing first, so the two can
 *    never race" (`plan.md:831-832`) — and the outcome is `blueprint_requested`.
 * 4. **Every outcome is named.** There is no silent success anywhere: an absent
 *    collaborator, an unreadable head, an unparseable file or a provider that cannot
 *    commit all answer `failed` with a reason code, which APW-02 records verbatim as
 *    `handler_failed:<reason>` and shows the member.
 * 5. **`onDataRepositoryReady` is idempotent.** The file is composed from a content
 *    compare, the setup path reuses the open pull request and skips a commit whose content
 *    is already on the branch, and the follow-ups are gated on the commit the write
 *    produced — so APW-02's `reason: 'setup_merged'` re-invocation returns `unchanged` and
 *    runs its follow-ups exactly once (ACC-01-01, ACC-01-17).
 *
 * ## Where it runs, and why every collaborator is `@Optional()`
 *
 * It runs in the **API process** (APW-02 plan §2.4's reasoning, applied here): every
 * dependency it needs — the database, `ActivityLogService`, APW-03's `AppSpecService`, the
 * git facade — is API-side, and it clones nothing, so nothing about it wants a worker.
 * `apps/api/src/app-works/app-works.module.ts` binds `APP_FORK_READY_HANDLER` with
 * `useExisting: AppSourceInitializerService`, and the Trigger worker binds the same token
 * to `createRemoteProxy(apiClient, 'AppSourceInitializerService')` — it never provides
 * this class and never imports `AppWorksModule`, because it owns no database and no
 * `ActivityLogService`.
 *
 * Every collaborator is injected `@Optional()` because that is this epic's established
 * pattern (`app-work-create.service.ts`, `app-spec.service.ts`): the agent package's own
 * module spec compiles `AppWorksModule` against **shelled** `DatabaseModule` and
 * `FacadesModule` graphs, and a service that quietly REQUIRED one of them would turn that
 * supported graph into `UnknownDependenciesException`. Each absence is a **named refusal**
 * below, never a silent no-op — the one property that makes the optionality safe rather
 * than dangerous.
 *
 * ⚠️ **The one structural consequence, reported rather than hidden.** Because a Nest
 * provider resolves its dependencies from the module that DECLARES it plus that module's
 * imports (the rule the agent module's C10 section records), the agent `AppWorksModule`'s
 * copy of this class cannot see `AppSpecService`: importing `AppSpecModule` there would
 * break the two bare-graph compiles that module's specs perform. So
 * `apps/api/src/app-works/app-works.module.ts` — which does import `AppSpecModule`,
 * `ActivityLogModule` and a `WorksConfigService` — declares the WIRED copy and binds the
 * token to it, while the agent module provides and exports the class as its task requires.
 * Nest resolves a module-local provider ahead of an imported one, so the bound handler is
 * the wired one. `__tests__/app-source-initializer.service.spec.ts` pins both halves.
 */

/** The one file this handler reads and writes (APW-01 FR-29). */
export const APP_SOURCE_INITIALIZER_FILE = APP_SOURCE_SPEC_FILE;

/** The setup branch a link's pull request is cut from (plan `:846`). */
export const APP_SOURCE_SETUP_BRANCH = 'ever-works/app-setup';

/** The commit message of the one commit this handler lands (plan `:840-841`). */
export const APP_SOURCE_COMMIT_MESSAGE = 'chore(ever-works): record App source';

/** The setup pull request's title (plan `:850`). */
export const APP_SOURCE_SETUP_PR_TITLE = 'Add Ever Works App source';

/**
 * How many times a `nonFastForward` refusal is retried, re-reading head each time
 * (plan `:841-842` — "`nonFastForward` ⇒ re-read head and retry, at most 3 times, then
 * `failed/push_rejected`").
 */
export const APP_SOURCE_COMMIT_MAX_ATTEMPTS = 3;

/**
 * The dotted CONTRACTS §6 events this handler writes, one per outcome
 * (`plan.md:855-857`; the family name is R-2's `app_source`).
 */
export const APP_SOURCE_ACTIVITY_EVENTS = {
    linked: 'app.source.linked',
    forked: 'app.source.forked',
    copied: 'app.source.copied',
    failed: 'app.source.failed',
} as const;

/**
 * Resolution **R-2**'s `actionType` for this epic's rows: `app_source`.
 *
 * 🛑 **Declared as a string here, not read from `ActivityActionType`, and that is a
 * reported gap rather than a preference.** The enum member belongs to **APW-01 T6**
 * ("**Modify** `packages/agent/src/entities/activity-log.types.ts` — append
 * `APP_SOURCE = 'app_source'`", `APW-01-app-work-kind/tasks.md:161-167`), which has not
 * landed; that file and `activity-log/feed-kind.ts` (whose spec fails on an enum member
 * without a rule) are both outside this task's file list, so this slice cannot append it.
 * The column is a plain `varchar(50)` and `feed-kind.ts` resolves an unmapped type to its
 * documented default, so the row this handler writes is already exactly the row R-2
 * specifies — stored value `app_source`. **When T6 lands, replace this constant with
 * `ActivityActionType.APP_SOURCE` and delete the cast at the one call site.**
 */
export const APP_SOURCE_ACTIVITY_ACTION_TYPE = 'app_source';

/** Every reason code this handler can answer with — a closed set, so nothing is invented. */
export const APP_SOURCE_INITIALIZER_FAILURES = {
    /** The Work row is gone (deleted between the readiness poll and this call). */
    workNotFound: 'work_not_found',
    /** The Work Repository's coordinates could not be resolved. */
    repositoryUnresolved: 'repository_unresolved',
    /** `AppSpecService` is not in this graph — the state row cannot be created. */
    specStateUnavailable: 'spec_state_unavailable',
    /** `WorkRepository` / `GitFacadeService` are not in this graph. */
    dependenciesUnavailable: 'dependencies_unavailable',
    /** The works-config loader is not in this graph. */
    worksConfigLoaderUnavailable: 'works_config_loader_unavailable',
    /** The default branch has no commit the provider will name. */
    headUnreadable: 'head_unreadable',
    /** `.works/works.yml` is not a YAML object, or the loader refused it. */
    worksYmlUnparseable: 'works_yml_unparseable',
    /** `.works/works.yml` declares another kind — refused, file untouched. */
    worksYmlOtherKind: 'works_yml_other_kind',
    /** The provider cannot commit a file without a clone (APW-03 T22 absent). */
    providerUnsupported: 'provider_unsupported',
    /** Three `nonFastForward` refusals in a row. */
    pushRejected: 'push_rejected',
    /** The Blueprint was asked for but no apply service is bound. */
    blueprintUnavailable: 'blueprint_unavailable',
    /** The apply request threw with no §4.2 code — a fault, never an acceptance. */
    blueprintRequestFailed: 'blueprint_request_failed',
    /** The setup pull request could not be opened. */
    setupPullRequestFailed: 'setup_pr_failed',
    /** Anything unclassified, caught at the boundary — never a thrown handler. */
    unexpected: 'unexpected',
} as const;

/* -------------------------------------------------------------------------- *
 * Provisional seams — the three collaborators T15 names that have not landed
 * -------------------------------------------------------------------------- */

// ── provisional — APW-03 T28 `AppBlueprintApplyService` ──────────────────────
//
// `packages/agent/src/apps-catalog/app-blueprint-apply.service.ts` does not exist in this
// tree (APW-03 T28, `APW-03-app-spec-and-catalog/tasks.md:510-551`), and no token for it
// is declared anywhere. This is the **consumer half** of plan §6 step 2 and nothing more:
// `request(workId, blueprintId, { userId, matchSource, confirmForkMatch })` — plan §2.5
// step 0's signature, name for name — and the §4.2 refusal code it answers with
// (`applyInProgress` is the one this handler re-reads as `blueprint_requested`).
//
// The token's NAME is the one APW-03's own worker binding uses (`tasks.md:897`:
// "`APP_SPEC_SERVICE`, `APP_BLUEPRINT_APPLY_SERVICE` and `APP_LICENSE_SERVICE` through
// `createRemoteProxy`"), so the two halves cannot drift. 🛑 **The swap is mandatory, not
// cosmetic:** a Nest token is compared by identity, so when T28 lands it must bind THIS
// symbol (or this file must import T28's declaration) — two Symbols that happen to share
// a name are two different tokens, and the binding would silently never reach this
// injection.

/** What plan §2.5 step 0's `request` answers, as this handler reads it. */
export interface AppBlueprintApplyOutcome {
    /** `dispatched` ⇒ the apply job is queued. Any other value is read as a refusal. */
    readonly status?: string;
    /** `true` ⇔ the request was accepted (an alternative spelling of `dispatched`). */
    readonly requested?: boolean;
    readonly dispatched?: boolean;
    /** The job runtime's run id, when it answered one. */
    readonly runId?: string | null;
    /** The §4.2 refusal code — `applyInProgress`, `blueprintNotFound`, … */
    readonly code?: string;
    /** An alternative spelling of {@link code}, for a service that answers `reason`. */
    readonly reason?: string;
}

/** APW-03 T28's `AppBlueprintApplyService`, as the ready handler consumes it. */
export interface AppBlueprintApplyCapability {
    request(
        workId: string,
        blueprintId: string,
        options: {
            userId?: string;
            matchSource?: string;
            confirmForkMatch: boolean;
        },
    ): Promise<AppBlueprintApplyOutcome | void>;
}

/** DI token for {@link AppBlueprintApplyCapability} — owned by APW-03 T28. */
export const APP_BLUEPRINT_APPLY_SERVICE = Symbol('APP_BLUEPRINT_APPLY_SERVICE');

// ── provisional — APW-04 `AppProvisioningService` ────────────────────────────
//
// `packages/agent/src/app-provisioning/` does not exist in this tree (APW-04), and
// APW-04's plan declares no token for the class — only `APP_PROVISION_EVENTS_PORT`
// (`plan.md:967`), which is a different message (`forkReady`, consumed by APW-02's
// readiness run). This is the consumer half of plan §6 step 8:
// `start({ workId, trigger: 'auto-create' })`, APW-04's own signature. APW-04's row makes
// a second `start` a no-op, so a retry needs nothing from this side.
//
// 🛑 **The swap is mandatory** for the same identity reason as the Blueprint token.

/** What `AppProvisioningService.start` answers, as this handler reads it. */
export interface AppProvisioningStartOutcome {
    /** `false` with a `missing` list when a readiness flag is not satisfied. */
    readonly started?: boolean;
    readonly missing?: readonly string[];
    /** The provision run's id, when APW-04 answered one. */
    readonly runId?: string | null;
    readonly reason?: string | null;
}

/** APW-04's `AppProvisioningService`, as the ready handler consumes it. */
export interface AppProvisioningCapability {
    start(input: {
        workId: string;
        trigger: 'auto-create';
    }): Promise<AppProvisioningStartOutcome | void>;
}

/** DI token for {@link AppProvisioningCapability} — owned by APW-04. */
export const APP_PROVISIONING_SERVICE = Symbol('APP_PROVISIONING_SERVICE');

// ── provisional — APW-03 T42's licence request, on APW-03's own token ────────
//
// `AppLicenseService` (`APW-03-app-spec-and-catalog/tasks.md:696-726`) does not exist in
// this tree. Two consumer halves of it are already declared in this package —
// `AppLicenseService.getHostingEligibility` (`app-runtime/app-license-gate.ts:93-109`,
// which owns the token) and `AppUpstreamLicenseService` (`app-upstream-sync.service.ts`)
// — and R-26 forbids a third Symbol for the same owner. So this file **reuses**
// `APP_LICENSE_SERVICE` and declares only the member plan §6 step 8 calls:
// `request(workId)` (APW-03 plan `:380`), with APW-02's reason union available as its
// optional second argument (`APP_LICENSE_EVALUATION_REASONS`).
//
// Unbound ⇒ the licence request is skipped and LOGGED BY NAME. That is a documented
// degradation rather than a refusal of the whole hand-off, and it is deliberate: the
// source file is on the default branch and the App Work is usable, so failing the
// hand-off over an epic that has not merged would be the worse answer — and the absence is
// audible, which is what rule 4 of the class docstring requires.

/** APW-03 T42's `AppLicenseService`, as the ready handler consumes it. */
export interface AppSourceLicenseRequestView {
    request(workId: string, reason?: AppLicenseEvaluationReason): Promise<void> | void;
}

/* -------------------------------------------------------------------------- *
 * The git capability — APW-03 T22's `commitFiles` through the facade
 * -------------------------------------------------------------------------- */

// ── provisional — APW-03 T22 (`IGitProviderPlugin.commitFiles?`) ─────────────
//
// `GitFacadeService.commitFiles` does **not exist in this tree**: APW-03 T22 declares the
// plugin capability (its plan §7:717-719 fixes the signature byte for byte) and APW-05
// T16 binds the facade's `RepositoryWriter` over it — neither has landed. Plan §6 step 5
// names the call ("`GitFacadeService.commitFiles` (APW-03 capability) on `defaultBranch`
// with `baseSha: head.sha`") and, in the same breath, fixes what its ABSENCE means:
// "capability absent ⇒ `failed/provider_unsupported`" — never a clone, never a silent
// success.
//
// So the capability is read off the facade at call time and the plan's own degradation is
// what an absent one produces. The argument order follows the facade's convention
// (`owner, repo, <payload>, options`), which is how `createBranch`, `getFileContent` and
// `createBranchFromSha` are all shaped; the payload is APW-03 plan §7:717-719's object.

/** One file in a {@link AppSourceCommitCapability.commitFiles} call (APW-03 plan §7:717-719). */
export interface AppSourceCommitFile {
    readonly path: string;
    readonly content: string;
    readonly encoding: 'utf-8' | 'base64';
}

/** The payload of one clone-free commit (APW-03 plan §7:717-719). */
export interface AppSourceCommitInput {
    readonly branch: string;
    /** The commit the caller believes `branch` is at; a mismatch is refused as `nonFastForward`. */
    readonly baseSha: string;
    readonly message: string;
    readonly files: Array<AppSourceCommitFile>;
}

/** The commit a {@link AppSourceCommitCapability.commitFiles} call landed. */
export interface AppSourceCommitResult {
    readonly commitSha: string;
}

/** The optional `commitFiles` capability the facade will carry (APW-03 T22, APW-05 T16). */
export interface AppSourceCommitCapability {
    commitFiles(
        owner: string,
        repo: string,
        input: AppSourceCommitInput,
        options: GitFacadeOptions,
    ): Promise<AppSourceCommitResult>;
}

/**
 * `GitFacadeService` **and** the optional capability it will carry.
 *
 * Declared as an intersection rather than a second parameter because the facade is one
 * object: an installation whose provider (or whose build of this package) has no
 * `commitFiles` is exactly the `provider_unsupported` case plan §6 names.
 */
export type AppSourceInitializerGit = GitFacadeService & Partial<AppSourceCommitCapability>;

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/** The Work Repository, its tracked branch and the source record every step reads. */
interface InitializerContext {
    work: Work;
    record: AppSourceRecord;
    relation: AppRepositoryMode;
    owner: string;
    repo: string;
    /** The Work Repository branch that is built and deployed — never the upstream's. */
    defaultBranch: string;
    gitOptions: GitFacadeOptions;
    createdByThisWork: boolean;
    blueprintId: string | null;
    blueprintMatchSource: string | null;
    /** `false` only when the member explicitly declined FR-29a's automatic start. */
    autoProvision: boolean;
    /** The state row's `readinessStartedAt` — what `app_work.source_ready` measures from. */
    readinessStartedAt: Date | null;
}

/** What the minimal path (plan §6 steps 3–6) decided. */
interface MinimalPathResult {
    outcome: 'initialized' | 'unchanged' | 'waiting_for_setup_pr' | 'failed';
    reason?: string;
    /** The commit the source is on: the one `commitFiles` returned, or the head read. */
    sha: string | null;
    setupPullRequestUrl?: string;
    setupPullRequestNumber?: number;
}

/**
 * A read that has to distinguish "absent" from "failed" — `''` is not an error.
 *
 * The discriminant is a **string**, not a boolean: this package compiles with
 * `strictNullChecks: false`, under which a boolean discriminant does not narrow a union
 * (the rule `app-deploy-preconditions.service.ts:158-162` records).
 */
type ReadResult<T> = { status: 'ok'; value: T } | { status: 'failed'; reason: string };

@Injectable()
export class AppSourceInitializerService implements AppForkReadyHandler {
    private readonly logger = new Logger(AppSourceInitializerService.name);

    constructor(
        /** The Work: repository coordinates, owner, scope stamps (FR-29). */
        @Optional() private readonly works?: WorkRepository,
        /** The epic's own state row — where the tracked branch is recorded. */
        @Optional() private readonly workUpstreamStates?: WorkUpstreamStateRepository,
        /** The only way this handler talks to a provider (R-4: no clone anywhere). */
        @Optional() private readonly git?: GitFacadeService,
        /**
         * APW-03 T12's `AppSpecService` — step 1's `initialize` (the C32 fix), step 8's
         * `hasValidAppSpec`. Absent ⇒ `failed/spec_state_unavailable`, never a hand-off
         * that "succeeded" while the state row does not exist.
         */
        @Optional() private readonly appSpec?: AppSpecService,
        /** The existing works-config loader of plan §6 step 4. */
        @Optional() private readonly worksConfig?: WorksConfigService,
        /** The one Activity writer (R-34). */
        @Optional() private readonly activity?: ActivityLogService,
        // Every token below is another task's, appended last in the order plan §6 names
        // them, each `@Optional()` with its own documented answer.
        @Optional()
        @Inject(APP_BLUEPRINT_APPLY_SERVICE)
        private readonly blueprintApply?: AppBlueprintApplyCapability,
        @Optional()
        @Inject(APP_LICENSE_SERVICE)
        private readonly license?: AppSourceLicenseRequestView,
        @Optional()
        @Inject(APP_PROVISIONING_SERVICE)
        private readonly provisioning?: AppProvisioningCapability,
        // APW-01 T36 — appended LAST so every positional construction keeps its
        // slots. Absent, no event is emitted; it never changes an outcome.
        @Optional()
        private readonly telemetry?: AppWorksTelemetryService,
    ) {}

    /**
     * The hand-off (plan §6, steps 1–8). Resolves with what happened; it never throws,
     * because a handler that throws is recorded as `handler_failed:unexpected` and the
     * member learns nothing about which step refused.
     */
    async onDataRepositoryReady(input: { workId: string }): Promise<AppForkReadyOutcome> {
        const workId = firstNonEmpty(input?.workId);
        if (!workId) {
            return { result: 'failed', reason: APP_SOURCE_INITIALIZER_FAILURES.workNotFound };
        }

        try {
            return await this.run(workId);
        } catch (error) {
            this.logger.error(
                `App source initializer: work ${workId} failed unexpectedly (${errorText(error)}).`,
            );
            return { result: 'failed', reason: APP_SOURCE_INITIALIZER_FAILURES.unexpected };
        }
    }

    private async run(workId: string): Promise<AppForkReadyOutcome> {
        // ── step 0: the graph, loaded from the Work ───────────────────────────
        const context = await this.loadContext(workId);
        if (typeof context === 'string') {
            return { result: 'failed', reason: context };
        }

        // ── step 1: the state row (C32) ───────────────────────────────────────
        const stateRow = await this.initializeStateRow(context);
        if (stateRow) {
            return stateRow;
        }

        // ── step 2: the default-branch file, read at the head ─────────────────
        const head = await this.readHead(context);
        if (head.status !== 'ok') {
            return this.fail(context, head.reason);
        }

        const current = await this.readFile(context, APP_SOURCE_INITIALIZER_FILE, head.value);
        if (current.status !== 'ok') {
            return this.fail(context, current.reason);
        }

        // ── step 2a: the Blueprint path ───────────────────────────────────────
        if (context.blueprintId && !recordsBlueprint(current.value, context.blueprintId)) {
            return this.requestBlueprint(context);
        }

        // ── steps 3–6: the minimal path ───────────────────────────────────────
        const minimal = await this.initializeSource(context, current.value, head.value);

        // ── step 7: one Activity row per outcome ──────────────────────────────
        await this.recordActivity(context, minimal, Boolean(context.blueprintId));

        // FR-53 — one `app_work.source_ready` per success row, never for a failure.
        if (minimal.outcome !== 'failed') {
            this.trackSourceReady(context, minimal);
        }

        if (minimal.outcome === 'failed') {
            return {
                result: 'failed',
                reason: minimal.reason ?? APP_SOURCE_INITIALIZER_FAILURES.unexpected,
            };
        }

        // ── step 8: follow-ups, only when the source is on the default branch ──
        if (minimal.outcome === 'initialized' || minimal.outcome === 'unchanged') {
            await this.runFollowUps(context, minimal.sha);
        }

        if (minimal.outcome === 'waiting_for_setup_pr') {
            return {
                result: 'waiting_for_setup_pr',
                ...(minimal.setupPullRequestUrl
                    ? { setupPullRequestUrl: minimal.setupPullRequestUrl }
                    : {}),
                ...(typeof minimal.setupPullRequestNumber === 'number'
                    ? { setupPullRequestNumber: minimal.setupPullRequestNumber }
                    : {}),
            };
        }

        return { result: minimal.outcome };
    }

    /* ---------------------------------------------------------------------- *
     * Step 0 — the Work, its repository and its source record
     * ---------------------------------------------------------------------- */

    /**
     * Load the Work and everything the later steps read from it, or answer the **named**
     * reason the hand-off cannot proceed.
     *
     * `defaultBranch` comes from the epic's own state row first — it is what the create
     * path wrote and what the readiness poll was watching — and falls back to the
     * upstream's recorded default branch, then to `main`. It is never the fork's own
     * reported branch: a private copy's shell reports whatever it likes (APW-01 plan §4.2
     * step 10).
     */
    private async loadContext(workId: string): Promise<InitializerContext | string> {
        if (!this.works || !this.git) {
            return APP_SOURCE_INITIALIZER_FAILURES.dependenciesUnavailable;
        }

        const work = await this.works.findById(workId);
        if (!work) {
            return APP_SOURCE_INITIALIZER_FAILURES.workNotFound;
        }

        const record = (work.sourceRepository ?? {}) as AppSourceRecord;
        const website = record.relatedRepositories?.website;
        const owner =
            firstNonEmpty(website?.owner) ??
            firstNonEmpty(record.owner) ??
            firstNonEmpty(work.owner);
        const repo =
            firstNonEmpty(website?.repo) ?? firstNonEmpty(record.repo) ?? firstNonEmpty(work.slug);
        if (!owner || !repo) {
            return APP_SOURCE_INITIALIZER_FAILURES.repositoryUnresolved;
        }

        const state = await this.safe(() => this.workUpstreamStates?.findByWorkId(workId));
        const defaultBranch =
            firstNonEmpty(state?.dataDefaultBranch) ??
            firstNonEmpty(record.upstream?.defaultBranch) ??
            'main';

        return {
            work,
            record,
            relation: relationOf(record),
            owner,
            repo,
            defaultBranch,
            gitOptions: {
                userId: work.userId,
                providerId: firstNonEmpty(work.gitProvider) ?? 'github',
                workId,
            },
            createdByThisWork: record.createdByThisWork === true,
            blueprintId: firstNonEmpty(record.blueprintId) ?? null,
            blueprintMatchSource: firstNonEmpty(record.blueprintMatchSource) ?? null,
            // Absent means ON (APW-01 plan §3.3); only an explicit `false` skips step 8's
            // `start`. The flag is read from the Work row on EVERY invocation, so the
            // post-merge re-invocation of a link honours it too, and it is never cleared.
            autoProvision: record.autoProvision !== false,
            readinessStartedAt: state?.readinessStartedAt ?? null,
        };
    }

    /* ---------------------------------------------------------------------- *
     * Step 1 — the App spec state row (the C32 fix)
     * ---------------------------------------------------------------------- */

    /**
     * Create the App Work's `work_app_spec_states` row — **the call C32 measured as
     * missing everywhere**, and the reason the whole App spec surface answered `404` for
     * every App Work and every role.
     *
     * `initialize` is idempotent (its `workId` is UNIQUE and a second call returns the row
     * that exists), so calling it on every invocation is free and is exactly what makes a
     * retried or re-dispatched readiness run harmless.
     *
     * An unbound `AppSpecService` is `failed/spec_state_unavailable` — NOT a hand-off that
     * reports success while the state row does not exist. That distinction is the whole
     * point of this step: a handler that "succeeded" here without creating the row would
     * reproduce C32 silently, which is the failure mode this slice exists to close.
     */
    private async initializeStateRow(
        context: InitializerContext,
    ): Promise<AppForkReadyOutcome | null> {
        if (!this.appSpec) {
            this.logger.warn(
                `App source initializer: no AppSpecService is bound, so work ${context.work.id} has no ` +
                    'App spec state row (C32). The hand-off reports spec_state_unavailable rather than a ' +
                    'success that never created the row.',
            );
            return this.fail(context, APP_SOURCE_INITIALIZER_FAILURES.specStateUnavailable);
        }

        try {
            await this.appSpec.initialize(context.work.id, context.defaultBranch, {
                tenantId: context.work.tenantId ?? null,
                organizationId: context.work.organizationId ?? null,
            });
            return null;
        } catch (error) {
            this.logger.warn(
                `App source initializer: initialising the App spec state row for work ` +
                    `${context.work.id} failed (${errorText(error)}).`,
            );
            return this.fail(context, APP_SOURCE_INITIALIZER_FAILURES.specStateUnavailable);
        }
    }

    /* ---------------------------------------------------------------------- *
     * The two reads of the minimal path (plan §6 step 3)
     * ---------------------------------------------------------------------- */

    /** `getLatestCommit` on the default branch, or a named reason (never a clone). */
    private async readHead(context: InitializerContext): Promise<ReadResult<string>> {
        const head = await this.safe(() =>
            this.git!.getLatestCommit(
                context.owner,
                context.repo,
                context.defaultBranch,
                context.gitOptions,
            ),
        );
        const sha = firstNonEmpty(head?.sha);
        return sha
            ? { status: 'ok', value: sha }
            : { status: 'failed', reason: APP_SOURCE_INITIALIZER_FAILURES.headUnreadable };
    }

    /**
     * `.works/works.yml` at `sha`, or a named reason.
     *
     * A file that does not exist is **not** an error: `getFileContent` answers `null` for
     * a 404 (the provider's own documented behaviour), and this handler reads that as
     * `''` — a fork whose default branch has no `.works/` directory yet, which is the
     * normal case for the first commit an App Work ever lands.
     */
    private async readFile(
        context: InitializerContext,
        path: string,
        sha: string,
    ): Promise<ReadResult<string>> {
        const file = await this.safe(() =>
            this.git!.getFileContent(context.owner, context.repo, path, context.gitOptions, sha),
        );
        if (file === null) {
            return { status: 'ok', value: '' };
        }
        return {
            status: 'ok',
            value: typeof file.content === 'string' ? file.content : '',
        };
    }

    /* ---------------------------------------------------------------------- *
     * Step 2a — the Blueprint path (plan §6 step 2, ACC-01-19)
     * ---------------------------------------------------------------------- */

    /**
     * Ask APW-03's apply job to compose `source` + the Blueprint spec in one commit (or
     * one pull request), and answer `blueprint_requested`.
     *
     * **This handler writes nothing on this path** — the file is APW-03's alone, which is
     * what makes the two impossible to race. Readiness stays `preparing` (APW-02 writes no
     * `readyAt`, emits no `app.fork.ready`, calls no APW-04 `forkReady` and sets no
     * `nextSyncAt` for this outcome) and the apply job reports back through APW-02's
     * `APP_SOURCE_APPLY_REPORTER`.
     *
     * `applyInProgress` is the one refusal that still answers `blueprint_requested`: the
     * apply it names is the apply this request asked for. Every other refusal is
     * `failed/blueprint_<code>` — a `<code>` this file never invents, taken verbatim from
     * APW-03's §4.2 vocabulary.
     */
    private async requestBlueprint(context: InitializerContext): Promise<AppForkReadyOutcome> {
        const blueprintId = context.blueprintId as string;

        if (!this.blueprintApply) {
            this.logger.warn(
                `App source initializer: work ${context.work.id} records Blueprint "${blueprintId}" but ` +
                    'no Blueprint apply service is bound.',
            );
            return this.fail(context, APP_SOURCE_INITIALIZER_FAILURES.blueprintUnavailable);
        }

        let refusal: string | null = null;
        let threwWithoutCode = false;
        try {
            const answer = await this.blueprintApply.request(context.work.id, blueprintId, {
                userId: context.work.userId,
                ...(context.blueprintMatchSource
                    ? { matchSource: context.blueprintMatchSource }
                    : {}),
                confirmForkMatch: false,
            });
            refusal = refusalCodeOf(answer);
        } catch (error) {
            refusal = refusalCodeOfError(error);
            threwWithoutCode = refusal === null;
            if (threwWithoutCode) {
                this.logger.warn(
                    `App source initializer: the Blueprint apply request for work ${context.work.id} ` +
                        `threw (${errorText(error)}).`,
                );
            }
        }

        if (refusal !== null && refusal !== APPLY_IN_PROGRESS_CODE) {
            return this.fail(context, `${BLUEPRINT_FAILURE_PREFIX}${refusal}`);
        }
        if (threwWithoutCode) {
            // A fault with no §4.2 code is NOT an acceptance: reporting
            // `blueprint_requested` here would leave the App Work in `preparing` until
            // APW-02's sweeper gave up on it, with nothing on the row to say why.
            return this.fail(context, APP_SOURCE_INITIALIZER_FAILURES.blueprintRequestFailed);
        }

        // An `applyInProgress` refusal and an accepted request are the same answer to
        // APW-02: the Blueprint is on its way and the Work stays `preparing`.
        await this.recordActivity(context, { outcome: 'unchanged', sha: null }, true);
        return { result: 'blueprint_requested' };
    }

    /* ---------------------------------------------------------------------- *
     * Steps 3–6 — the minimal path
     * ---------------------------------------------------------------------- */

    /**
     * Compose `.works/works.yml` from what is on the default branch today and land it by
     * the ONE path the relation allows (plan §6 steps 4–6).
     *
     * **Nothing here clones.** `commitFiles` is a provider-API commit; the pull-request
     * path is a branch ref, a commit and a pull request.
     */
    private async initializeSource(
        context: InitializerContext,
        current: string,
        head: string,
    ): Promise<MinimalPathResult> {
        const composed = await this.composeDocument(context, current);
        if (typeof composed === 'string') {
            return { outcome: 'failed', reason: composed, sha: null };
        }

        if (composed.unchanged) {
            // The source is already exactly what this handler would write — which is what
            // the `setup_merged` re-invocation of a link returns, and what a file that
            // already holds the Blueprint plus `spec.source` returns.
            return { outcome: 'unchanged', sha: head };
        }

        const capability = this.commitCapability();
        if (!capability) {
            return {
                outcome: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
                sha: null,
            };
        }

        if (context.createdByThisWork) {
            return this.commitOnDefaultBranch(context, composed.text, head, capability);
        }

        return this.openSetupPullRequest(context, composed.text, head, capability);
    }

    /**
     * Plan §6 step 4, split out so it can be read on its own: parse, refuse the two
     * terminal documents, compose, and compare.
     *
     * The **prototype-pollution strip** is not optional. `.works/works.yml` comes from a
     * repository the member (or anyone who can push to it) controls and is parsed with
     * `yaml.parse`, which surfaces a `__proto__:` mapping key as an OWN enumerable
     * property; this handler then spreads that object into a document it commits. A
     * hostile `__proto__` / `constructor` / `prototype` key would therefore persist across
     * the round trip and become the classic recursive-merge pollution vector for every
     * later consumer. The strip mirrors `WorksConfigWriterService`'s
     * (`works-config-writer.service.ts:24-41`) — the same three names, applied to a
     * **copy** so nothing this handler did not compose is ever mutated.
     */
    private async composeDocument(
        context: InitializerContext,
        current: string,
    ): Promise<{ text: string; unchanged: boolean } | string> {
        const source: AppSourceBlock = {
            relation: context.relation,
            // `upstream` is forbidden for a link (schema R13) and is the single
            // `owner/name` string for the other two relations.
            ...(context.relation === 'link' || !context.record.upstream
                ? {}
                : {
                      upstream: {
                          repo: `${context.record.upstream.owner}/${context.record.upstream.repo}`,
                          defaultBranch: context.record.upstream.defaultBranch,
                      },
                  }),
            branch: context.defaultBranch,
        };

        if (!current.trim()) {
            return { text: serializeDocument({}, source), unchanged: false };
        }

        const parsed = await this.parseExisting(context, current);
        if (typeof parsed === 'string') {
            return parsed;
        }

        const declared = declaredKind(parsed);
        if (declared && declared !== APP_SOURCE_SPEC_KIND) {
            // Changing a declared kind silently would hide an upstream decision (plan §9's
            // failure table). The file is left untouched.
            return APP_SOURCE_INITIALIZER_FAILURES.worksYmlOtherKind;
        }

        const spec = isRecord(parsed.spec) ? parsed.spec : {};
        if (
            Number(parsed.version) === APP_SOURCE_SPEC_VERSION &&
            declared === APP_SOURCE_SPEC_KIND &&
            sameSourceBlock(spec.source, source)
        ) {
            return { text: current, unchanged: true };
        }

        return { text: serializeDocument(parsed, source), unchanged: false };
    }

    /**
     * Parse through the **existing works-config loader** (`WorksConfigService.parse`, the
     * same door the import, sync and generation paths use) so this handler cannot disagree
     * with them about what a valid file is.
     *
     * An absent loader is `failed/works_config_loader_unavailable`, not "parse it myself":
     * a second parser in a second place is exactly how two spellings of the same format
     * appear.
     */
    private async parseExisting(
        context: InitializerContext,
        current: string,
    ): Promise<Record<string, unknown> | string> {
        if (!this.worksConfig) {
            return APP_SOURCE_INITIALIZER_FAILURES.worksConfigLoaderUnavailable;
        }
        try {
            const parsed = this.worksConfig.parse(current);
            return stripDangerousKeys(parsed.raw) as Record<string, unknown>;
        } catch (error) {
            this.logger.warn(
                `App source initializer: ${APP_SOURCE_INITIALIZER_FILE} on ` +
                    `${context.owner}/${context.repo} could not be parsed (${errorText(error)}).`,
            );
            return APP_SOURCE_INITIALIZER_FAILURES.worksYmlUnparseable;
        }
    }

    /**
     * Plan §6 step 5 — the repository THIS App Work created (a fresh fork or a private
     * copy) gets **one** commit on its default branch.
     *
     * `nonFastForward` is a race, not a fault: head is re-read and the write retried, at
     * most {@link APP_SOURCE_COMMIT_MAX_ATTEMPTS} times in total. A fresh fork has no other
     * writer, so a refusal that survives three re-reads is a real fault and is reported as
     * `push_rejected` with the file left untouched.
     */
    private async commitOnDefaultBranch(
        context: InitializerContext,
        text: string,
        head: string,
        capability: AppSourceCommitCapability['commitFiles'],
    ): Promise<MinimalPathResult> {
        let baseSha = head;

        for (let attempt = 1; attempt <= APP_SOURCE_COMMIT_MAX_ATTEMPTS; attempt += 1) {
            try {
                const committed = await capability.call(
                    this.git!,
                    context.owner,
                    context.repo,
                    {
                        branch: context.defaultBranch,
                        baseSha,
                        message: APP_SOURCE_COMMIT_MESSAGE,
                        files: [commitFile(text)],
                    },
                    context.gitOptions,
                );
                return {
                    outcome: 'initialized',
                    sha: firstNonEmpty(committed?.commitSha) ?? baseSha,
                };
            } catch (error) {
                const raced = isNonFastForward(error);
                if (!raced || attempt === APP_SOURCE_COMMIT_MAX_ATTEMPTS) {
                    this.logger.warn(
                        `App source initializer: committing ${APP_SOURCE_INITIALIZER_FILE} to ` +
                            `${context.owner}/${context.repo}@${context.defaultBranch} failed ` +
                            `(${errorText(error)}).`,
                    );
                    return {
                        outcome: 'failed',
                        reason: raced
                            ? APP_SOURCE_INITIALIZER_FAILURES.pushRejected
                            : APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
                        sha: null,
                    };
                }
                // Re-read head before retrying — repeating the same stale commit would make
                // the retry decorative (the same rule APW-05's writer documents).
                const reread = await this.readHead(context);
                if (reread.status !== 'ok') {
                    return {
                        outcome: 'failed',
                        reason: APP_SOURCE_INITIALIZER_FAILURES.headUnreadable,
                        sha: null,
                    };
                }
                baseSha = reread.value;
            }
        }

        return {
            outcome: 'failed',
            reason: APP_SOURCE_INITIALIZER_FAILURES.pushRejected,
            sha: null,
        };
    }

    /**
     * Plan §6 step 6 — a repository this App Work did **not** create (a link, a pasted
     * fork, an adopted fork) gets a setup pull request, and **nothing is ever pushed to its
     * default branch** (ACC-01-01, ACC-01-04).
     *
     * Three refusals that are not failures, all of them idempotency rather than error:
     *
     *   - an **open** pull request whose head is `ever-works/app-setup` is reused, never
     *     duplicated (ACC-01-17);
     *   - an existing branch whose ref is already there (`conflict` / `unprocessable` from
     *     `createBranchFromSha`) is the same reuse case — its own head is the `baseSha`;
     *   - a branch that already carries the composed document is not committed to again,
     *     so a retry lands exactly one commit (plan §6's "Cost": "at most one commit (or
     *     one branch + one commit + one pull request) per App Work").
     *
     * 🛑 **`createBranchFromSha`, never `createBranch`.** `createBranch` resolves
     * `heads/<fromRef>` (`git.facade.ts:807-823`, `github-api.service.ts:1571-1600`), so it
     * takes a branch NAME and a sha passed to it 404s. `createBranchFromSha` is APW-02 P1's
     * implementation of APW-09's signature and is the one call that can point a new ref at
     * an exact commit.
     */
    private async openSetupPullRequest(
        context: InitializerContext,
        text: string,
        head: string,
        capability: AppSourceCommitCapability['commitFiles'],
    ): Promise<MinimalPathResult> {
        const existing = await this.findOpenSetupPullRequest(context);

        // The branch capability, checked BEFORE anything is written: a provider (or a
        // build) without `createBranchFromSha` produces `failed/provider_unsupported` and
        // **no pull request and no commit** — the plan's own degradation for an absent
        // capability (step 6), never a stray branch or a push onto the default branch.
        if (typeof this.git!.createBranchFromSha !== 'function') {
            this.logger.warn(
                'App source initializer: the git facade carries no `createBranchFromSha` capability, so ' +
                    'no setup pull request can be opened without pushing to the default branch.',
            );
            return {
                outcome: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
                sha: null,
            };
        }

        let baseSha: string;
        if (existing) {
            baseSha = (await this.setupBranchHead(context)) ?? head;
        } else {
            try {
                const branch = await this.git!.createBranchFromSha(
                    context.owner,
                    context.repo,
                    APP_SOURCE_SETUP_BRANCH,
                    head,
                    context.gitOptions,
                );
                baseSha = firstNonEmpty(branch?.commit) ?? head;
            } catch (error) {
                if (error instanceof GitOperationNotSupportedError) {
                    return {
                        outcome: 'failed',
                        reason: APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
                        sha: null,
                    };
                }
                // The branch already exists — reuse it, with ITS head as `baseSha`, never
                // the default branch's. A missing branch head is not fatal either: the
                // commit below refuses as a non-fast-forward if the guess was wrong.
                baseSha = (await this.setupBranchHead(context)) ?? head;
            }
        }

        const onBranch = await this.readFile(context, APP_SOURCE_INITIALIZER_FILE, baseSha);
        const carries = onBranch.status === 'ok' && branchCarries(onBranch.value, text);

        if (!carries) {
            try {
                await capability.call(
                    this.git!,
                    context.owner,
                    context.repo,
                    {
                        branch: APP_SOURCE_SETUP_BRANCH,
                        baseSha,
                        message: APP_SOURCE_COMMIT_MESSAGE,
                        files: [commitFile(text)],
                    },
                    context.gitOptions,
                );
            } catch (error) {
                const reason =
                    error instanceof GitOperationNotSupportedError
                        ? APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported
                        : APP_SOURCE_INITIALIZER_FAILURES.setupPullRequestFailed;
                this.logger.warn(
                    `App source initializer: committing ${APP_SOURCE_INITIALIZER_FILE} to ` +
                        `${APP_SOURCE_SETUP_BRANCH} of ${context.owner}/${context.repo} failed ` +
                        `(${errorText(error)}).`,
                );
                return { outcome: 'failed', reason, sha: null };
            }
        }

        const pullRequest = existing ?? (await this.createSetupPullRequest(context));
        if (!pullRequest) {
            return {
                outcome: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.setupPullRequestFailed,
                sha: null,
            };
        }

        return {
            outcome: 'waiting_for_setup_pr',
            sha: baseSha,
            setupPullRequestUrl: pullRequest.url,
            setupPullRequestNumber: pullRequest.number,
        };
    }

    /**
     * The open `ever-works/app-setup` pull request, when there is one (ACC-01-17).
     *
     * The provider's own `head` filter is passed, and every returned row is ALSO matched
     * locally on the branch name — a provider that ignores the filter must not be able to
     * hand back an unrelated pull request the platform would then reuse.
     */
    private async findOpenSetupPullRequest(
        context: InitializerContext,
    ): Promise<{ number: number; url: string } | null> {
        const rows = await this.safe(() =>
            this.git!.listPullRequests(
                context.owner,
                context.repo,
                { state: 'open', head: `${context.owner}:${APP_SOURCE_SETUP_BRANCH}` },
                context.gitOptions,
            ),
        );
        if (!Array.isArray(rows)) {
            return null;
        }

        const match = rows.find(
            (row) =>
                row?.state === 'open' &&
                (row.head === APP_SOURCE_SETUP_BRANCH ||
                    row.head?.endsWith(`:${APP_SOURCE_SETUP_BRANCH}`) === true),
        );
        if (!match) {
            return null;
        }

        return { number: match.number, url: match.url };
    }

    /** The head of the setup branch, or `null` when the provider will not name one. */
    private async setupBranchHead(context: InitializerContext): Promise<string | null> {
        const branch = await this.safe(() =>
            this.git!.getLatestCommit(
                context.owner,
                context.repo,
                APP_SOURCE_SETUP_BRANCH,
                context.gitOptions,
            ),
        );
        return firstNonEmpty(branch?.sha) ?? null;
    }

    /** Open the setup pull request against the default branch (plan §6 step 6). */
    private async createSetupPullRequest(
        context: InitializerContext,
    ): Promise<{ number: number; url: string } | null> {
        try {
            const pullRequest = await this.git!.createPullRequest(
                {
                    owner: context.owner,
                    repo: context.repo,
                    title: APP_SOURCE_SETUP_PR_TITLE,
                    head: APP_SOURCE_SETUP_BRANCH,
                    base: context.defaultBranch,
                },
                context.gitOptions,
            );
            if (!pullRequest?.url || typeof pullRequest.number !== 'number') {
                return null;
            }
            return { number: pullRequest.number, url: pullRequest.url };
        } catch (error) {
            this.logger.warn(
                `App source initializer: opening the setup pull request for work ${context.work.id} ` +
                    `failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * Step 8 — the follow-ups (plan §6 step 8)
     * ---------------------------------------------------------------------- */

    /**
     * `AppLicenseService.request`, then — only when the file does NOT already hold a
     * usable App spec — `AppProvisioningService.start({ trigger: 'auto-create' })`.
     *
     * The two gates are the plan's, word for word:
     *
     *   - **the source must be on the default branch** — the caller only reaches here for
     *     `initialized` and `unchanged`, and `unchanged` is also what the post-merge
     *     re-invocation returns (FR-24a);
     *   - **`hasValidAppSpec(workId, sha)` must be false.** It reads the COMMIT, never the
     *     state row, which is why the `{version, kind, spec.source}` file this handler
     *     writes is correctly read as "no App spec yet" and DOES start provisioning —
     *     while a file that already holds a full valid spec does not (ACC-01-19).
     *
     * `sourceRepository.autoProvision === false` is the one case that skips the `start`
     * call **and nothing else** (ACC-01-28): the licence request still runs, the Activity
     * row is the same `app.source.*` row, and the App Work stays eligible for the one run
     * the member may start by hand.
     */
    private async runFollowUps(context: InitializerContext, sha: string | null): Promise<void> {
        if (this.license) {
            try {
                // No reason argument: APW-03 plan `:380` spells APW-01's call
                // `AppLicenseService.request(workId)` — the initial classification, which is
                // not one of `APP_LICENSE_EVALUATION_REASONS` (those are the re-evaluation
                // triggers APW-02 and APW-03 own).
                await this.license.request(context.work.id);
            } catch (error) {
                this.logger.warn(
                    `App source initializer: the licence request for work ${context.work.id} failed ` +
                        `(${errorText(error)}).`,
                );
            }
        } else {
            this.logger.warn(
                `App source initializer: no AppLicenseService is bound, so the initial licence ` +
                    `classification of work ${context.work.id} was not requested.`,
            );
        }

        if (!context.autoProvision) {
            this.logger.log(
                `App source initializer: work ${context.work.id} declined automatic provisioning ` +
                    '(sourceRepository.autoProvision === false), so the Provisioner was not started.',
            );
            return;
        }

        if (!this.provisioning) {
            this.logger.warn(
                `App source initializer: no AppProvisioningService is bound, so work ` +
                    `${context.work.id} was not offered to the Provisioner.`,
            );
            return;
        }

        if (!sha || !this.appSpec) {
            return;
        }

        let valid: boolean;
        try {
            valid = await this.appSpec.hasValidAppSpec(context.work.id, sha);
        } catch (error) {
            // Fail CLOSED on an unreadable spec: "we could not read it" must never be
            // rendered as "there is no App spec", which would start the Provisioner over a
            // repository that already has one.
            this.logger.warn(
                `App source initializer: reading whether work ${context.work.id} already holds a valid ` +
                    `App spec at ${sha} failed (${errorText(error)}); not starting provisioning.`,
            );
            return;
        }

        if (valid) {
            return;
        }

        try {
            await this.provisioning.start({ workId: context.work.id, trigger: 'auto-create' });
        } catch (error) {
            // APW-04's own row makes a second start a no-op, so a failure here is reported
            // and never fails the hand-off: the source IS on the branch.
            this.logger.warn(
                `App source initializer: starting provisioning for work ${context.work.id} failed ` +
                    `(${errorText(error)}).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * Step 7 — the Activity row (R-2, R-34)
     * ---------------------------------------------------------------------- */

    /**
     * One row per outcome, never none and never two:
     *
     *   - `app.source.linked` / `.forked` / `.copied` on a success, with
     *     `details: { blueprint, setupPullRequest }` — **both booleans**, and nothing else:
     *     the file body never reaches a row (Constitution VII);
     *   - `app.source.failed` with `{ reason }` on a terminal error.
     *
     * The `blueprint`/`setupPullRequest` pair is what the Activity Feed renders, and it is
     * why both booleans are always written: a member reading the feed must be able to tell
     * a link that is waiting on a setup pull request from one where the Blueprint is still
     * applying.
     */
    private async recordActivity(
        context: InitializerContext,
        result: MinimalPathResult,
        blueprint: boolean,
    ): Promise<void> {
        if (!this.activity) {
            return;
        }

        const failed = result.outcome === 'failed';
        const action = failed
            ? APP_SOURCE_ACTIVITY_EVENTS.failed
            : APP_SOURCE_ACTIVITY_EVENTS[ACTIVITY_EVENT_BY_RELATION[context.relation]];

        try {
            await this.activity.log({
                userId: context.work.userId,
                workId: context.work.id,
                // R-2's family — see APP_SOURCE_ACTIVITY_ACTION_TYPE for why this is a
                // local constant until APW-01 T6 appends the enum member.
                actionType: APP_SOURCE_ACTIVITY_ACTION_TYPE as unknown as ActivityActionType,
                action,
                status: failed ? ActivityStatus.FAILED : ActivityStatus.COMPLETED,
                summary: failed
                    ? 'The App source could not be recorded in the Work Repository'
                    : 'The App source was recorded in the Work Repository',
                details: failed
                    ? { reason: result.reason ?? APP_SOURCE_INITIALIZER_FAILURES.unexpected }
                    : {
                          blueprint,
                          setupPullRequest: result.outcome === 'waiting_for_setup_pr',
                      },
            });
        } catch (error) {
            // An Activity write must never fail the hand-off: the source IS on the branch
            // (or the refusal IS named), and losing the row is a reporting problem.
            this.logger.warn(
                `App source initializer: recording the Activity row for work ${context.work.id} failed ` +
                    `(${errorText(error)}).`,
            );
        }
    }

    /**
     * `app_work.source_ready` (FR-53, plan §9.1) — emitted beside each success Activity
     * row: the relation, how long the Work was preparing (from the state row's
     * `readinessStartedAt`, `null` when the row carries none) and whether the source
     * went through a setup pull request. A link therefore emits twice over its life —
     * `setupPullRequest: true` when the pull request opens, `false` on the post-merge
     * re-invocation — exactly as it writes two Activity rows. Never the repository, the
     * pull request URL or the file.
     */
    private trackSourceReady(context: InitializerContext, result: MinimalPathResult): void {
        const started = context.readinessStartedAt
            ? new Date(context.readinessStartedAt).getTime()
            : Number.NaN;
        this.telemetry?.track(
            APP_WORKS_TELEMETRY_EVENTS.sourceReady,
            {
                mode: context.relation,
                preparingMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
                setupPullRequest: result.outcome === 'waiting_for_setup_pr',
            },
            context.work.userId,
        );
    }

    /* ---------------------------------------------------------------------- *
     * Small, named helpers
     * ---------------------------------------------------------------------- */

    /** The one Activity row a short-circuit failure answers with. */
    private async fail(context: InitializerContext, reason: string): Promise<AppForkReadyOutcome> {
        await this.recordActivity(
            context,
            { outcome: 'failed', reason, sha: null },
            Boolean(context.blueprintId),
        );
        return { result: 'failed', reason };
    }

    /**
     * The `commitFiles` capability, read off the facade, or `null` when the provider (or
     * this build) does not carry it — plan §6's `provider_unsupported`, never a clone.
     */
    private commitCapability(): AppSourceCommitCapability['commitFiles'] | null {
        const candidate = (this.git as AppSourceInitializerGit | undefined)?.commitFiles;
        if (typeof candidate !== 'function') {
            this.logger.warn(
                'App source initializer: the git facade carries no `commitFiles` capability (APW-03 T22), ' +
                    'so no source can be written without a clone.',
            );
            return null;
        }
        return candidate;
    }

    /** A call that must not take the hand-off down with it. */
    private async safe<T>(call: () => Promise<T> | T | undefined): Promise<T | null> {
        try {
            const value = await call();
            return value === undefined ? null : value;
        } catch (error) {
            this.logger.warn(
                `App source initializer: a collaborator call failed (${errorText(error)}).`,
            );
            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — no I/O, no DI, each of them unit-testable on its own
 * -------------------------------------------------------------------------- */

/** The one §4.2 code that still answers `blueprint_requested` (plan `:829-830`). */
const APPLY_IN_PROGRESS_CODE = 'applyInProgress';

/** The `failed/blueprint_<code>` prefix plan §6 step 2 fixes. */
const BLUEPRINT_FAILURE_PREFIX = 'blueprint_';

/** Which `app.source.*` event each relation writes (CONTRACTS §6). */
const ACTIVITY_EVENT_BY_RELATION: Readonly<
    Record<AppRepositoryMode, keyof typeof APP_SOURCE_ACTIVITY_EVENTS>
> = {
    link: 'linked',
    fork: 'forked',
    'private-copy': 'copied',
};

/**
 * The security list of `WorksConfigWriterService` (`works-config-writer.service.ts:24`), as
 * a **non-mutating** copy. Kept identical in membership on purpose: two different
 * definitions of "dangerous key" in one package is how one of them quietly stops being
 * applied.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Drop the dangerous own keys, recursively, from a **copy**.
 *
 * `Object.defineProperty` rather than assignment, so a hand-written `__proto__` key is
 * copied as an ordinary property or dropped — never applied to the prototype
 * (`stripExtensionKeys`' technique, `app-spec.schema.ts:1484-1495`). Non-plain objects are
 * returned as they are: rebuilding them by enumeration would silently empty them, and this
 * function runs on attacker-controlled YAML.
 */
export function stripDangerousKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => stripDangerousKeys(entry));
    }
    if (!isRecord(value)) {
        return value;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return value;
    }

    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (DANGEROUS_KEYS.has(key)) {
            continue;
        }
        Object.defineProperty(copy, key, {
            value: stripDangerousKeys(entry),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return copy;
}

/**
 * The document this handler commits: every key the file already had, preserved, with
 * `version`, `kind` and `spec.source` set (plan §6 step 4).
 *
 * `spec` is rebuilt rather than mutated for the same reason {@link stripDangerousKeys}
 * copies: the caller's object is not this function's to change.
 */
export function serializeDocument(
    existing: Record<string, unknown>,
    source: AppSourceBlock,
): string {
    const spec = isRecord(existing.spec) ? existing.spec : {};
    const next: Record<string, unknown> = {
        ...existing,
        version: APP_SOURCE_SPEC_VERSION,
        kind: APP_SOURCE_SPEC_KIND,
        spec: { ...spec, source },
    };
    return yaml.stringify(next);
}

/** The kind a document declares — `spec.kind` first, then the root (the loader's rule). */
export function declaredKind(document: Record<string, unknown>): string | null {
    const spec = isRecord(document.spec) ? document.spec : {};
    return firstNonEmpty(spec.kind) ?? firstNonEmpty(document.kind) ?? null;
}

/**
 * Does the file already record THIS Blueprint **together with** `spec.source`?
 *
 * Both halves are required, and that is the whole clause: a file that records the Blueprint
 * but not the source must still fall through to the minimal path, while a file that records
 * both is what a `setup_merged` re-invocation finds — and returns `unchanged` from, running
 * its follow-ups exactly once (plan `:828-829`).
 */
export function recordsBlueprint(current: string, blueprintId: string): boolean {
    if (!current.trim()) {
        return false;
    }
    let document: unknown;
    try {
        document = yaml.parse(current);
    } catch {
        return false;
    }
    if (!isRecord(document)) {
        return false;
    }
    const spec = isRecord(document.spec) ? document.spec : {};
    const blueprint = isRecord(spec.blueprint) ? spec.blueprint : {};
    return firstNonEmpty(blueprint.id) === blueprintId && isRecord(spec.source);
}

/**
 * Does the file already carry the composed document?
 *
 * The setup path's idempotency key: a retry that finds its document on
 * `ever-works/app-setup` commits nothing, so a link lands exactly one commit however many
 * times the readiness job is re-dispatched. Compared semantically (the source block, not
 * the bytes) because a YAML round trip is free to reorder keys.
 */
export function branchCarries(current: string, composed: string): boolean {
    if (!current.trim()) {
        return false;
    }
    try {
        const left = yaml.parse(current) as unknown;
        const right = yaml.parse(composed) as unknown;
        if (!isRecord(left) || !isRecord(right)) {
            return false;
        }
        const leftSpec = isRecord(left.spec) ? left.spec : {};
        const rightSpec = isRecord(right.spec) ? right.spec : {};
        return sameSourceBlock(leftSpec.source, rightSpec.source);
    } catch {
        return false;
    }
}

/** Structural (key-order-insensitive) equality of two source blocks. */
export function sameSourceBlock(left: unknown, right: unknown): boolean {
    if (!isRecord(left) || !isRecord(right)) {
        return false;
    }
    if (left.relation !== right.relation || left.branch !== right.branch) {
        return false;
    }
    const leftUpstream = isRecord(left.upstream) ? left.upstream : null;
    const rightUpstream = isRecord(right.upstream) ? right.upstream : null;
    if (!leftUpstream || !rightUpstream) {
        return leftUpstream === rightUpstream;
    }
    return (
        leftUpstream.repo === rightUpstream.repo &&
        leftUpstream.defaultBranch === rightUpstream.defaultBranch
    );
}

/** The persisted source type, back to the relation it was created from. */
export function relationOf(record: AppSourceRecord): AppRepositoryMode {
    const entries = Object.entries(APP_SOURCE_REPOSITORY_TYPE_BY_MODE) as Array<
        [AppRepositoryMode, string]
    >;
    const match = entries.find(([, type]) => type === record.type);
    return match ? match[0] : 'link';
}

/** The §4.2 refusal code an apply answer carries, or `null` when it was accepted. */
export function refusalCodeOf(answer: AppBlueprintApplyOutcome | void | null): string | null {
    if (!answer || typeof answer !== 'object') {
        return null;
    }
    const code = firstNonEmpty(answer.code) ?? firstNonEmpty(answer.reason);
    if (code) {
        return code;
    }
    if (answer.dispatched === false || answer.requested === false) {
        return APP_SOURCE_INITIALIZER_FAILURES.blueprintUnavailable;
    }
    if (typeof answer.status === 'string' && answer.status !== 'dispatched') {
        return answer.status;
    }
    return null;
}

/** The §4.2 refusal code a thrown apply error carries, or `null` for a real fault. */
export function refusalCodeOfError(error: unknown): string | null {
    if (error instanceof HttpException) {
        const response = error.getResponse();
        if (isRecord(response)) {
            return firstNonEmpty(response.code) ?? firstNonEmpty(response.reason) ?? null;
        }
        return null;
    }
    if (isRecord(error)) {
        return firstNonEmpty(error.code) ?? null;
    }
    return null;
}

/** The one file this handler writes, in the payload shape APW-03 plan §7 fixes. */
export function commitFile(text: string): AppSourceCommitFile {
    return { path: APP_SOURCE_INITIALIZER_FILE, content: text, encoding: 'utf-8' };
}

/**
 * Was this refusal a non-fast-forward?
 *
 * APW-03 plan §7:719 fixes the provider's own spelling — "rejects with code
 * `nonFastForward` when branch ≠ baseSha" — while the plugin vocabulary this tree already
 * has spells that same condition `conflict` (`GitProviderErrorReason`). Both are read, and
 * neither is guessed at.
 */
export function isNonFastForward(error: unknown): boolean {
    if (isRecord(error) && firstNonEmpty(error.code) === 'nonFastForward') {
        return true;
    }
    return error instanceof GitProviderRequestError && error.reason === 'conflict';
}

/** A non-empty, trimmed string, or `null`. */
function firstNonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/** Is this a plain record (not an array, not `null`, not a scalar)? */
function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A safe, log-injectable rendering of a caught value (control characters stripped). */
function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}
