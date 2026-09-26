import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    APP_BUILD_BLOCKED_REASONS,
    APP_BUILD_RUNNERS,
    APP_BUILD_RUNNER_HEADROOM_GIB,
    APP_BUILD_WORKFLOW_PATH,
    appBuildRunnerCapacity,
    type AppBuildBlockedReason,
    type AppBuildRunnerClass,
    type AppBuildWorkflowState,
    type AppEnvResolvedValue,
    type AppSpec,
    type AppSpecBuild,
    type AppSpecBuildService,
    type AppSpecCheck,
} from '@ever-works/contracts';
import type {
    AppBuildBlock,
    BuildRepositoryRef,
    BuildStrategy,
    BuildValue,
    PrepareRepositoryInput,
    PrepareRepositoryResult,
    RepositoryWriter,
} from '@ever-works/plugin';
import { AppEnvResolver } from '../app-env/app-env.resolver';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { WorkBuild } from '../entities/work-build.entity';
import { WorkBuildPreparation } from '../entities/work-build-preparation.entity';
import {
    APP_BUILD_PLUGIN_RESOLVER,
    APP_BUILD_SPEC_SOURCE,
    APP_BUILD_WORK_SOURCE,
    AppBuildsService,
    parseMemoryQuantityToMiB,
    type AppBuildPluginBinding,
    type AppBuildPrepareJobPayload,
    // T17's provisional PORT for this class, aliased because the class below
    // carries the same name — see the barrel's note on the collision.
    type AppBuildPrepareRunner as AppBuildPrepareRunnerPort,
    type AppBuildSpecSource,
    type AppBuildWorkContext,
    type AppBuildWorkSource,
} from './app-builds.service';

/**
 * APW-05 T19 — the `app-build-prepare` runner (plan §7.2, §7.1, §4.6, §4.7).
 *
 * Spec: `docs/specs/features/app-works/APW-05-builds/spec.md` — FR-7…FR-9 (the
 * workflow write and its read-back), FR-16…FR-19 (build values and their
 * gating), FR-22/FR-23 (runner selection), FR-65/FR-70 (checks), FR-52…FR-54
 * (verification); ACC-05-01, -02, -04, -13, -14, -22, -29 and -30.
 *
 * This is the half of §7.2 that does the **repository work**: read the App Work,
 * its effective App spec and its preparation row; gate the strategy, the build
 * values and the runner; call `IBuildPlugin.prepareRepository`; write the
 * preparation row of §3.1b in ONE transaction; block or dispatch the requested
 * Builds; retry one blocked Build (§7.2 step 7, `APW05-G15`); and repeat while
 * `prepareSeq` keeps moving (the coalescing loop, `APW05-G17`).
 *
 * `AppBuildsService` (T17, landed) owns everything else: `requestPrepare` and
 * its `prepareSeq` bump, `recordProviderRun`, `applySnapshot`, `finalize` and
 * `publish` — the ONE Activity + event writer of §7.8. This file never writes an
 * Activity row itself, and the only event it publishes is the retried Build's
 * `app.build.queued`, through that writer.
 *
 * ## The one lock, and the three passes
 *
 * `plan.md:1366-1382`: every pass runs under
 * `DistributedTaskLockService.runExclusive('app-build-prepare:<workId>', …)`
 * held ≤ 5 minutes. A dispatch that cannot take the lock exits as `skipped`,
 * which is safe because the requester's `prepareSeq` bump is already durable and
 * the holder re-reads it after releasing. Each pass reads `prepareSeq` before it
 * starts and compares it after it finishes; when the marker moved again after the
 * third pass, one `app-build-prepare { reason: 'coalesced' }` is dispatched and
 * the job exits.
 *
 * That dispatch is made AFTER the lock is released, never under it, and it is
 * the only one a run makes. {@link AppBuildPrepareRunner.run} re-reads
 * `prepareSeq` once the lock is gone and dispatches when the loop asked for it,
 * when the marker moved since the loop's last reading, or when the pass ran out
 * of lease. The re-read is what makes `skipped: locked` lossless: a requester
 * bumps BEFORE it tries the lock, so a requester that saw `locked` bumped before
 * the release, and therefore before this re-read — including one that arrived
 * after the loop's last reading, which the loop alone never saw. A run that
 * failed before its FIRST `prepareSeq` read dispatches nothing, so a persistent
 * read fault cannot re-dispatch the job without end (see
 * `coalesceAfterRelease`).
 *
 * "Held ≤ 5 minutes" is enforced: the lock is taken with `maxLifetimeMs` = its
 * 5-minute TTL, so the heartbeat stops at a hard deadline and the lease lapses
 * there. A pass starts no new provider call (a delivery, `setActionsPermissions`,
 * a `startBuild`) after `TTL - APP_BUILD_PREPARE_LEASE_MARGIN_MS`; a run that
 * reached that point reports `leaseExpired` and asks for one coalesced prepare,
 * which picks up the Builds it left `queued` under a fresh lease. A call already
 * in flight at the deadline is not aborted (no signal reaches the provider
 * client), and a delivery that completes still writes its row — that row is the
 * record of what the provider now holds.
 *
 * The Builds a pass acts on are numbered **from the database** — every `queued`
 * manual or verification Build of the Work with `dispatchedAt IS NULL` — and
 * never from the payload's optional `buildId`, so a coalesced dispatch loses
 * nothing (`plan.md:1374-1375`).
 *
 * ## Fail closed, with the missing thing named
 *
 * An unbound collaborator is not a crash and not a silent success: this tree's
 * unconfigured installation answers a named `skipped` (or a named blocked Build)
 * rather than writing a row it cannot justify. The reasons are in
 * {@link APP_BUILD_PREPARE_SKIP_REASONS} and each names its port —
 * `workUnavailable` (`APP_BUILD_WORK_SOURCE`), `pluginUnavailable`
 * (`APP_BUILD_PLUGIN_RESOLVER`), `specUnavailable` (`APP_BUILD_SPEC_SOURCE`),
 * `buildValuesUnavailable` (APW-07's `AppEnvResolver`), `lockUnavailable`
 * (`DistributedTaskLockService`), `locked` (another pass holds the Work),
 * `nothingToPrepare` (the strategy gate found nothing to deliver) and
 * `leaseExpired` (the pass ran out of lock lease; a coalesced prepare follows).
 *
 * ## A blocked Build still gets its workflow
 *
 * Plan §7.2 blocks a requested Build at step 3 (a missing value) and step 4
 * (the runner is too small), and §4.7 says a missing value "never reaches the
 * plugin" — meaning the SECRET SYNC, not the delivery. ACC-05-14's second half is
 * exactly why: "a push-started run fails in its first step in under 1 minute",
 * and that run exists only because the workflow was written. So a blocked Build
 * is blocked, `startBuild` is never called for it, and steps 5–8 still run.
 *
 * A provider throw is deliberately NOT caught here: it propagates to the
 * caller, which reports it. `plan.md:1627` asks for a runtime retry of a GitHub
 * 5xx "3 times over 10 minutes"; that is NOT delivered — the worker task returns
 * the failure instead of rethrowing it (decided 2026-09-24, see
 * `packages/tasks/src/tasks/trigger/app-build-prepare.task.ts`, "Budget"), and
 * the in-process fallback runs once. Nothing in this file re-drives a failed
 * prepare; the scheduled sweep does (`AppBuildSweepService`, §9.2's "3 times",
 * since `6e57ed005`): a requested Build still `queued` with `dispatchedAt` NULL
 * gets `requestPrepare(workId, 'sweep')` while its queue age is in
 * [90 s, 450 s), and past that window it stays `queued` until the Work is
 * prepared again.
 * Nor is "nothing written" true at that point — the provider may already hold
 * the workflow commit or pull request and some secrets.
 *
 * ## A Build is claimed before it is started
 *
 * `startBuild` (the `workflow_dispatch`) is preceded by a conditional claim —
 * `dispatchedAt` stamped `WHERE status = 'queued' AND dispatchedAt IS NULL` —
 * so THIS RUNNER starts a Build at most once whatever happens after the
 * provider call: a database error, a crash, or a second pass that read the same
 * Build. A `startBuild` that THROWS releases the claim (only while the row is
 * still the one this call stamped), so a re-drive retries it; a failed release
 * leaves the claim in place and the Build ends `lost`, which fails safe.
 *
 * Two starts the claim does not cover. A `startBuild` that throws AFTER the
 * provider accepted the dispatch (a client timeout) is released like any other
 * throw, so a re-drive can start a second run, which adoption ignores as
 * uncorrelated. And `AppBuildsService.startVerification` starts its
 * verification Build itself: it inserts the row `queued` with `dispatchedAt`
 * NULL and calls `startBuild` WITHOUT claiming it, so a pass running at that
 * moment can read that Build, claim it and start a second verify run (without
 * the verification plan). That race predates the claim and is routed, not
 * fixed here.
 *
 * ## What this file does not do
 *
 * T19a's webhook installation (§7.7) is a later slice. It runs **after**
 * `prepareRepository` succeeds and writes `webhookId`/`webhookState` on the same
 * preparation row; every write in this file goes through
 * {@link AppBuildPrepareRunner.preparationPatch}, so that task adds two keys to
 * one object rather than a second write path.
 */

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/** The lock key prefix of §7.2: `app-build-prepare:<workId>`. */
export const APP_BUILD_PREPARE_LOCK_KEY_PREFIX = 'app-build-prepare:';

/** The lock key `requestPrepare`'s dispatch and this runner share (§7.2). */
export function appBuildPrepareLockKey(workId: string): string {
    return `${APP_BUILD_PREPARE_LOCK_KEY_PREFIX}${workId}`;
}

/**
 * The lock's lease AND its hard cap (`plan.md:1370`: "held ≤ 5 minutes"). The
 * lock is taken with `ttlMs` = `maxLifetimeMs` = this value, so the heartbeat
 * renews it at 100 s and 200 s and stops at the 5-minute deadline — it is never
 * renewed for the lock service's 24 h default lifetime. A pass starts no new
 * provider call after `TTL - APP_BUILD_PREPARE_LEASE_MARGIN_MS`.
 */
export const APP_BUILD_PREPARE_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * How long before the lock's hard deadline a pass stops STARTING provider calls:
 * enough for one `startBuild` (its `workflow_dispatch` plus the single
 * correlation read) and the row writes around it, so the last call a pass starts
 * normally ends while the lock is still held.
 */
export const APP_BUILD_PREPARE_LEASE_MARGIN_MS = 30_000;

/** How many passes one dispatch may run before it coalesces (`plan.md:1373`). */
export const APP_BUILD_PREPARE_MAX_PASSES = 3;

/** The job id, exported so the task file and the specs never copy the string. */
export const APP_BUILD_PREPARE_JOB_ID = 'app-build-prepare' as const;

/**
 * The App spec's `checks[].timeoutSeconds` default (APW-03 `schema.md:377`:
 * "1800 when absent"), applied before a check reaches the generator.
 */
export const APP_BUILD_CHECK_DEFAULT_TIMEOUT_SECONDS = 1800;

/* -------------------------------------------------------------------------- *
 * The prepare-side view of the build plugin (provisional — T16)
 * -------------------------------------------------------------------------- */

/**
 * _Provisional — T16 (`packages/agent/src/facades/build.facade.ts`)._
 *
 * The **prepare** half of `BuildFacadeService.resolve(workId, userId)` —
 * `plan.md:111` and `tasks.md:330-335`: `{ plugin, auth, settings, repository }`.
 * T17 declared only what its own service calls ({@link AppBuildPluginBinding}); a
 * prepare needs three more things, and none of them is a second resolution path:
 *
 *   - `repository` — the `BuildRepositoryRef` the plugin is bound to. It carries
 *     `createdByAppWork`, which is what makes a Link take the pull-request path
 *     (R-4, §4.6 step 7) and what `AppBuildWorkContext` deliberately does not
 *     duplicate;
 *   - `settings` — plan §4.4's resolved Work-scoped settings, which decide the
 *     runner (this file) and the emitted bytes (the plugin);
 *   - `prepareRepository` and `setActionsPermissions?` — the two `IBuildPlugin`
 *     members §7.2 calls. `setActionsPermissions` is APW-02's (CONTRACTS §3) and
 *     is called once, on a `reason: 'actionsEnabled'` prepare, **before** the
 *     blocked-Build retry (`APW05-G15`, plan §4.6 step 6).
 *
 * 🛑 **The swap is an import, not a rewrite.** The token is T17's
 * `APP_BUILD_PLUGIN_RESOLVER`, imported rather than re-declared: a second
 * `Symbol('APP_BUILD_PLUGIN_RESOLVER')` would be a different token and T16's
 * binding would reach neither injection. When T16 lands, `resolve`'s answer
 * widens to this interface and this declaration disappears.
 */
export interface AppBuildPreparePluginBinding extends AppBuildPluginBinding {
    /** The repository the plugin is bound to; R-4's `createdByAppWork` lives here. */
    readonly repository?: BuildRepositoryRef;
    /** Plan §4.4's resolved settings — the runner keys and the generator's four switches. */
    readonly settings?: Record<string, unknown>;
    /** T16's `repositoryWriter(workId)`: the clone-free read the bootstrap decision needs. */
    readonly writer?: RepositoryWriter;
    prepareRepository?(
        input: AppBuildPrepareInput,
        auth?: { readonly token: string },
        writer?: RepositoryWriter,
    ): Promise<PrepareRepositoryResult>;
    /** APW-02's `setActionsPermissions?`: enable Actions with only this workflow allowed (FR-15). */
    setActionsPermissions?(input: { readonly workflowPath: string }): Promise<void>;
}

/** The resolver, seen through the prepare half. Token: T17's `APP_BUILD_PLUGIN_RESOLVER`. */
export interface AppBuildPreparePluginResolver {
    resolve(workId: string, userId: string): Promise<AppBuildPreparePluginBinding | null>;
}

/**
 * `PrepareRepositoryInput` plus the one signal plan §4.6 step 0 needs.
 *
 * The bootstrap file is generated from canonical inputs **without a build block**
 * (`{ generator, trackedBranch, runner, settings, pins, bootstrap: true }`), and
 * the landed plugin contract
 * (`packages/plugin/src/contracts/capabilities/build.interface.ts:238-252`)
 * declares `build: AppBuildBlock` as REQUIRED and carries no `bootstrap` flag —
 * while the generator T8 landed has both (`workflow/generator.ts:136,144`:
 * `build?: AppBuildBlock | null`, `bootstrap?: boolean`). This interface is the
 * narrowest declaration that lets this job ask for the file §4.6 step 0
 * describes without a cast at the call site.
 *
 * **Routed as a finding**: T2's contract needs `build?: AppBuildBlock | null` and
 * `bootstrap?: boolean`, and T16's facade must forward both.
 */
export interface AppBuildPrepareInput extends Omit<PrepareRepositoryInput, 'build'> {
    readonly build?: AppBuildBlock | null;
    /** Plan §4.6 step 0: a dispatch-only file with no `build` job and no `checks` job. */
    readonly bootstrap?: boolean;
}

/* -------------------------------------------------------------------------- *
 * The result
 * -------------------------------------------------------------------------- */

/**
 * Why a pass did nothing. Every member names the missing thing rather than
 * hiding behind a generic "skipped" — the run log is the only place an
 * unconfigured installation is visible from.
 */
export const APP_BUILD_PREPARE_SKIP_REASONS = [
    'invalidPayload',
    'workUnavailable',
    'pluginUnavailable',
    'specUnavailable',
    'buildValuesUnavailable',
    'lockUnavailable',
    'locked',
    'nothingToPrepare',
    // The pass reached `TTL - APP_BUILD_PREPARE_LEASE_MARGIN_MS` and started
    // nothing more; one coalesced prepare continues under a fresh lease. Reported
    // with `status: 'prepared'` when a delivery landed first, `skipped` otherwise.
    'leaseExpired',
] as const;

/** One skip reason. */
export type AppBuildPrepareSkipReason = (typeof APP_BUILD_PREPARE_SKIP_REASONS)[number];

/** What one run of the job reports. Ids, names and counts only — never a value. */
export interface AppBuildPrepareRunResult {
    /** `prepared` — a pass ran to its end. `skipped` — a named reason. `failed` — a throw. */
    readonly status: 'prepared' | 'skipped' | 'failed';
    readonly jobId: string;
    readonly workId: string | null;
    /** The skip reason, or `null` on `prepared`. */
    readonly reason: string | null;
    /** How many passes ran (1…{@link APP_BUILD_PREPARE_MAX_PASSES}). */
    readonly passes: number;
    /**
     * True when this run asked for its one coalescing dispatch (`plan.md:1378`),
     * made after the lock was released: the marker still moved after the third
     * pass, it moved while the lock was held, or the lease ran out.
     */
    readonly coalesced: boolean;
    /** True when `prepareRepository` delivered (or proved) a workflow on this run. */
    readonly prepared: boolean;
    /** The stored `workflowState` after the last pass, or `null` when nothing was written. */
    readonly workflowState: AppBuildWorkflowState | null;
    /** True when the secret sync ran and the three §3.1b fields were stamped. */
    readonly secretsSynced: boolean;
    /** How many requested Builds this run dispatched. */
    readonly buildsDispatched: number;
    /** How many Builds this run blocked, re-blocked or refreshed as blocked. */
    readonly buildsBlocked: number;
    readonly error: string | null;
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — the strategy gate, the runner fit, the row's mapping
 * -------------------------------------------------------------------------- */

/** One normalised App spec check, as `PrepareRepositoryInput.checks` carries it (R-9). */
export interface AppBuildCheckInput {
    readonly name: string;
    readonly command: string;
    readonly required: boolean;
    readonly timeoutSeconds: number;
}

/**
 * APW-03's `checks[]` projected onto the plugin's input (plan §4.1:635; APW-03
 * `schema.md` §17). `required` is `true` when absent and `timeoutSeconds` is
 * {@link APP_BUILD_CHECK_DEFAULT_TIMEOUT_SECONDS} — the two defaults the App
 * spec's schema documents and never writes back into the file.
 */
export function appBuildChecks(spec: AppSpec | null): AppBuildCheckInput[] {
    return (spec?.checks ?? []).map((check: AppSpecCheck) => ({
        name: check.name,
        command: check.command,
        required: check.required !== false,
        timeoutSeconds: check.timeoutSeconds ?? APP_BUILD_CHECK_DEFAULT_TIMEOUT_SECONDS,
    }));
}

/**
 * The App spec's `build` block normalised for a build plugin (plan §4.1:602-617).
 *
 * `resources.memory` is a quantity string in the App spec and `memoryGiB` a
 * number in the plugin's contract (APW-03 `schema.md` §9:177-179), so the
 * conversion has exactly one home — {@link declaredBuildMemoryGiB}. An
 * unparseable quantity is treated as ABSENT, which is FR-23's "the runner's own
 * maximum" and never blocks (`APW05-G14`): refusing a Build over a string this
 * job could not parse would be this job inventing a limit the App spec did not
 * state. APW-03's validator already reports a non-quantity as `invalid_quantity`.
 */
export function appBuildBlock(spec: AppSpec | null): AppBuildBlock | null {
    const build: AppSpecBuild | undefined = spec?.build;
    if (!build) return null;
    const memoryGiB = declaredBuildMemoryGiB(spec);
    return {
        strategy: (build.strategy ?? 'none') as BuildStrategy,
        ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}),
        ...(build.context ? { context: build.context } : {}),
        ...(build.target ? { target: build.target } : {}),
        args: (build.args ?? []).map((arg) => ({
            name: arg.name,
            ...(arg.value === undefined ? {} : { value: arg.value }),
            ...(arg.fromEnv === undefined ? {} : { fromEnv: arg.fromEnv }),
        })),
        services: (build.services ?? []).map((service: AppSpecBuildService) => ({
            name: service.name,
            image: service.image,
            ...(service.port === undefined ? {} : { port: service.port }),
            ...(service.env && service.env.length > 0
                ? { env: service.env.map((entry) => ({ ...entry })) }
                : {}),
        })),
        resources: {
            cpu: build.resources?.cpu ?? 0,
            ...(memoryGiB === undefined ? {} : { memoryGiB }),
            timeoutMinutes: build.resources?.timeoutMinutes ?? 60,
        },
    };
}

/**
 * The declared `build.resources.memory` in GiB, or `undefined` when absent or
 * unparseable — FR-23's "the field asks for a specific amount, it does not set a
 * ceiling".
 *
 * The unit conversion is T17's `parseMemoryQuantityToMiB` (the same function
 * §4.10's plan budget uses) and the division is exact: `1500Mi` becomes
 * `1.46484375` GiB and is compared as such, so no rounding can move a Build
 * across the ceiling on either side.
 */
export function declaredBuildMemoryGiB(spec: AppSpec | null): number | undefined {
    const mib = parseMemoryQuantityToMiB(spec?.build?.resources?.memory);
    return mib === null ? undefined : mib / 1024;
}

/** The runner one App Work's Build would use — the label and class the generator prints. */
export interface AppBuildRunnerChoice {
    readonly label: string;
    readonly runnerClass: AppBuildRunnerClass;
    readonly vcpu: number;
    readonly memoryGiB: number;
    /** The usable ceiling: the runner's own memory minus the platform's headroom. */
    readonly maxMemoryGiB: number;
}

/**
 * What {@link selectBuildRunner} decided.
 *
 * `reason` is the discriminant rather than `fits`: this package compiles with
 * `strictNullChecks: false`, under which TypeScript cannot narrow on a boolean
 * literal discriminant — a real trap the spec's own assertions would then paper
 * over.
 */
export type AppBuildRunnerDecision =
    | { readonly fits: true; readonly reason: null; readonly runner: AppBuildRunnerChoice }
    | {
          readonly fits: false;
          readonly reason: 'runnerTooSmall';
          readonly runner: AppBuildRunnerChoice;
      }
    | { readonly fits: false; readonly reason: 'runnerMemoryUnknown'; readonly runner: null };

/**
 * Which runner a Build uses: public → the standard public runner; private → the
 * larger runner when the Work declares a label and a memory, else the standard
 * private one (`tasks.md:247-249`, FR-22), and whether the declared memory fits
 * it (FR-23).
 *
 * 🛑 **T11 owns the plugin-side selector**
 * (`packages/plugins/github-actions-build/src/runner/runner-selector.ts`) and it
 * has not landed. The FIT ARITHMETIC already has exactly one implementation —
 * contracts' `APP_BUILD_RUNNER_HEADROOM_GIB` and `appBuildRunnerCapacity` — and
 * this function is only the label/class resolution plus that arithmetic, so the
 * plugin's selector and this decision cannot disagree about which Builds fit.
 * The swap when T11 lands is for `prepareRepository` to return the runner it
 * chose and for this file to consume that instead; until then the prepare job
 * must make the §7.2 step 4 decision itself, because FR-23's block is a platform
 * decision and not a provider's.
 *
 * The comparison is inclusive at the limit, exactly as contracts' own
 * `evaluateBuildRunnerFit` documents: `memoryGiB === capacity` fits.
 */
export function selectBuildRunner(
    visibility: 'public' | 'private',
    settings: Record<string, unknown> | null | undefined,
    declaredMemoryGiB?: number,
): AppBuildRunnerDecision {
    const largerLabel =
        typeof settings?.largerRunnerLabel === 'string' ? settings.largerRunnerLabel.trim() : '';
    const largerMemoryGiB = Number(settings?.largerRunnerMemoryGiB ?? 0);
    const largerVcpu = Number(settings?.largerRunnerVcpu ?? 0);

    if (visibility === 'private' && largerLabel.length > 0) {
        // A label without a memory cannot be checked (plan §4.4: "required when
        // the label is set — the memory check cannot run without it"). The
        // settings schema refuses that pair, so this arm defends against a value
        // that reached the database some other way, and it never guesses.
        if (!Number.isFinite(largerMemoryGiB) || largerMemoryGiB <= 0) {
            return { fits: false, reason: 'runnerMemoryUnknown', runner: null };
        }
        const runner: AppBuildRunnerChoice = {
            label: largerLabel,
            runnerClass: 'github-larger',
            vcpu: Number.isFinite(largerVcpu) && largerVcpu > 0 ? largerVcpu : 0,
            memoryGiB: largerMemoryGiB,
            maxMemoryGiB: largerMemoryGiB - APP_BUILD_RUNNER_HEADROOM_GIB,
        };
        return fit(runner, declaredMemoryGiB);
    }

    const known =
        visibility === 'private' ? APP_BUILD_RUNNERS.githubPrivate : APP_BUILD_RUNNERS.githubPublic;
    const capacity = appBuildRunnerCapacity(known);
    const runner: AppBuildRunnerChoice = {
        label: known.label,
        runnerClass: known.runnerClass,
        vcpu: known.vcpu,
        memoryGiB: known.memoryGiB,
        maxMemoryGiB: capacity.memoryGiB,
    };
    return fit(runner, declaredMemoryGiB);
}

/** FR-23's comparison, in one place: absent memory never blocks (`APW05-G14`). */
function fit(runner: AppBuildRunnerChoice, declaredMemoryGiB?: number): AppBuildRunnerDecision {
    if (declaredMemoryGiB === undefined || declaredMemoryGiB <= runner.maxMemoryGiB) {
        return { fits: true, reason: null, runner };
    }
    return { fits: false, reason: 'runnerTooSmall', runner };
}

/**
 * §3.1b's mapping from a delivery outcome to the stored `workflowState`
 * (`plan.md:903-907`): `committed` → `committed`; the two pull-request states →
 * `pullRequestOpen`; `editedByHand` → `editedByHand`; `unchanged` means the file
 * on the tracked branch already equals the generated bytes, so it stores
 * `committed` and clears the pull request fields.
 */
export function appBuildWorkflowStateFor(
    state: PrepareRepositoryResult['workflow']['state'],
): AppBuildWorkflowState {
    switch (state) {
        case 'committed':
        case 'unchanged':
            return 'committed';
        case 'pullRequestOpened':
        case 'pullRequestUpdated':
            return 'pullRequestOpen';
        case 'editedByHand':
            return 'editedByHand';
        default:
            return 'none';
    }
}

/**
 * The pull request number inside a pull request URL, or `undefined`.
 *
 * 🛑 **Routed as a finding.** `PrepareRepositoryResult.workflow`
 * (`packages/plugin/src/contracts/capabilities/build.interface.ts:255-273`)
 * carries `pullRequestUrl` but **not** `pullRequestNumber`, while §3.1b's row
 * needs both and T9's `writeWorkflow` already returns both
 * (`repo/workflow-writer.ts:311-316`). Until the contract carries the number, the
 * URL is the only place it exists, and reading it there beats storing a row whose
 * `workflowPullRequestNumber` is silently NULL. A URL that does not match leaves
 * the column NULL, which §3.1b already permits.
 */
export function appBuildWorkflowPullRequestNumber(
    url: string | undefined | null,
): number | undefined {
    if (typeof url !== 'string') return undefined;
    const match = /\/pull\/(\d+)(?:\D|$)/.exec(url);
    if (!match) return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The `AppBuildBlockedReason` a plugin's own `blocked.reason` maps onto, or
 * `null` when this platform does not know it.
 *
 * The plugin contract's own words (`build.interface.ts:266-272`): "`reason` is
 * mapped onto `AppBuildBlockedReason` by `AppBuildsService`, which **refuses a
 * reason it does not know rather than storing it**". The closed set is
 * contracts' `APP_BUILD_BLOCKED_REASONS` — imported, not restated — and a reason
 * outside it is logged and stored as no block: a value the web cannot render in
 * `blockedReason` is worse than a Build that stays `queued` with the run log
 * naming the plugin's string.
 */
export function mapPluginBlockedReason(
    reason: string | undefined | null,
): AppBuildBlockedReason | null {
    if (typeof reason !== 'string') return null;
    return (APP_BUILD_BLOCKED_REASONS as readonly string[]).includes(reason)
        ? (reason as AppBuildBlockedReason)
        : null;
}

/**
 * §4.7's name arithmetic: `previous ∪ secretsWritten − secretsRemoved`.
 *
 * The removal set can only ever shrink a name the platform wrote — `previous` is
 * the row's own list, so a name this job never wrote can never be removed
 * (FR-18). The order is the previous list's with new names appended, so the
 * stored array is stable across runs.
 */
export function unionMinusRemoved(
    previous: readonly string[],
    written: readonly string[],
    removed: readonly string[],
): string[] {
    const gone = new Set(removed);
    const next: string[] = [];
    for (const name of previous) {
        if (!gone.has(name)) next.push(name);
    }
    for (const name of written) {
        if (!gone.has(name) && !next.includes(name)) next.push(name);
    }
    return next;
}

/* -------------------------------------------------------------------------- *
 * The runner
 * -------------------------------------------------------------------------- */

/** What one pass did, in the terms the run result and the loop are written in. */
interface PassOutcome {
    /** Set when the pass exited before doing anything, with the reason it exited for. */
    readonly skipReason: AppBuildPrepareSkipReason | null;
    readonly prepared: boolean;
    readonly workflowState: AppBuildWorkflowState | null;
    /** The pull request URL when the delivery took that path (§4.6 steps 3 and 7). */
    readonly workflowPullRequestUrl: string | null;
    /** The repository-level block the plugin reported, when it reported one. */
    readonly repositoryBlocked: AppBuildBlockedReason | null;
    readonly secretSyncRan: boolean;
    readonly dispatched: number;
    readonly blocked: number;
}

/** A pass that did nothing, with the reason it did nothing. */
function skipped(reason: AppBuildPrepareSkipReason): PassOutcome {
    return {
        skipReason: reason,
        prepared: false,
        workflowState: null,
        workflowPullRequestUrl: null,
        repositoryBlocked: null,
        secretSyncRan: false,
        dispatched: 0,
        blocked: 0,
    };
}

/** What {@link AppBuildPrepareRunner.passLoop} answers. */
interface AppBuildPrepareLoopResult {
    readonly passes: number;
    readonly skipReason: AppBuildPrepareSkipReason | null;
    readonly last: PassOutcome;
    /** True when any pass of this run delivered (or proved) a workflow. */
    readonly delivered: boolean;
}

/**
 * The lock lease one run holds: the instant after which it starts no new
 * provider call, and whether it reached it.
 */
interface AppBuildPrepareLease {
    deadline: number;
    expired: boolean;
}

/**
 * What the loop saw, kept OUTSIDE its result so the after-release re-read works
 * even when a pass throws: whether the lock was taken, whether the loop ever
 * completed a `prepareSeq` read, its last reading, and whether the third pass
 * asked to coalesce.
 */
interface AppBuildPrepareObserved {
    acquired: boolean;
    /** True once the loop's first `prepareSeq` read succeeded; `lastSeq` means nothing before. */
    seqRead: boolean;
    lastSeq: number;
    coalesce: boolean;
}

@Injectable()
export class AppBuildPrepareRunner implements AppBuildPrepareRunnerPort {
    private readonly logger = new Logger(AppBuildPrepareRunner.name);

    constructor(
        private readonly builds: AppBuildRepository,
        private readonly preparations: AppBuildPreparationRepository,
        // §7.8's ONE writer: the retried Build's `app.build.queued` is published
        // through it, and the watch job is dispatched through it. This file
        // writes no Activity row and emits no event on its own.
        private readonly service: AppBuildsService,
        @Optional() private readonly locks?: DistributedTaskLockService,
        @Optional()
        @Inject(APP_BUILD_PLUGIN_RESOLVER)
        private readonly plugins?: AppBuildPreparePluginResolver,
        @Optional()
        @Inject(APP_BUILD_WORK_SOURCE)
        private readonly works?: AppBuildWorkSource,
        @Optional()
        @Inject(APP_BUILD_SPEC_SOURCE)
        private readonly specs?: AppBuildSpecSource,
        // APW-07's resolver, landed in `app-env.resolver.ts`. Injected as the
        // CLASS rather than behind a new token: it is the documented
        // `resolveForBuild` implementation (`app-env.resolver.ts:16,612`) and the
        // `@ever-works/agent/app-env` barrel exports it for exactly this call. A
        // module owner registers it; unbound, this job answers
        // `buildValuesUnavailable` rather than syncing zero secrets.
        @Optional() private readonly env?: AppEnvResolver,
        // The entity's own repository, for §7.2 step 7's three conditional claims
        // and the field patches that turn a decision into a row — the same reason
        // `AppBuildsService` injects it (`app-builds.service.ts:937-944`):
        // `AppBuildRepository` owns the number arithmetic and the run identity,
        // and deliberately exposes no generic patch.
        @Optional()
        @InjectRepository(WorkBuild)
        private readonly rows?: Repository<WorkBuild>,
    ) {}

    /* ---------------------------------------------------------------------- *
     * run — the coalescing loop of §7.2
     * ---------------------------------------------------------------------- */

    /**
     * One dispatch of `app-build-prepare`.
     *
     * The lock is taken FIRST and held across every pass: the holder is the only
     * writer of this Work's preparation row while it runs, which is what makes
     * the `prepareSeq` comparison meaningful. The payload's `reason` reaches the
     * pass; the Builds themselves never come from the payload
     * (`plan.md:1374-1375`).
     */
    async run(payload: AppBuildPrepareJobPayload): Promise<AppBuildPrepareRunResult> {
        const workId = typeof payload?.workId === 'string' ? payload.workId : null;
        if (!workId) {
            return this.result({ status: 'skipped', workId: null, reason: 'invalidPayload' });
        }

        if (!this.locks) {
            // No lock means no overlap guard, and §7.2 makes the guard the reason
            // two passes cannot double-fire. Answering `skipped` loses nothing:
            // the requester's `prepareSeq` bump is already durable.
            this.logger.warn(
                `App builds: the prepare of work ${workId} is skipped — DistributedTaskLockService is not bound, ` +
                    'so the app-build-prepare lock of plan §7.2 cannot be taken.',
            );
            return this.result({ status: 'skipped', workId, reason: 'lockUnavailable' });
        }

        const lease: AppBuildPrepareLease = { deadline: 0, expired: false };
        const observed: AppBuildPrepareObserved = {
            acquired: false,
            seqRead: false,
            lastSeq: 0,
            coalesce: false,
        };
        let coalesced = false;
        let lock: { acquired: boolean; result?: AppBuildPrepareLoopResult };
        try {
            lock = await this.locks.runExclusive<AppBuildPrepareLoopResult>(
                appBuildPrepareLockKey(workId),
                () => {
                    observed.acquired = true;
                    // Counted from the moment the lock is held: the lock service
                    // stamps its own hard deadline a few milliseconds earlier, so
                    // the margin absorbs the difference.
                    lease.deadline =
                        Date.now() +
                        APP_BUILD_PREPARE_LOCK_TTL_MS -
                        APP_BUILD_PREPARE_LEASE_MARGIN_MS;
                    return this.passLoop(workId, payload, lease, observed);
                },
                {
                    ttlMs: APP_BUILD_PREPARE_LOCK_TTL_MS,
                    // "held ≤ 5 minutes" (`plan.md:1370`): without this the
                    // heartbeat renews the lease for the lock service's 24 h
                    // default, and every other prepare of the Work answers `locked`
                    // for as long as a stuck holder lives.
                    maxLifetimeMs: APP_BUILD_PREPARE_LOCK_TTL_MS,
                    onLocked: () =>
                        this.logger.debug(
                            `App builds: another pass holds ${appBuildPrepareLockKey(workId)}; this dispatch exits as skipped.`,
                        ),
                },
            );
        } finally {
            // AFTER the release — also when a pass threw: the requests that met
            // the lock while this run held it are only safe if it looks again.
            if (observed.acquired) {
                coalesced = await this.coalesceAfterRelease(workId, observed, lease);
            }
        }

        if (!lock.acquired || !lock.result) {
            return this.result({ status: 'skipped', workId, reason: 'locked' });
        }

        const outcome = lock.result;
        if (lease.expired) {
            // The run stopped starting work at its deadline. A delivery that
            // landed first still counts as prepared; the Builds it left `queued`
            // belong to the coalesced prepare dispatched above.
            return this.result({
                status: outcome.delivered ? 'prepared' : 'skipped',
                workId,
                reason: 'leaseExpired',
                passes: outcome.passes,
                coalesced,
                prepared: outcome.delivered,
                workflowState: outcome.last.workflowState,
                secretSyncRan: outcome.last.secretSyncRan,
                dispatched: outcome.last.dispatched,
                blocked: outcome.last.blocked,
            });
        }
        return this.result({
            status: outcome.skipReason ? 'skipped' : 'prepared',
            workId,
            reason: outcome.skipReason,
            passes: outcome.passes,
            coalesced,
            prepared: outcome.delivered,
            workflowState: outcome.last.workflowState,
            secretSyncRan: outcome.last.secretSyncRan,
            dispatched: outcome.last.dispatched,
            blocked: outcome.last.blocked,
        });
    }

    /**
     * The re-read of `plan.md:1366-1382` — "the holder re-reads it after
     * releasing" — and the ONE coalescing dispatch a run may make.
     *
     * It dispatches when the loop asked for it (the marker still moved after the
     * third pass), when the pass ran out of lease, or when the marker moved since
     * the loop's last reading: a requester that met the lock bumped before it
     * tried it, so its bump is visible here.
     *
     * 🛑 **Bounded.** A run whose loop never completed a `prepareSeq` read
     * dispatches NOTHING, whatever the re-read says: it has no reading to compare
     * with, it did no work (that read is the loop's first statement), and the
     * fault that stopped it stops the next run the same way. Dispatching there
     * made an unbounded chain — each run took the lock, failed the same read and
     * dispatched the next (a busy loop under the in-process fallback). A
     * non-UUID `workId` on Postgres is one such fault: the lock key is varchar,
     * `work_build_preparations.workId` is `uuid`. The run's own failure still
     * propagates to its caller. What that gives up is a request that met the lock
     * inside the one failed read — the same as a failed prepare's own request,
     * which this file never re-drives either.
     *
     * A re-read that fails AFTER the loop read the marker dispatches anyway — a
     * spare prepare re-delivers idempotently, a lost one waits for an unrelated
     * request — and the chain that can follow needs every next run's FIRST read
     * to succeed, so a persistent read fault ends it at the next run. Not
     * awaited: it is a fresh run of this same job.
     */
    private async coalesceAfterRelease(
        workId: string,
        observed: AppBuildPrepareObserved,
        lease: AppBuildPrepareLease,
    ): Promise<boolean> {
        if (!observed.seqRead) {
            // `coalesce` and `lease.expired` are only ever set after that read, so
            // neither can ask for a dispatch here.
            this.logger.warn(
                `App builds: the prepare of work ${workId} failed before it read prepareSeq; ` +
                    'no coalesced prepare is dispatched, so a persistent read fault cannot re-dispatch it without end.',
            );
            return false;
        }
        let moved = true;
        try {
            moved = (await this.readPrepareSeq(workId)) !== observed.lastSeq;
        } catch (error) {
            this.logger.warn(
                `App builds: re-reading prepareSeq of work ${workId} after the prepare failed (${
                    error instanceof Error ? error.message : String(error)
                }); a coalesced prepare is dispatched so no request is lost.`,
            );
        }
        if (!observed.coalesce && !lease.expired && !moved) {
            return false;
        }
        void Promise.resolve(this.service.dispatchPrepare({ workId, reason: 'coalesced' })).catch(
            (error: unknown) =>
                this.logger.warn(
                    `App builds: the coalesced prepare of work ${workId} could not be dispatched (${
                        error instanceof Error ? error.message : String(error)
                    }).`,
                ),
        );
        return true;
    }

    /**
     * The loop: at most {@link APP_BUILD_PREPARE_MAX_PASSES} passes, each bracketed
     * by a `prepareSeq` read (`plan.md:1373-1379`).
     *
     * A pass that skipped leaves the loop immediately — the reason names a missing
     * port or nothing to prepare, and repeating it would only burn the lock. No
     * pass starts once the lease is spent. The loop itself dispatches nothing: it
     * records its last reading and whether it wants to coalesce in `observed`, and
     * `run` makes the one dispatch after the lock is released.
     */
    private async passLoop(
        workId: string,
        payload: AppBuildPrepareJobPayload,
        lease: AppBuildPrepareLease,
        observed: AppBuildPrepareObserved,
    ): Promise<AppBuildPrepareLoopResult> {
        let passes = 0;
        let last: PassOutcome = skipped('nothingToPrepare');
        let skipReason: AppBuildPrepareSkipReason | null = null;
        let delivered = false;
        let seqBefore = await this.readPrepareSeq(workId);
        observed.lastSeq = seqBefore;
        observed.seqRead = true;

        while (passes < APP_BUILD_PREPARE_MAX_PASSES) {
            if (!this.leaseLeft(lease, workId, 'another pass')) {
                skipReason = 'leaseExpired';
                break;
            }
            passes += 1;
            last = await this.pass(workId, payload, lease);
            delivered = delivered || last.prepared;
            if (last.skipReason) {
                skipReason = last.skipReason;
                break;
            }

            const seqAfter = await this.readPrepareSeq(workId);
            observed.lastSeq = seqAfter;
            if (seqAfter === seqBefore) {
                break;
            }
            seqBefore = seqAfter;

            if (passes === APP_BUILD_PREPARE_MAX_PASSES) {
                // `plan.md:1378`: one coalescing dispatch, and the job exits —
                // made by `run` once the lock is released.
                observed.coalesce = true;
            }
        }

        return { passes, skipReason, last, delivered };
    }

    /**
     * May this pass START another provider call? `false` once the lease's
     * deadline has passed, and the lease remembers it so the run reports
     * `leaseExpired` and coalesces.
     */
    private leaseLeft(lease: AppBuildPrepareLease, workId: string, what: string): boolean {
        if (Date.now() < lease.deadline) {
            return true;
        }
        if (!lease.expired) {
            lease.expired = true;
            this.logger.warn(
                `App builds: the prepare of work ${workId} reached its lock lease deadline; ${what} is not started ` +
                    'and a coalesced prepare continues under a fresh lease.',
            );
        }
        return false;
    }

    /** The row's coalescing marker; a Work with no row has nothing to coalesce with (§7.2:1000-1006). */
    private async readPrepareSeq(workId: string): Promise<number> {
        const row = await this.preparations.findByWork(workId);
        return row?.prepareSeq ?? 0;
    }

    /* ---------------------------------------------------------------------- *
     * One pass — plan §7.2 steps 1…7
     * ---------------------------------------------------------------------- */

    private async pass(
        workId: string,
        payload: AppBuildPrepareJobPayload,
        lease: AppBuildPrepareLease,
    ): Promise<PassOutcome> {
        const context = await this.readWork(workId);
        if (!context) {
            return skipped('workUnavailable');
        }

        const row = await this.preparations.findByWork(workId);
        const requested = await this.readRequestedBuilds(workId);
        const verificationBuild = requested.find((build) => build.trigger === 'verification');
        const verification = payload.reason === 'verification' || verificationBuild !== undefined;
        const nonVerification = requested.filter((build) => build.trigger !== 'verification');

        // Step 1 / 5a — the effective App spec, or the spec at the requested sha.
        // `null` covers both "no reader bound" and "APW-03 has no spec at that
        // commit yet": the first is an unconfigured installation and the second is
        // a spec the Provisioner has not applied yet, and both are transient — the
        // Build stays `queued` rather than being blocked for a fact that is about
        // to change. A spec the reader DID answer for and marked invalid is a
        // verdict, and that one blocks (`specInvalid`, §5.1).
        //
        // 🛑 A VERIFICATION request skips the effective-spec gate entirely
        // (`plan.md:1352-1355`): the Provisioner verifies a proposal before any
        // App spec has been applied, so "no spec" is the normal state there and is
        // what §4.6 step 0's bootstrap exists for.
        const specRead = await this.readSpec(
            workId,
            verification ? verificationBuild?.commitSha : null,
        );
        if (!specRead && !verification) {
            return skipped('specUnavailable');
        }
        if (specRead?.valid === false) {
            const blocked = await this.blockOrRefresh(workId, requested, 'specInvalid', {
                commitSha: specRead.commitSha ?? '',
            });
            return { ...skipped('nothingToPrepare'), blocked: blocked.length };
        }

        const spec = specRead?.spec ?? null;
        const checks = appBuildChecks(spec);
        const strategy = (spec?.build?.strategy ?? 'none') as BuildStrategy;

        // Step 2 — the strategy gate. `image`/`none` never produce a Build; `auto`
        // is not a strategy any Wave-1 provider supports (R-13), so a requested
        // Build is blocked and the checks, when declared, are still written.
        // 🛑 MEASURED GAP, reported not fixed (2026-09-17, T42). §7.2 step 2's first
        // clause is broader than the block below: "`strategy` `image`/`none` → **no
        // Build**". `checksOnly` gives an `image`/`none` prepare its checks-only
        // file and skips the secret sync, but a `queued` manual Build of the Work is
        // still dispatched by step 6. Measured with `store.builds = [queued manual]`
        // and an `image` + checks spec, through this runner: `startBuild` calls = 1,
        // `buildsDispatched` = 1, `buildsBlocked` = 0, `dispatchWatch` calls = 1. So
        // the Build is dispatched (its `dispatchedAt` is stamped; the row keeps
        // `queued`, which is what a dispatch does — the status moves when the run is
        // observed) where §7.2 step 2 says it must not run at all. Reachable when the
        // App spec moves to `image`/`none` while a Build is already queued (the API
        // refuses a NEW Build for those strategies: `AppBuildsService.requestRebuild`
        // → `nothingToBuild`, and `recordProviderRun` → `strategyNotBuilt`), so it is
        // a race rather than the normal path — and blocking it needs a
        // `blockedReason` for §7.2 step 2's first clause.
        // `APP_BUILD_BLOCKED_REASONS` has no `nothingToBuild` (that is the API's 422
        // code, not a Build state); the closest member is `strategyNotSupported`,
        // which today means "no Wave-1 provider supports this". Adding it here would
        // change landed T19 behaviour, so it is routed.
        const checksOnly = strategy === 'image' || strategy === 'none';
        const nothingToDeliver =
            checksOnly && checks.length === 0 && !this.platformWroteAWorkflow(row);

        if (checksOnly && !verification && nothingToDeliver) {
            // `image`/`none`, no checks and no file the platform ever wrote:
            // nothing is written and no build plugin is asked — not even
            // resolved. That is what §4.6 step 8 and ACC-05-30 mean by "with no
            // checks, nothing is written".
            return skipped('nothingToPrepare');
        }

        const strategyBlocked: AppBuildBlockedReason | null =
            strategy === 'auto' && !verification ? 'strategyNotSupported' : null;

        // The plugin is resolved before the values and the runner fit because plan
        // §4.4's settings (`largerRunner*`) arrive on the binding, and the booking
        // decision belongs to this job.
        const binding = await this.resolvePlugin(workId, context.userId);
        if (!binding?.prepareRepository) {
            this.logger.warn(
                `App builds: no build plugin is resolvable for work ${workId} (APP_BUILD_PLUGIN_RESOLVER unbound, ` +
                    'or the facade answered null); nothing was prepared.',
            );
            return skipped('pluginUnavailable');
        }

        // T42 (plan §7.2 step 2, §4.14): a checks-only preparation runs
        // `prepareRepository` **without secret sync** for `image`, `none` **and**
        // `auto`-with-checks. `image`/`none` cannot build at all, and an `auto` Work
        // with checks is the same shape — its requested Build is blocked
        // `strategyNotSupported` above, and §4.14's observation groups the three
        // ("`image`, `none` or `auto` (checks-only runs)"). A sync that nobody's
        // Build can read is a set of repository secrets written for a run that never
        // happens, so it does not run: `values: []` and an EMPTY
        // `previouslyWrittenSecretNames` — an empty values list with a populated
        // previous list is a DELETION instruction (§4.7:916-917, FR-18), which is
        // why the two travel together.
        const checksOnlyDelivery = checksOnly || (strategy === 'auto' && checks.length > 0);
        const secretSyncRuns = !verification && !checksOnlyDelivery;
        const values: BuildValue[] = [];
        if (secretSyncRuns) {
            // Step 3 — APW-07's build values (§4.7). A required value with no value
            // BLOCKS the requested Build and the sync never runs; the delivery of
            // steps 5–8 still does, because ACC-05-14's second half needs the
            // workflow on the branch for a push run to fail in its first step.
            const resolved = await this.resolveBuildValues(workId, spec);
            if (!resolved) {
                return skipped('buildValuesUnavailable');
            }
            if (resolved.missing.length > 0) {
                const blocked = await this.blockOrRefresh(
                    workId,
                    nonVerification,
                    'missingBuildValues',
                    { names: resolved.missing },
                );
                if (!this.leaseLeft(lease, workId, 'the workflow delivery')) {
                    return { ...skipped('leaseExpired'), blocked: blocked.length };
                }
                const delivered = await this.writeWorkflow(workId, context, binding, row, {
                    spec,
                    specHash: specRead?.specHash ?? null,
                    values: [],
                    checks,
                    secretSyncRuns: false,
                    bootstrap: false,
                    now: new Date(),
                });
                return { ...delivered, blocked: blocked.length };
            }
            values.push(...resolved.values);
        }

        // Step 4 — runner selection (FR-23, `APW05-G14`). Only a `dockerfile`
        // strategy builds, and only a build has a memory to fit; an ABSENT memory
        // is the runner's own maximum and never blocks.
        let runnerBlocked: AppBuildBlockedReason | null = null;
        let runnerBlockDetail: Record<string, string | number | string[]> = {};
        if (strategy === 'dockerfile') {
            const declared = declaredBuildMemoryGiB(spec);
            const choice = selectBuildRunner(
                binding.repository?.visibility ?? context.repositoryVisibility,
                binding.settings ?? null,
                declared,
            );
            if (choice.reason === 'runnerTooSmall') {
                runnerBlocked = 'runnerTooSmall';
                // FR-23: "stating both numbers" (ACC-05-22).
                runnerBlockDetail = { needed: declared ?? 0, max: choice.runner.maxMemoryGiB };
            } else if (choice.reason === 'runnerMemoryUnknown') {
                // A larger-runner label with no declared memory: the settings
                // schema refuses that pair, so this is a configuration the platform
                // cannot check. It is a named skip, never a silent pass.
                this.logger.warn(
                    `App builds: work ${workId} declares a larger runner label without a memory; the prepare is skipped.`,
                );
                return skipped('buildValuesUnavailable');
            }
        }

        // The lease: no provider call starts after `TTL - margin` (plan §7.2's
        // "held ≤ 5 minutes"). Everything above is a read, so a pass stopped here
        // has changed nothing and the coalesced prepare starts it again.
        if (!this.leaseLeft(lease, workId, 'the workflow delivery')) {
            return skipped('leaseExpired');
        }

        // §7.2 step 7's precondition: `setActionsPermissions?` runs BEFORE the
        // blocked-Build retry, on the one reason that means "the owner just turned
        // Actions on" (`APW05-G15`, plan §4.6 step 6). Best-effort — what the
        // repository actually allows is re-read by the plugin on this same pass.
        if (payload.reason === 'actionsEnabled' && binding.setActionsPermissions) {
            try {
                await binding.setActionsPermissions({ workflowPath: APP_BUILD_WORKFLOW_PATH });
            } catch (error) {
                this.logger.warn(
                    `App builds: enabling Actions for work ${workId} failed (${
                        error instanceof Error ? error.message : String(error)
                    }); the prepare continues.`,
                );
            }
        }

        // Step 5 and 5a — the delivery, then ONE transaction for the row.
        if (!this.leaseLeft(lease, workId, 'the workflow delivery')) {
            return skipped('leaseExpired');
        }
        const now = new Date();
        const delivery = verification
            ? await this.deliverForVerification(workId, context, binding, row, specRead, now)
            : await this.writeWorkflow(workId, context, binding, row, {
                  spec,
                  specHash: specRead?.specHash ?? null,
                  values,
                  checks,
                  secretSyncRuns,
                  bootstrap: false,
                  now,
              });

        // The set of Builds this pass blocked, so step 6 never dispatches what it
        // just blocked — and so a Build blocked twice (a strategy block and then
        // the gate) is still counted once.
        const blockedIds = new Set<string>();
        const block = async (
            builds: readonly WorkBuild[],
            reason: AppBuildBlockedReason,
            detail: Record<string, string | number | string[]>,
        ): Promise<void> => {
            for (const id of await this.blockOrRefresh(workId, builds, reason, detail)) {
                blockedIds.add(id);
            }
        };

        if (strategyBlocked || runnerBlocked) {
            await block(
                nonVerification,
                (strategyBlocked ?? runnerBlocked) as AppBuildBlockedReason,
                strategyBlocked ? { strategy } : runnerBlockDetail,
            );
        }

        // Step 6 — dispatch what is clear to run. A Build is dispatchable only when
        // the workflow the platform wrote is ON the tracked branch: a
        // `workflow_dispatch` runs the file from the dispatched ref (§4.6 step 0),
        // a pull request is not the tracked branch (FR-7, R-4), and a hand edit is
        // not the platform's file to run (FR-9). A repository-level block
        // (`actionsDisabled`) is the same kind of answer: the workflow is written,
        // but nothing can run it, so the Build is blocked and no dispatch is made
        // (§4.6 step 6, `APW05-G15`).
        const gate = this.workflowGate(delivery);
        const hardBlock = delivery.repositoryBlocked
            ? {
                  reason: delivery.repositoryBlocked,
                  detail: { cause: delivery.repositoryBlocked },
              }
            : gate.blockedReason
              ? { reason: gate.blockedReason, detail: gate.detail }
              : null;

        let dispatched = delivery.dispatched;
        if (hardBlock) {
            await block(requested, hardBlock.reason, hardBlock.detail);
        } else {
            const started = await this.startRequestedBuilds(
                workId,
                binding,
                context,
                requested,
                blockedIds,
                lease,
            );
            dispatched += started.dispatched;
        }

        // Step 7 — the blocked-Build retry (`APW05-G15`). A repository-level block
        // suppresses it entirely: a retry while Actions are off would only re-block
        // what is already blocked (`plan.md:1357`).
        if (
            !delivery.repositoryBlocked &&
            !strategyBlocked &&
            !runnerBlocked &&
            !gate.blockedReason
        ) {
            const retried = await this.retryBlockedBuild(
                workId,
                binding,
                context,
                specRead,
                gate,
                lease,
            );
            dispatched += retried.dispatched;
        }

        return { ...delivery, dispatched, blocked: blockedIds.size };
    }

    /* ---------------------------------------------------------------------- *
     * Step 5 — prepareRepository and the preparation row
     * ---------------------------------------------------------------------- */

    /**
     * Step 5a's first arm — a verification request.
     *
     * A verification whose workflow already exists on the tracked branch delivers
     * NOTHING. Writing there would put the spec under verification onto the tracked
     * branch, which is the opposite of what a verification is for; §4.6 step 0's "a
     * later `app.spec.applied` regenerates the full file" is the path that is meant
     * to do it. A verification whose branch has NO workflow file gets the bootstrap
     * of §4.6 step 0 — generated WITHOUT a build block, carried by exactly one
     * commit, and then dispatched on the tracked branch: that is the dead end
     * APW-04's "no workflow yet" case stops at.
     */
    private async deliverForVerification(
        workId: string,
        context: AppBuildWorkContext,
        binding: AppBuildPreparePluginBinding,
        row: WorkBuildPreparation | null,
        specRead: { readonly specHash: string | null; readonly commitSha: string | null },
        now: Date,
    ): Promise<PassOutcome> {
        if (await this.workflowExistsOnTrackedBranch(binding, row)) {
            return {
                ...skipped('nothingToPrepare'),
                skipReason: null,
                // Nothing was prepared this run, and the row keeps whatever state a
                // previous prepare proved — including `'none'` when the file on the
                // branch is not the platform's. The gate reads the state, not this
                // method, so an unknown file never blocks the dispatch.
                workflowState: row?.workflowState ?? null,
            };
        }

        return this.writeWorkflow(workId, context, binding, row, {
            spec: null,
            specHash: specRead.specHash,
            values: [],
            checks: [],
            secretSyncRuns: false,
            bootstrap: true,
            now,
        });
    }

    /**
     * The `prepareRepository` call, its result mapping, and the row it earns
     * (`plan.md:1346-1351`).
     *
     * §3.1b is written in **one** `upsertAfterPrepare` call, which the repository
     * documents as one serialised transaction: the workflow fields change only
     * after a successful read-back, the three secret fields only when the sync
     * ran, and `lastPreparedAt` always.
     */
    private async writeWorkflow(
        workId: string,
        context: AppBuildWorkContext,
        binding: AppBuildPreparePluginBinding,
        row: WorkBuildPreparation | null,
        input: {
            readonly spec: AppSpec | null;
            readonly specHash: string | null;
            readonly values: readonly BuildValue[];
            readonly checks: readonly AppBuildCheckInput[];
            readonly secretSyncRuns: boolean;
            readonly bootstrap: boolean;
            readonly now: Date;
        },
    ): Promise<PassOutcome> {
        const repository: BuildRepositoryRef = binding.repository ?? {
            owner: ownerOf(context.repositoryFullName),
            repo: repoOf(context.repositoryFullName),
            visibility: context.repositoryVisibility,
            trackedBranch: context.trackedBranch,
            // Without a materialised `BuildRepositoryRef` there is no relation
            // fact, and R-4's conservative answer is the pull-request path — which
            // is also what a Link gets. T16's facade always supplies the real one,
            // so this arm only runs in a graph without the facade.
            createdByAppWork: false,
        };

        const previous = row?.buildSecretNames ?? [];
        const request: AppBuildPrepareInput = {
            workId,
            repository,
            build: input.bootstrap ? null : appBuildBlock(input.spec),
            appSpecHash: input.specHash ?? '',
            values: [...input.values],
            // 🛑 The removal set is a DELETION instruction: an empty `values` with a
            // non-empty `previouslyWrittenSecretNames` would delete every secret
            // the platform ever wrote. A checks-only or verification prepare
            // therefore passes an EMPTY previous list, which is what "skips secret
            // sync" has to mean at this seam (§4.7:916-917, FR-18).
            previouslyWrittenSecretNames: input.secretSyncRuns ? [...previous] : [],
            lastWrittenWorkflowSha256: row?.workflowSha256 ?? null,
            // §3.1b's recorded workflow pull request, echoed so the plugin can
            // ADOPT the open one (ACC-05-02, plan §4.6 step 3 "or reuse the open
            // one") instead of asking GitHub for a second and getting its 422.
            // Whether it is still open is GitHub's answer, not this row's.
            workflowPullRequestNumber: row?.workflowPullRequestNumber ?? null,
            workflowPullRequestUrl: row?.workflowPullRequestUrl ?? null,
            settings: { ...(binding.settings ?? {}) },
            checks: [...input.checks],
            ...(input.bootstrap ? { bootstrap: true } : {}),
        };

        let result: PrepareRepositoryResult;
        try {
            result = await binding.prepareRepository!(request, undefined, binding.writer);
        } catch (error) {
            // Propagated to the caller, which reports it as failed. §9.2's runtime
            // retry is NOT delivered (see the worker task's "Budget"), and the
            // provider may already hold the workflow commit or pull request and
            // some secrets — the §3.1b row is simply not updated for them.
            this.logger.warn(
                `App builds: prepareRepository failed for work ${workId} (${
                    error instanceof Error ? error.message : String(error)
                }); the sweep re-drives a requested Build still queued 90-450 s after it was requested, and after that it stays queued until the Work is prepared again.`,
            );
            throw error;
        }

        const state = appBuildWorkflowStateFor(result.workflow.state);
        const pluginBlocked = mapPluginBlockedReason(result.blocked?.reason ?? null);
        if (result.blocked && !pluginBlocked) {
            this.logger.warn(
                `App builds: the build plugin refused the prepare of work ${workId} with reason ` +
                    `"${result.blocked.reason}", which is not one of APP_BUILD_BLOCKED_REASONS; no blocked reason is stored.`,
            );
        }

        const names = input.secretSyncRuns
            ? unionMinusRemoved(previous, result.secretsWritten, result.secretsRemoved)
            : null;

        await this.preparations.upsertAfterPrepare(
            workId,
            this.preparationPatch({
                binding,
                row,
                result,
                state,
                now: input.now,
                repositoryBlock:
                    pluginBlocked && result.blocked
                        ? {
                              reason: pluginBlocked,
                              detail: result.blocked.detail,
                              at: input.now.toISOString(),
                          }
                        : null,
                ...(names === null
                    ? {}
                    : {
                          buildInputsHash: result.buildInputsHash,
                          secretsSyncedAt: input.now,
                          buildSecretNames: names,
                      }),
            }),
        );

        if (names !== null) {
            await this.stampRequestedBuilds(workId, {
                buildInputsHash: result.buildInputsHash,
                buildSecretNames: names,
                secretsSyncedAt: input.now,
            });
        }

        return {
            skipReason: null,
            prepared: true,
            workflowState: state,
            workflowPullRequestUrl: result.workflow.pullRequestUrl ?? null,
            repositoryBlocked: pluginBlocked,
            secretSyncRan: input.secretSyncRuns,
            dispatched: 0,
            blocked: 0,
        };
    }

    /**
     * The one object §3.1b's row is written from (`plan.md:1346-1351`).
     *
     * `workflowSha256` is patched **only** when the delivery proved the bytes are
     * on the tracked branch (`committed`/`unchanged`): a pull-request or hand-edit
     * outcome has no matching read-back there, and §4.6 step 4 stores a hash only
     * after one. The pull request fields are cleared on those tracked-branch
     * outcomes, which is what §3.1b asks for when a file the platform wrote is on
     * the branch.
     *
     * T19a adds `webhookId`/`webhookState` to this object — one write path, two
     * more keys.
     */
    private preparationPatch(input: {
        readonly binding: AppBuildPreparePluginBinding;
        readonly row: WorkBuildPreparation | null;
        readonly result: PrepareRepositoryResult;
        readonly state: AppBuildWorkflowState;
        readonly now: Date;
        readonly repositoryBlock: Record<string, unknown> | null;
        readonly buildInputsHash?: string;
        readonly secretsSyncedAt?: Date;
        readonly buildSecretNames?: string[];
    }) {
        const { result, row, now } = input;
        const workflowOnTracked =
            result.workflow.state === 'committed' || result.workflow.state === 'unchanged';
        const wroteSomething =
            result.workflow.state === 'committed' ||
            result.workflow.state === 'pullRequestOpened' ||
            result.workflow.state === 'pullRequestUpdated';
        const pullRequestNumber = appBuildWorkflowPullRequestNumber(result.workflow.pullRequestUrl);

        return {
            buildPluginId: input.binding.pluginId,
            workflowState: input.state,
            lastPreparedAt: now,
            // `plan.md:890-892`: the repository-level block lives on the row so a
            // later enable is seen without re-deriving it. A clean prepare clears
            // it — a block that outlives its cause is a permanent "Blocked".
            repositoryBlock: input.repositoryBlock,
            ...(workflowOnTracked ? { workflowSha256: result.workflow.contentSha256 } : {}),
            ...(workflowOnTracked
                ? { workflowPullRequestNumber: null, workflowPullRequestUrl: null }
                : {
                      ...(result.workflow.pullRequestUrl
                          ? { workflowPullRequestUrl: result.workflow.pullRequestUrl }
                          : {}),
                      ...(pullRequestNumber === undefined
                          ? {}
                          : { workflowPullRequestNumber: pullRequestNumber }),
                  }),
            // "the first time a prepare writes or commits a file" (§3.1b): only a
            // delivery that landed bytes stamps it, and never twice.
            ...(wroteSomething && !row?.workflowWrittenAt ? { workflowWrittenAt: now } : {}),
            ...(input.buildInputsHash === undefined
                ? {}
                : {
                      buildInputsHash: input.buildInputsHash,
                      secretsSyncedAt: input.secretsSyncedAt,
                      buildSecretNames: input.buildSecretNames,
                  }),
        };
    }

    /**
     * Does the tracked branch carry the workflow already?
     *
     * The read is the `getFileContent` half of T16's writer — the same call T9's
     * `writeWorkflow` makes for FR-9's hand-edit detection, so this job and the
     * delivery cannot disagree about what is on the branch. With no writer bound,
     * the preparation row is the only evidence available: `workflowSha256` and
     * `workflowState` are what a previous prepare proved.
     */
    private async workflowExistsOnTrackedBranch(
        binding: AppBuildPreparePluginBinding,
        row: WorkBuildPreparation | null,
    ): Promise<boolean> {
        const writer = binding.writer;
        if (writer?.getFileContent) {
            try {
                const file = await writer.getFileContent(APP_BUILD_WORKFLOW_PATH);
                return file !== null && file !== undefined;
            } catch (error) {
                this.logger.warn(
                    `App builds: reading ${APP_BUILD_WORKFLOW_PATH} failed (${
                        error instanceof Error ? error.message : String(error)
                    }); falling back to the preparation row.`,
                );
            }
        }
        return this.platformWroteAWorkflow(row);
    }

    /** True when a previous prepare wrote or committed a workflow for this App Work. */
    private platformWroteAWorkflow(row: WorkBuildPreparation | null): boolean {
        return row?.workflowSha256 != null || (row?.workflowState ?? 'none') !== 'none';
    }

    /* ---------------------------------------------------------------------- *
     * Steps 1, 3 and the collaborators
     * ---------------------------------------------------------------------- */

    private async readWork(workId: string): Promise<AppBuildWorkContext | null> {
        if (!this.works) return null;
        try {
            return await this.works.read(workId);
        } catch (error) {
            this.logger.warn(
                `App builds: reading the App Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    private async readSpec(workId: string, sha: string | null | undefined) {
        if (!this.specs) return null;
        try {
            return await this.specs.read(workId, sha ?? null);
        } catch (error) {
            this.logger.warn(
                `App builds: reading the effective App spec of ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    private async resolvePlugin(
        workId: string,
        userId: string,
    ): Promise<AppBuildPreparePluginBinding | null> {
        if (!this.plugins) return null;
        try {
            return await this.plugins.resolve(workId, userId);
        } catch (error) {
            this.logger.warn(
                `App builds: resolving the build plugin of ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /**
     * APW-07's build-phase values, or `null` when the resolver cannot answer.
     *
     * The values themselves never leave this method except into the sealed-box
     * `PUT` the plugin performs: they are not logged, not returned by any endpoint
     * and not written to a row. `missing` is only ever NAMES (FR-26's copy needs
     * them, §4.7).
     */
    private async resolveBuildValues(
        workId: string,
        spec: AppSpec | null,
    ): Promise<{ values: BuildValue[]; missing: string[] } | null> {
        if (!this.env?.resolveForBuild) return null;
        try {
            const resolved = await this.env.resolveForBuild(workId, spec?.build?.services ?? []);
            return {
                values: (resolved.values ?? []).map((entry: AppEnvResolvedValue) => ({
                    name: entry.name,
                    value: entry.value,
                    secret: entry.secret === true,
                    fromBuildService:
                        (entry as AppEnvResolvedValue & { fromBuildService?: boolean })
                            .fromBuildService === true,
                    fingerprint: entry.fingerprint,
                })),
                missing: (resolved.missingRequired ?? []).map((entry) => entry.name),
            };
        } catch (error) {
            this.logger.warn(
                `App builds: resolving the build values of ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the prepare is skipped rather than syncing a set it cannot vouch for.`,
            );
            // A resolver that throws must not be mistaken for "nothing to sync":
            // `null` means "cannot tell", and the caller skips.
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * Builds: selection, blocking, dispatching, and step 7's retry
     * ---------------------------------------------------------------------- */

    /**
     * Every `queued` manual or verification Build of this App Work with
     * `dispatchedAt IS NULL` — the numbering rule of `plan.md:1374-1375`.
     *
     * Read through `AppBuildRepository.findPage` (the only filtered read the
     * repository exposes) and bounded at one page of 100; the order this job acts
     * in is restored to oldest-first by `number`, so two waiting Builds dispatch in
     * the order they were asked for.
     */
    private async readRequestedBuilds(workId: string): Promise<WorkBuild[]> {
        const page = await this.builds.findPage(
            workId,
            { status: ['queued'], trigger: ['manual', 'verification'] },
            1,
            100,
        );
        return page.rows
            .filter((build) => build.dispatchedAt == null)
            .sort((left, right) => left.number - right.number);
    }

    /**
     * Block — or re-block, or refresh in place — the given Builds, and answer the
     * ids that actually moved.
     *
     * The conditional claim is a `WHERE status IN ('queued','blocked')`: a Build
     * that started running between the read and this write keeps the status it
     * earned. Nothing is published: §7.8's map has **no** event for `blocked`
     * (`app-build.events.ts:8-15`), and `AppBuildsService.publish` refuses anything
     * else by construction. That is also why a blocked VERIFICATION Build's
     * `buildUpdated` call to APW-04 (`plan.md:1576-1580`) is unreachable today —
     * routed as a finding against `app-builds.service.ts:1962-1976`.
     */
    private async blockOrRefresh(
        workId: string,
        builds: readonly WorkBuild[],
        reason: AppBuildBlockedReason,
        detail: Record<string, string | number | string[]>,
    ): Promise<string[]> {
        const moved: string[] = [];
        for (const build of builds) {
            const claimed = await this.patchBuild(
                build.id,
                { status: 'blocked', blockedReason: reason, blockedDetail: detail },
                ['queued', 'blocked'],
            );
            if (!claimed) continue;
            moved.push(build.id);
            this.logger.debug(
                `App builds: build ${build.id} of work ${workId} is blocked (${reason}).`,
            );
        }
        return moved;
    }

    /**
     * Step 6 — one claimed `startBuild` per requested Build, then the watch
     * dispatch (§7.2 step 6).
     *
     * `alreadyBlocked` is this pass's own block set: a Build blocked moments ago in
     * the same pass must not be dispatched, whatever the gate says about the others.
     * A `startBuild` that fails releases its claim and leaves the Build `queued`
     * with `dispatchedAt` NULL, so the next prepare (or the sweep's re-drive)
     * retries it (§9.2); it is not a block.
     */
    private async startRequestedBuilds(
        workId: string,
        binding: AppBuildPreparePluginBinding,
        context: AppBuildWorkContext,
        builds: readonly WorkBuild[],
        alreadyBlocked: ReadonlySet<string>,
        lease: AppBuildPrepareLease,
    ): Promise<{ dispatched: number }> {
        let dispatched = 0;
        for (const build of builds) {
            if (alreadyBlocked.has(build.id)) continue;
            if (await this.startBuild(workId, binding, context, build, lease)) dispatched += 1;
        }
        return { dispatched };
    }

    /**
     * One Build: claim it, start it, record the run. `false` when it was not
     * dispatched by this call.
     *
     * 1. **The claim** — `dispatchedAt` is stamped `WHERE status = 'queued' AND
     *    dispatchedAt IS NULL` BEFORE the provider is asked. 0 rows means another
     *    pass (or a cancel) already has the Build, and nothing is started. This is
     *    what closes the duplicate-run window the worker task names: once the
     *    provider has the run, no failure after it can make the Build selectable
     *    again (`readRequestedBuilds` picks `dispatchedAt IS NULL`). It orders
     *    this runner's passes only: a verification Build that
     *    `AppBuildsService.startVerification` starts itself is not claimed there
     *    (see the file header).
     * 2. **`startBuild`.** If it THROWS, the claim is released — only while the
     *    row is still exactly the one this call stamped (`queued`, no run id, the
     *    same `dispatchedAt`) — so a re-drive retries the Build. A release that
     *    fails leaves the claim: the Build is never re-dispatched and ends `lost`,
     *    which fails safe. A failure the provider reports AFTER accepting the
     *    dispatch (a client timeout) is still released: that can start a second
     *    run, which adoption then ignores as uncorrelated.
     * 3. **The run** — `providerRunId` and the provider's `dispatchedAt` (else the
     *    claim's). A throw here is logged, not propagated: the claim already
     *    prevents a second start, and `display_title` adoption plus the watch still
     *    link the run.
     *
     * No new `startBuild` begins once the lease is spent: the Build stays `queued`
     * with `dispatchedAt` NULL for the coalesced prepare.
     */
    private async startBuild(
        workId: string,
        binding: AppBuildPreparePluginBinding,
        context: AppBuildWorkContext,
        build: WorkBuild,
        lease: AppBuildPrepareLease,
    ): Promise<boolean> {
        if (!binding.startBuild) {
            this.logger.warn(
                `App builds: the build plugin of work ${workId} has no startBuild; build ${build.id} stays queued.`,
            );
            return false;
        }
        if (!this.leaseLeft(lease, workId, `startBuild for build ${build.id}`)) {
            return false;
        }

        const claimedAt = new Date();
        const claimed = await this.patchBuild(
            build.id,
            { dispatchedAt: claimedAt },
            ['queued'],
            [{ sql: 'dispatchedAt IS NULL' }],
        );
        if (!claimed) {
            this.logger.debug(
                `App builds: build ${build.id} is already claimed or no longer 'queued'; it is not started again.`,
            );
            return false;
        }

        let dispatchedAt = claimedAt;
        let providerRunId: string | null = null;
        try {
            const answer = await binding.startBuild({
                buildId: build.id,
                ref: build.branch ?? context.trackedBranch,
                sha: build.commitSha,
                mode: build.trigger === 'verification' ? 'verify' : 'build',
            });
            providerRunId = answer?.providerRunId ?? null;
            if (answer?.dispatchedAt) dispatchedAt = new Date(answer.dispatchedAt);
        } catch (error) {
            // The provider call threw: release the claim so the Build keeps its
            // `queued` status with `dispatchedAt` NULL and the next prepare retries
            // it. §9.2's "a requested Build stays queued" is this branch.
            this.logger.warn(
                `App builds: startBuild for build ${build.id} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the Build stays queued.`,
            );
            await this.releaseDispatchClaim(build.id, claimedAt);
            return false;
        }

        let recorded = false;
        try {
            recorded = await this.patchBuild(
                build.id,
                { ...(providerRunId ? { providerRunId } : {}), dispatchedAt },
                ['queued'],
            );
        } catch (error) {
            this.logger.warn(
                `App builds: recording the run of build ${build.id} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the Build keeps its dispatch claim, so it is not started again, and adoption links the run.`,
            );
            recorded = true;
        }
        if (!recorded) {
            // The row left `queued` while the provider was being asked (a
            // cancellation, a sweep). This pass does not own the Build any more,
            // so it neither records the dispatch nor asks for a watch: the watch
            // would only re-read a row this pass did not move.
            this.logger.debug(
                `App builds: build ${build.id} was no longer 'queued' when its dispatch landed; no dispatch is recorded.`,
            );
            return false;
        }

        await this.service.dispatchWatch({ buildId: build.id, reason: 'dispatched' });
        return true;
    }

    /**
     * Undo a dispatch claim after `startBuild` threw — only while the row is still
     * exactly what the claim left: `queued`, no run id, and the `dispatchedAt` this
     * call stamped (bound as epoch ms, the column's storage). A failed release is
     * logged and left: the claim then keeps the Build from ever being started
     * twice, and the sweep ends it `lost`.
     */
    private async releaseDispatchClaim(buildId: string, claimedAt: Date): Promise<void> {
        try {
            await this.patchBuild(
                buildId,
                { dispatchedAt: null },
                ['queued'],
                [
                    { sql: 'providerRunId IS NULL' },
                    {
                        sql: 'dispatchedAt = :claimedAt',
                        params: { claimedAt: claimedAt.getTime() },
                    },
                ],
            );
        } catch (error) {
            this.logger.warn(
                `App builds: releasing the dispatch claim of build ${buildId} failed (${
                    error instanceof Error ? error.message : String(error)
                }); it is not retried and will end as lost.`,
            );
        }
    }

    /**
     * §7.2 step 7 — the blocked-Build retry (`APW05-G15`).
     *
     * Exactly one Build is retried: the Work's newest `blocked` **manual** Build.
     * Verification Builds are never touched — the plan is not stored, so APW-04
     * asks again through `startVerification` — and push and pull-request Builds are
     * never `blocked` because those rows come only from runs.
     *
     * The conditional claim is the plan's own: `UPDATE … SET status='queued',
     * blockedReason=NULL, blockedDetail=NULL, queuedAt=now() WHERE id=:id AND
     * status='blocked'`; 0 rows means another run already took it, so this exits.
     * Every older blocked manual Build becomes `cancelled` with
     * `cancelReason: 'superseded'`, like FR-14's waiting slot, so no "Waiting for…"
     * row is left forever.
     */
    private async retryBlockedBuild(
        workId: string,
        binding: AppBuildPreparePluginBinding,
        context: AppBuildWorkContext,
        specRead: { readonly commitSha: string | null } | null,
        gate: { readonly blockedReason: AppBuildBlockedReason | null },
        lease: AppBuildPrepareLease,
    ): Promise<{ dispatched: number; blocked: number }> {
        if (gate.blockedReason) return { dispatched: 0, blocked: 0 };
        // A retry past the lease deadline would re-queue a Build it cannot start;
        // the coalesced prepare that follows retries it under a fresh lease.
        if (!this.leaseLeft(lease, workId, 'the blocked-Build retry')) {
            return { dispatched: 0, blocked: 0 };
        }

        const page = await this.builds.findPage(
            workId,
            { status: ['blocked'], trigger: ['manual'] },
            1,
            100,
        );
        const [newest, ...older] = page.rows;
        if (!newest) return { dispatched: 0, blocked: 0 };

        // Reachability, fail-closed. `plan.md:1360-1361` asks whether "its commit is
        // still reachable from the tracked branch", and this tree exposes no such
        // read: `BuildRepositoryRef` has none and `RepositoryWriter` reads a file,
        // not a commit graph. So a Build is re-checked only when its commit IS the
        // commit the effective spec was read at — the tracked branch's own commit.
        // An older Build's commit cannot be proven reachable, and queueing a Build
        // onto a commit that may have been rewritten is worse than leaving it
        // blocked. ROUTED AS A FINDING: T16's facade (or APW-02's git facade) owes
        // a commit-reachability read.
        if (!specRead?.commitSha || newest.commitSha !== specRead.commitSha) {
            this.logger.debug(
                `App builds: the newest blocked build ${newest.id} of work ${workId} is not at the commit the ` +
                    'effective spec was read at; it is left blocked (no commit-reachability read is available).',
            );
            return { dispatched: 0, blocked: 0 };
        }

        const requeued = await this.patchBuild(
            newest.id,
            { status: 'queued', blockedReason: null, blockedDetail: null, queuedAt: new Date() },
            ['blocked'],
        );
        if (!requeued) {
            // Another run took it between the read and the claim. Exit, exactly as
            // the plan says: the older ones are that run's business now.
            return { dispatched: 0, blocked: 0 };
        }

        await this.cancelOlderBlocked(older);

        const requeuedRow = {
            ...newest,
            status: 'queued' as const,
            blockedReason: null,
            blockedDetail: null,
        };
        await this.service.publish(requeuedRow as WorkBuild, 'app.build.queued');

        const started = await this.startBuild(
            workId,
            binding,
            context,
            requeuedRow as WorkBuild,
            lease,
        );
        return { dispatched: started ? 1 : 0, blocked: 0 };
    }

    /** Every older blocked manual Build becomes `cancelled` with `cancelReason: 'superseded'`. */
    private async cancelOlderBlocked(older: readonly WorkBuild[]): Promise<void> {
        if (older.length === 0) return;
        if (!this.rows) {
            this.logger.warn(
                'App builds: the WorkBuild repository is not bound; the superseded builds of this App Work are left blocked.',
            );
            return;
        }
        await this.rows
            .createQueryBuilder()
            .update(WorkBuild)
            .set({ status: 'cancelled', cancelReason: 'superseded' })
            .where('id IN (:...ids)', { ids: older.map((build) => build.id) })
            .andWhere('status = :status', { status: 'blocked' })
            .execute();
    }

    /**
     * One conditional field patch on `work_builds`.
     *
     * The `status` predicate is the claim, not a formality: it is what makes
     * "exactly once" a property of the database rather than of the caller, and
     * `affected === 1` is the caller's answer. Written through the query builder on
     * the entity's own repository, exactly as `AppBuildRepository.claimWatchLease`
     * is — `APW05-G10`'s driver-agnostic rule: no raw statement, no
     * dialect-specific fragment. `also` adds further arms to the claim (the
     * dispatch claim's `dispatchedAt IS NULL`); their bare property names are
     * escaped per driver by the update builder, like `status` is.
     */
    private async patchBuild(
        id: string,
        fields: Partial<WorkBuild>,
        status: readonly string[],
        also: ReadonlyArray<{
            readonly sql: string;
            readonly params?: Record<string, unknown>;
        }> = [],
    ): Promise<boolean> {
        if (!this.rows) {
            this.logger.warn(
                'App builds: the WorkBuild repository is not bound; the prepare cannot record a Build decision.',
            );
            return false;
        }
        let query = this.rows
            .createQueryBuilder()
            .update(WorkBuild)
            .set(fields)
            .where('id = :id', { id })
            .andWhere('status IN (:...statuses)', { statuses: [...status] });
        for (const arm of also) {
            query = query.andWhere(arm.sql, arm.params ?? {});
        }
        const result = await query.execute();
        return (result.affected ?? 0) === 1;
    }

    /**
     * Step 5's tail (`plan.md:1350-1351`): a requested Build carries the three
     * §3.1b stamps it was prepared with, so §5.1's verdict reads this Build's own
     * row rather than a preparation that may have moved on since.
     */
    private async stampRequestedBuilds(
        workId: string,
        stamps: {
            readonly buildInputsHash: string;
            readonly buildSecretNames: string[];
            readonly secretsSyncedAt: Date;
        },
    ): Promise<void> {
        const page = await this.builds.findPage(
            workId,
            { status: ['queued'], trigger: ['manual', 'verification'] },
            1,
            100,
        );
        for (const build of page.rows) {
            if (build.dispatchedAt != null) continue;
            await this.patchBuild(build.id, { ...stamps }, ['queued']);
        }
    }

    /**
     * Can a Build be dispatched from what this pass learned?
     *
     * The workflow must be on the tracked branch: `workflow_dispatch` runs the file
     * from the dispatched ref (§4.6 step 0), a pull request is not the tracked
     * branch (FR-7, R-4), and a hand edit is not the platform's file (FR-9 —
     * `workflowEditedByHand`). The pull request URL travels into `blockedDetail`, so
     * APW-04 can show "the workflow is waiting in this pull request".
     */
    private workflowGate(delivery: PassOutcome): {
        readonly blockedReason: AppBuildBlockedReason | null;
        readonly detail: Record<string, string | number | string[]>;
    } {
        if (delivery.workflowState === 'pullRequestOpen') {
            return {
                blockedReason: 'workflowPending',
                detail: delivery.workflowPullRequestUrl
                    ? { pullRequestUrl: delivery.workflowPullRequestUrl }
                    : {},
            };
        }
        if (delivery.workflowState === 'editedByHand') {
            return { blockedReason: 'workflowEditedByHand', detail: {} };
        }
        return { blockedReason: null, detail: {} };
    }

    /* ---------------------------------------------------------------------- *
     * Accounting
     * ---------------------------------------------------------------------- */

    private result(input: {
        readonly status: AppBuildPrepareRunResult['status'];
        readonly workId: string | null;
        readonly reason?: string | null;
        readonly passes?: number;
        readonly coalesced?: boolean;
        readonly prepared?: boolean;
        readonly workflowState?: AppBuildWorkflowState | null;
        readonly secretSyncRan?: boolean;
        readonly dispatched?: number;
        readonly blocked?: number;
        readonly error?: string | null;
    }): AppBuildPrepareRunResult {
        return {
            status: input.status,
            jobId: APP_BUILD_PREPARE_JOB_ID,
            workId: input.workId,
            reason: input.reason ?? null,
            passes: input.passes ?? 0,
            coalesced: input.coalesced ?? false,
            prepared: input.prepared ?? false,
            workflowState: input.workflowState ?? null,
            secretsSynced: input.secretSyncRan ?? false,
            buildsDispatched: input.dispatched ?? 0,
            buildsBlocked: input.blocked ?? 0,
            error: input.error ?? null,
        };
    }
}

/** `owner/repo` → `owner`; a full name this job cannot split answers the whole string. */
function ownerOf(fullName: string): string {
    return String(fullName ?? '').split('/')[0] ?? '';
}

/** `owner/repo` → `repo`. */
function repoOf(fullName: string): string {
    const parts = String(fullName ?? '').split('/');
    return parts.length > 1 ? parts[1] : '';
}
