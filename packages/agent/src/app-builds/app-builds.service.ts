import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import {
    APP_BUILD_DEPLOYABLE_TRIGGERS,
    APP_BUILD_LIST_MAX_PAGE_SIZE,
    APP_BUILD_REBUILD_DEDUPE_MS,
    APP_BUILD_REBUILDS_PER_HOUR,
    APP_BUILD_VERIFY_MEMORY_GIB,
    APP_BUILD_VERIFY_PLAN_MAX_CHARS,
    APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS,
    APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES,
    APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES,
    APP_BUILD_VERIFY_PLAN_MAX_JOBS,
    APP_BUILD_VERIFY_PLAN_MAX_SMOKE,
    APP_BUILD_VERIFY_PROMPTED_SECRET,
    APP_VERIFICATION_JOB_PHASES,
    APP_VERIFICATION_PLAN_VERSION,
    appBuildEventNameForStatus,
    type AppBuildDetail,
    type AppBuildEventName,
    type AppBuildEventPayload,
    type AppBuildKind,
    type AppBuildNotDeployableReason,
    type AppBuildRunSource,
    type AppBuildSummary,
    type AppBuildTrigger,
    type AppBuildBlockedReason,
    type AppEnvRecipeEntry,
    type AppSpec,
    type AppSpecJob,
    type AppSpecSmoke,
    type AppVerificationBuildBlock,
    type AppVerificationComponent,
    type AppVerificationDependency,
    type AppVerificationDependencyKind,
    type AppVerificationJob,
    type AppVerificationPlan,
    type AppVerificationProbe,
    type AppVerificationSmoke,
    type BuildRunRef,
} from '@ever-works/contracts';
// `BuildSnapshot` is the plugin-facing observation shape (§4.1:672-695), declared
// once in `packages/plugin/src/contracts/capabilities/build.interface.ts:324` —
// imported rather than restated, so a field the plugin adds is visible here.
import type { BuildSnapshot } from '@ever-works/plugin';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
    APP_ENV_RESOLVER_FINGERPRINTS,
    AppEnvResolvedFingerprints,
} from '../app-env/app-env.service';
import { APP_PROVISION_EVENTS_PORT } from '../app-works/app-fork-readiness.service';
import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { PluginUsageCapability } from '../entities/plugin-usage-event.entity';
import { UsageOutcome, UsagePayer } from '../entities/_types';
import { WorkBuild } from '../entities/work-build.entity';
import type { WorkBuildPreparation } from '../entities/work-build-preparation.entity';
import { APP_BUILD_EVENT_CLASSES, type AppBuildEventClass } from '../events/app-build.events';
import { PluginUsageService } from '../usage/plugin-usage.service';
// APW-05 T18 — the two dispatcher ports and their DI tokens, IMPORTED from the files
// that own them. This import is the swap: while this module declared its own
// `Symbol('…')` for either name, the `buildJobRuntimeProviders()` binding of the
// owner's token never reached the `@Optional()` injections below, because a Nest token
// is compared by identity (see the block above `dispatchPrepare`). They are re-exported
// a few lines down so every existing import path keeps working.
import {
    APP_BUILD_PREPARE_DISPATCHER,
    type AppBuildPrepareDispatcher,
} from '../tasks/app-build-prepare-dispatcher';
import {
    APP_BUILD_WATCH_DISPATCHER,
    type AppBuildWatchDispatcher,
} from '../tasks/app-build-watch-dispatcher';
import {
    evaluateBuildVerdict,
    fingerprintsToValues,
    type AppBuildVerdict,
    type AppBuildVerdictRow,
} from './deployable-verdict';

/* -------------------------------------------------------------------------- *
 * Job payloads, dispatchers and the in-process fallback (§7.1, APW05-G20)
 * -------------------------------------------------------------------------- */

/**
 * Why a prepare was asked for (`plan.md:1312-1314`), plus §7.2's coalescing
 * reason and the sweep's re-drive of a requested Build nothing dispatched
 * (`sweep` — §9.2's "the job retries 3 times", delivered by
 * `AppBuildSweepService` rather than by the job runtime; see that file).
 */
export const APP_BUILD_PREPARE_REASONS = [
    'specApplied',
    'envChanged',
    'rebuild',
    'verification',
    'pullTokenSaved',
    'workflowMerged',
    'settingsChanged',
    'actionsEnabled',
    'coalesced',
    'sweep',
] as const;

/** One `app-build-prepare` reason. */
export type AppBuildPrepareReason = (typeof APP_BUILD_PREPARE_REASONS)[number];

/** Why an observation is being asked for (`plan.md:1315`). */
export const APP_BUILD_WATCH_REASONS = ['event', 'dispatched', 'sweep'] as const;

/** One `app-build-watch` reason. */
export type AppBuildWatchReason = (typeof APP_BUILD_WATCH_REASONS)[number];

/** The `app-build-prepare` payload (`plan.md:1312-1314`). */
export interface AppBuildPrepareJobPayload {
    readonly workId: string;
    readonly buildId?: string;
    readonly reason: AppBuildPrepareReason;
}

/** The `app-build-watch` payload (`plan.md:1315`). */
export interface AppBuildWatchJobPayload {
    readonly buildId: string;
    readonly reason: AppBuildWatchReason;
}

// ── provisional seams ───────────────────────────────────────────────────────
//
// Tokens whose owner tasks have not landed. Each is declared in the exact shape
// its owner fixes, in the same style as APW-02's provisional blocks. The runtime
// contract — the token identity, the arguments, the resolved value — is already
// the final one, so the swap is an import and nothing else.
//
// 🛑 **The swap is mandatory, not cosmetic.** A Nest token is compared by
// identity: two `Symbol()`s that happen to share a name are two different
// tokens. If the owner lands its own declaration and one of these blocks is left
// in place, the owner's binding will not reach this injection.
//
// ✅ **AND THAT IS EXACTLY WHAT HAPPENED, for the two dispatchers — closed here.**
// T18 landed `…/tasks/app-build-prepare-dispatcher.ts` and
// `…/tasks/app-build-watch-dispatcher.ts` while this file still declared its own
// `Symbol('APP_BUILD_PREPARE_DISPATCHER')` / `Symbol('APP_BUILD_WATCH_DISPATCHER')`,
// and `buildJobRuntimeProviders()` binds the OWNER's symbols, so both `@Optional()`
// injections below stayed `undefined`: every prepare and watch took §7.1's
// in-process fallback, silently, with no error anywhere — the failure this comment
// predicted, and the reason a same-named token is worse than a missing one. The two
// names now come from the owner's files (imported for identity, re-exported so every
// existing import path keeps working) and no local `Symbol()` for them remains.

/**
 * APW-05 T18 — the two dispatcher ports and their tokens, **owned by
 * `packages/agent/src/tasks/app-build-{prepare,watch}-dispatcher.ts`** and
 * re-exported here so nothing that imports them from this file or from the
 * `@ever-works/agent/app-builds` barrel has to move.
 *
 * The imported interface is the owner's, so it is structurally the same port this
 * block used to declare: `dispatchAppBuildPrepare` / `dispatchAppBuildWatch`
 * answering `Promise<string | null>`, where `null` means "no runtime took it" — the
 * signal the in-process fallback keys on (`plan.md:1317-1319`, `APW05-G20`). The
 * payload types are assignable in both directions (the owner's `reason` is the
 * wider `string`), so the call sites below are unchanged.
 */
export { APP_BUILD_PREPARE_DISPATCHER, APP_BUILD_WATCH_DISPATCHER };
export type { AppBuildPrepareDispatcher, AppBuildWatchDispatcher };

/** _Provisional — T19 (`…/app-build-prepare.runner.ts`): the in-process half of §7.1._ */
export interface AppBuildPrepareRunner {
    run(payload: AppBuildPrepareJobPayload): Promise<unknown>;
}

/** DI token for {@link AppBuildPrepareRunner} — owned by T19. */
export const APP_BUILD_PREPARE_RUNNER = Symbol('APP_BUILD_PREPARE_RUNNER');

/** _Provisional — T20 (`…/app-build-watch.runner.ts`): the in-process half of §7.1._ */
export interface AppBuildWatchRunner {
    run(payload: AppBuildWatchJobPayload): Promise<unknown>;
}

/** DI token for {@link AppBuildWatchRunner} — owned by T20. */
export const APP_BUILD_WATCH_RUNNER = Symbol('APP_BUILD_WATCH_RUNNER');

/**
 * _Provisional — T16 (`packages/agent/src/facades/build.facade.ts`)._
 *
 * Every member is **Work-bound**, exactly like `RepositoryWriter`: the resolver
 * already knows the Work's repository, its visibility, the git token, the
 * settings and the plugin id, so a caller never passes them and can never reach a
 * repository the resolver did not resolve. The git token never leaves the
 * resolver, is never logged and is never stored by this service.
 *
 * The members are optional for the same reason §4.1's are: a Wave-3
 * `apps-builder` implementation has no GHCR manifest to check, and a caller
 * materialises the member before calling it.
 */
export interface AppBuildPluginBinding {
    readonly pluginId: string;
    readonly buildKind: AppBuildKind;
    /** The App Work's image repository, or `null` when the plugin produces none. */
    readonly imageRepository: string | null;
    startBuild?(input: {
        readonly buildId: string;
        readonly ref: string;
        readonly sha: string;
        readonly mode: 'build' | 'verify';
        readonly reuseImageDigest?: string;
        readonly verification?: {
            readonly json: string;
            readonly promptedNames: readonly string[];
        };
    }): Promise<{ providerRunId: string | null; dispatchedAt: string } | null>;
    cancelBuild?(input: {
        readonly buildId: string;
        readonly providerRunId: string | null;
    }): Promise<void>;
    checkImageAccess?(input: {
        readonly imageRepository: string;
        readonly tag: string;
        readonly pullToken?: string;
    }): Promise<{
        readonly visibility: 'public' | 'private' | 'unknown';
        readonly readable: boolean;
        readonly tokenScopesOk?: boolean;
        readonly tokenExpiresAt?: string | null;
        readonly digest?: string;
    }>;
}

/**
 * _Provisional — T16 (`BuildFacadeService.resolve(workId, userId)`)._
 *
 * `null` means "this App Work has no build plugin": never a fallback plugin, and
 * never a silent success.
 */
export interface AppBuildPluginResolver {
    resolve(workId: string, userId: string): Promise<AppBuildPluginBinding | null>;
}

/** DI token for {@link AppBuildPluginResolver} — owned by T16. */
export const APP_BUILD_PLUGIN_RESOLVER = Symbol('APP_BUILD_PLUGIN_RESOLVER');

/**
 * _Provisional — the App Works module (APW-01/APW-03)._
 *
 * The six facts a Build row cannot be written without, and nothing else. The
 * intended binding is an adapter over `WorkRepository` (owner), APW-03's
 * `WorkAppSpecState` (`trackedBranch`), `BuildFacadeService` (the plugin id) and
 * the Work's recorded repository coordinates.
 */
export interface AppBuildWorkContext {
    readonly workId: string;
    /** The App Work's owner — the `userId` every event payload and receipt carries. */
    readonly userId: string;
    /** The only branch a Build may run for (FR-14). */
    readonly trackedBranch: string;
    readonly buildPluginId: string;
    /** `owner/repo`, compared case-insensitively — §7.5's fork rule. */
    readonly repositoryFullName: string;
    readonly repositoryVisibility: 'public' | 'private';
}

/** The App Work reader — see {@link AppBuildWorkContext}. */
export interface AppBuildWorkSource {
    read(workId: string): Promise<AppBuildWorkContext | null>;
}

/** DI token for {@link AppBuildWorkSource} — owned by the App Works integration. */
export const APP_BUILD_WORK_SOURCE = Symbol('APP_BUILD_WORK_SOURCE');

/**
 * _Provisional — APW-03 (`AppSpecService.getEffectiveSpec`, `app-spec.service.ts:940`)._
 *
 * The four facts this epic reads: the spec, the commit it is effective at,
 * whether it is valid **at that commit** (§5.1's `specValidAtCommit` clause), and
 * its canonical hash.
 */
export interface AppBuildSpecRead {
    readonly spec: AppSpec | null;
    readonly commitSha: string | null;
    readonly specHash: string | null;
    /** `valid` / `valid_with_warnings` are true; every other status is not valid here. */
    readonly valid: boolean;
}

/** The effective-spec reader. */
export interface AppBuildSpecSource {
    read(workId: string, sha?: string | null): Promise<AppBuildSpecRead | null>;
}

/** DI token for {@link AppBuildSpecSource} — owned by APW-03's module. */
export const APP_BUILD_SPEC_SOURCE = Symbol('APP_BUILD_SPEC_SOURCE');

/**
 * _Provisional — APW-07's `APP_RUNTIME_ENV_SOURCE` (`app-runtime/ports.ts:199`)._
 *
 * Only the value-free `runner` half is declared: the verification plan carries
 * APW-07's recipe and **never a resolved value** (`plan.md:1025-1030`).
 */
export interface AppBuildRunnerRecipeSource {
    resolveEphemeral(
        workId: string,
        specCommitSha: string,
        ctx: { readonly target: 'runner' },
    ): Promise<{
        readonly recipe?: readonly AppEnvRecipeEntry[];
        readonly secretNames: string[];
        readonly unsetRequired: string[];
    }>;
}

/** DI token for {@link AppBuildRunnerRecipeSource} — APW-07's `APP_RUNTIME_ENV_SOURCE`. */
export const APP_BUILD_RUNNER_RECIPE_SOURCE = Symbol('APP_BUILD_RUNNER_RECIPE_SOURCE');

/** _Provisional — the App Works controller's ownership service._ */
export interface AppBuildEditAccess {
    isEditor(workId: string): Promise<boolean>;
}

/** DI token for {@link AppBuildEditAccess}. Unbound ⇒ every viewer is a viewer. */
export const APP_BUILD_EDIT_ACCESS = Symbol('APP_BUILD_EDIT_ACCESS');

/**
 * The consumer half of APW-04's `APP_PROVISION_EVENTS_PORT` that this epic needs
 * (`plan.md:1576-1580`).
 *
 * The **token** is imported from APW-02's provisional declaration
 * (`app-works/app-fork-readiness.service.ts:173`) rather than re-declared here —
 * a second `Symbol('APP_PROVISION_EVENTS_PORT')` would be a different token and
 * APW-04's binding would never reach either injection. Only the member this epic
 * calls is declared; when APW-04 lands its own interface, both files import it.
 */
export interface AppBuildProvisionEventsPort {
    buildUpdated(buildId: string): Promise<void> | void;
}

/* -------------------------------------------------------------------------- *
 * The verification plan (§4.10, APW05-G11)
 * -------------------------------------------------------------------------- */

/**
 * The `--memory` each throwaway dependency container is given by the runner
 * (plan §4.10:1040-1041, "the summed `--memory` of components and dependency
 * containers exceeds 12 GiB").
 *
 * 🛑 These are the numbers the agent-side budget of §4.10 is checked against. T15
 * owns the script that actually passes `--memory`, and its values must equal
 * these; until T15 replaces the T8 interlock (`verify-runner.sh.ts:23-32`) the
 * two are the same table by convention only. Routed as a finding.
 */
export const APP_BUILD_VERIFY_DEPENDENCY_MEMORY_MIB: Readonly<
    Record<AppVerificationDependencyKind, number>
> = {
    postgres: 2048,
    redis: 512,
    objectStorage: 2048,
};

/**
 * The port a verification component is given when the App spec does not declare
 * one.
 *
 * `AppSpecComponent.port` is required for `web` and **forbidden for `worker`**
 * (`app-spec.types.ts:556`), while `verify-plan.schema.json` requires `port` on
 * every component (`minimum: 1`). A worker binds no port, so the plan must still
 * carry one; the runner's readiness probe for a component with no declared port
 * is a liveness wait, so this value is never dialled. Routed as a finding.
 */
export const APP_BUILD_VERIFY_PLAN_PORT_FALLBACK = 8080;

/** Why a verification could not be dispatched, named rather than guessed. */
export type AppVerificationRefusal =
    | 'verificationDependencyUnsupported'
    | 'verificationPlanInvalid'
    | 'verificationPlanTooLarge'
    | 'verificationMemoryTooLarge';

/** Thrown when the plan cannot be built, encoded or dispatched — **before** any dispatch. */
export class AppVerificationPlanRefusedError extends Error {
    constructor(
        readonly reason: AppVerificationRefusal,
        readonly detail: Record<string, string | number | string[]>,
    ) {
        super(`${reason}: ${JSON.stringify(detail)}`);
        this.name = 'AppVerificationPlanRefusedError';
    }
}

/** `'4Gi'` / `'512Mi'` / `'1024'` → MiB, or `null` when it is not a quantity. */
export function parseMemoryQuantityToMiB(quantity: string | undefined | null): number | null {
    if (typeof quantity !== 'string' || quantity.length === 0) return null;
    const match = /^(\d+)(Mi|Gi|M|G)?$/.exec(quantity.trim());
    if (!match) return null;
    const value = Number(match[1]);
    switch (match[2]) {
        case 'Gi':
        case 'G':
            return value * 1024;
        case 'Mi':
        case 'M':
        case undefined:
            return value;
        default:
            return null;
    }
}

/** The `build` block of a plan, or `undefined` when the runner reuses a digest. */
function verificationBuildBlock(spec: AppSpec | null): AppVerificationBuildBlock | undefined {
    const build = spec?.build;
    if (!build) return undefined;
    if (build.strategy !== 'dockerfile' && build.strategy !== 'image') return undefined;
    return {
        strategy: build.strategy,
        ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}),
        ...(build.context ? { context: build.context } : {}),
        ...(build.target ? { target: build.target } : {}),
        ...(build.image ? { image: build.image } : {}),
        ...(build.args && build.args.length > 0
            ? { args: build.args.map((arg) => ({ ...arg })) }
            : {}),
        ...(build.services && build.services.length > 0
            ? {
                  services: build.services.map((service) => ({
                      name: service.name,
                      image: service.image,
                      ...(service.port !== undefined ? { port: service.port } : {}),
                      ...(service.env && service.env.length > 0
                          ? { env: service.env.map((entry) => ({ ...entry })) }
                          : {}),
                  })),
              }
            : {}),
    };
}

/** One App-spec probe projected onto the plan's probe (plan §4.10:1058). */
function verificationProbe(
    probe: AppSpec['components'] extends readonly (infer C)[]
        ? C extends { probes?: infer P }
            ? P extends { startup?: infer S }
                ? S
                : never
            : never
        : never,
): AppVerificationProbe | undefined {
    if (!probe) return undefined;
    const shape = probe as {
        http?: string;
        tcp?: true;
        periodSeconds?: number;
        failureThreshold?: number;
    };
    if (typeof shape.http === 'string') {
        return {
            kind: 'http',
            path: shape.http,
            ...(shape.periodSeconds !== undefined ? { periodSeconds: shape.periodSeconds } : {}),
            ...(shape.failureThreshold !== undefined
                ? { failureThreshold: shape.failureThreshold }
                : {}),
        };
    }
    if (shape.tcp === true) {
        return {
            kind: 'tcp',
            ...(shape.periodSeconds !== undefined ? { periodSeconds: shape.periodSeconds } : {}),
            ...(shape.failureThreshold !== undefined
                ? { failureThreshold: shape.failureThreshold }
                : {}),
        };
    }
    return undefined;
}

/** One App-spec component projected onto the plan (plan §4.10:1058). */
function verificationComponent(component: {
    name: string;
    role: 'web' | 'worker';
    port?: number;
    command?: readonly string[];
    args?: readonly string[];
    writableRootFilesystem?: boolean;
    probes?: { startup?: unknown; readiness?: unknown; liveness?: unknown };
    resources?: { memoryLimit?: string };
}): AppVerificationComponent {
    const memoryMiB = parseMemoryQuantityToMiB(component.resources?.memoryLimit);
    const startup = verificationProbe(component.probes?.startup as never);
    const readiness = verificationProbe(component.probes?.readiness as never);
    const liveness = verificationProbe(component.probes?.liveness as never);
    const probes = {
        ...(startup ? { startup } : {}),
        ...(readiness ? { readiness } : {}),
        ...(liveness ? { liveness } : {}),
    };
    return {
        name: component.name,
        role: component.role,
        port: component.port ?? APP_BUILD_VERIFY_PLAN_PORT_FALLBACK,
        ...(component.command ? { command: [...component.command] } : {}),
        ...(component.args ? { args: [...component.args] } : {}),
        ...(memoryMiB !== null ? { memoryMiB } : {}),
        ...(component.writableRootFilesystem !== undefined
            ? { writableRootFilesystem: component.writableRootFilesystem }
            : {}),
        ...(Object.keys(probes).length > 0 ? { probes } : {}),
    };
}

/** The App spec's `dependencies` projected onto the plan (plan §4.10:1059). */
function verificationDependencies(spec: AppSpec | null): AppVerificationDependency[] {
    const declared = spec?.dependencies;
    if (!declared) return [];
    const dependencies: AppVerificationDependency[] = [];
    if (declared.postgres) {
        dependencies.push({
            kind: 'postgres',
            ...(declared.postgres.version ? { version: declared.postgres.version } : {}),
        });
    }
    if (declared.redis) {
        dependencies.push({
            kind: 'redis',
            ...(declared.redis.version ? { version: declared.redis.version } : {}),
        });
    }
    if (declared.objectStorage) {
        dependencies.push({
            kind: 'objectStorage',
            buckets: [...declared.objectStorage.buckets],
        });
    }
    return dependencies;
}

/** One App-spec job projected onto the plan (plan §4.10:1060). */
function verificationJob(job: AppSpecJob): AppVerificationJob | null {
    if (!(APP_VERIFICATION_JOB_PHASES as readonly string[]).includes(job.when)) {
        // `post-deploy` is manifest-only (plan §3.1:248) and never runs in the
        // verification runner, so it is projected away rather than guessed at.
        return null;
    }
    const when = job.when as AppVerificationJob['when'];
    if (job.command) {
        return {
            when,
            name: job.name,
            ...(job.component ? { component: job.component } : {}),
            command: [...job.command],
            ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
            ...(job.retries !== undefined ? { retries: job.retries } : {}),
        };
    }
    if (job.http) {
        const expectStatus = job.http.expect?.status;
        return {
            when,
            name: job.name,
            ...(job.component ? { component: job.component } : {}),
            http: {
                method: job.http.method ?? 'POST',
                path: job.http.path,
                ...(job.http.body !== undefined ? { body: JSON.stringify(job.http.body) } : {}),
                ...(job.http.authEnv ? { authEnv: job.http.authEnv } : {}),
                ...(job.http.authScheme ? { authScheme: job.http.authScheme } : {}),
                ...(expectStatus && expectStatus.length > 0
                    ? { expectStatus: [...expectStatus] }
                    : {}),
            },
            ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
            ...(job.retries !== undefined ? { retries: job.retries } : {}),
        };
    }
    return null;
}

/** One App-spec smoke entry projected onto the plan (plan §4.10:1061). */
function verificationSmoke(smoke: AppSpecSmoke): AppVerificationSmoke {
    const expect = smoke.expect;
    return {
        name: smoke.name,
        method: smoke.http.method ?? 'GET',
        path: smoke.http.path,
        ...(smoke.component ? { component: smoke.component } : {}),
        ...(smoke.http.body !== undefined ? { body: JSON.stringify(smoke.http.body) } : {}),
        ...(expect
            ? {
                  expect: {
                      ...(expect.status && expect.status.length > 0
                          ? { status: [...expect.status] }
                          : {}),
                      ...(expect.bodyContains && expect.bodyContains.length > 0
                          ? { bodyContains: [...expect.bodyContains] }
                          : {}),
                      ...(expect.bodyNotContains && expect.bodyNotContains.length > 0
                          ? { bodyNotContains: [...expect.bodyNotContains] }
                          : {}),
                      ...(expect.maxLatencyMs !== undefined
                          ? { maxLatencyMs: expect.maxLatencyMs }
                          : {}),
                  },
              }
            : {}),
    };
}

/** Does any `env` entry of the spec reference the `smtp` dependency? */
function needsSmtp(spec: AppSpec | null): boolean {
    for (const entry of spec?.env ?? []) {
        if (typeof entry.from === 'string' && entry.from.startsWith('deps.smtp')) return true;
        if (typeof entry.template === 'string' && entry.template.includes('deps.smtp')) return true;
    }
    return false;
}

/**
 * Build the value-free verification plan of plan §4.10:1055-1063 from the App
 * spec at the requested commit and APW-07's runner recipe.
 *
 * The plan is `additionalProperties: false` at every level
 * (`verify-plan.schema.json`), so every projection below either produces a field
 * the schema declares or omits it — nothing is invented, and nothing the App spec
 * declares is silently dropped except the two documented cases:
 *
 * - a `post-deploy` job is projected away (manifest-only, plan §3.1:248);
 * - a smoke entry's `when` is omitted, because the verification runner is by
 *   construction a first deploy: `always` and `first-deploy` both run there and
 *   the schema's own default (`after-deploy`) is the truthful value.
 *
 * `env` is APW-07's recipe **unchanged** and carries no resolved value: the plan
 * travels in a `workflow_dispatch` input, which the provider shows in the run's
 * UI (`plan.md:1029-1030`).
 *
 * Throws {@link AppVerificationPlanRefusedError} for the one refusal that has a
 * blocked reason — an `smtp` dependency a job or smoke needs (§4.10:1067-1069) —
 * and for a plan that is not a valid plan at all.
 */
export function buildVerificationPlan(input: {
    readonly spec: AppSpec | null;
    readonly envRecipe: readonly AppEnvRecipeEntry[];
    readonly reuseImageDigest?: string;
    readonly verificationTimeoutMinutes?: number;
}): AppVerificationPlan {
    const spec = input.spec;
    if (!spec) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'noEffectiveSpec',
        });
    }

    if (needsSmtp(spec)) {
        throw new AppVerificationPlanRefusedError('verificationDependencyUnsupported', {
            kind: 'smtp',
        });
    }

    const components = (spec.components ?? []).map(verificationComponent);
    if (components.length === 0) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'noComponents',
        });
    }
    if (components.length > APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'tooManyComponents',
            count: components.length,
            max: APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS,
        });
    }

    const dependencies = verificationDependencies(spec);
    if (dependencies.length > APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'tooManyDependencies',
            count: dependencies.length,
            max: APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES,
        });
    }

    const jobs = (spec.jobs ?? [])
        .map(verificationJob)
        .filter((job): job is AppVerificationJob => job !== null);
    if (jobs.length > APP_BUILD_VERIFY_PLAN_MAX_JOBS) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'tooManyJobs',
            count: jobs.length,
            max: APP_BUILD_VERIFY_PLAN_MAX_JOBS,
        });
    }

    const smoke = (spec.smoke ?? []).map(verificationSmoke);
    if (smoke.length > APP_BUILD_VERIFY_PLAN_MAX_SMOKE) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'tooManySmokeEntries',
            count: smoke.length,
            max: APP_BUILD_VERIFY_PLAN_MAX_SMOKE,
        });
    }

    const env = [...input.envRecipe];
    if (env.length > APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES) {
        throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
            reason: 'tooManyEnvEntries',
            count: env.length,
            max: APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES,
        });
    }

    const build = input.reuseImageDigest !== undefined ? undefined : verificationBuildBlock(spec);

    const plan: AppVerificationPlan = {
        version: APP_VERIFICATION_PLAN_VERSION,
        components,
        dependencies,
        jobs,
        smoke,
        env,
        ...(build ? { build } : {}),
    };

    assertVerificationBudget(plan);
    return plan;
}

/** The summed `--memory` of a plan's components and dependency containers (§4.10:1040). */
export function verificationPlanMemoryMiB(plan: AppVerificationPlan): number {
    let total = 0;
    for (const component of plan.components) {
        total += component.memoryMiB ?? 0;
    }
    for (const dependency of plan.dependencies) {
        total += APP_BUILD_VERIFY_DEPENDENCY_MEMORY_MIB[dependency.kind] ?? 0;
    }
    return total;
}

/**
 * The 12 GiB refusal of §4.10:1039-1040 — the agent-side half of the check the
 * embedded script repeats in the runner (`APW05-G11`).
 *
 * It is a **throw**, not a blocked Build: no `AppBuildBlockedReason` names this
 * condition, and putting a value the web cannot render into
 * `work_builds.blockedReason` is worse than refusing the call.
 */
export function assertVerificationBudget(plan: AppVerificationPlan): void {
    const total = verificationPlanMemoryMiB(plan);
    const max = APP_BUILD_VERIFY_MEMORY_GIB * 1024;
    if (total > max) {
        throw new AppVerificationPlanRefusedError('verificationMemoryTooLarge', {
            memoryMiB: total,
            maxMiB: max,
        });
    }
}

/* -------------------------------------------------------------------------- *
 * Result shapes
 * -------------------------------------------------------------------------- */

/** The `requestRebuild` refusal codes of plan §5:1202-1205. */
export type AppBuildRebuildRefusal = 'rebuildRateLimited' | 'commitNotReachable' | 'nothingToBuild';

/** What `requestRebuild` answers. */
export type AppBuildRebuildResult =
    | { readonly ok: true; readonly build: WorkBuild; readonly deduped: boolean }
    | {
          readonly ok: false;
          readonly code: AppBuildRebuildRefusal;
          readonly retryAfterMinutes?: number;
      };

/** What `cancel` answers. */
export type AppBuildCancelResult =
    | { readonly ok: true; readonly build: WorkBuild }
    | { readonly ok: false; readonly code: 'notCancellable' | 'buildNotFound' };

/** What `startVerification` answers. */
export interface AppBuildStartVerificationResult {
    readonly buildId: string;
    /** `true` when the verification was refused before dispatch and the Build is `blocked`. */
    readonly blocked: boolean;
    readonly blockedReason?: AppBuildBlockedReason;
}

/** `startVerification`'s argument (`plan.md:1071`). */
export interface AppBuildVerificationRequest {
    readonly ref: string;
    readonly sha: string;
    readonly reuseImageDigest?: string;
}

/** What `finalize` answers. */
export interface AppBuildFinalizeResult {
    readonly finalized: boolean;
    readonly reason: 'finalized' | 'notTerminal' | 'alreadyFinalized' | 'notFound';
    readonly build: WorkBuild | null;
    readonly deployable: boolean;
    readonly notDeployableReason: AppBuildNotDeployableReason | null;
}

/**
 * APW-05 T14 remainder — evidence about a Build's image that arrives with an
 * observation rather than from its row.
 *
 * `pushLogDigest` is `BuildSnapshot.image.pushLogDigest`: the digest the build
 * job's Push step logged. It is weighed only when the registry ANSWERS that the
 * image cannot be read (plan §4.8's no-token fallback) — never when the registry
 * read fails, and never when there is no registry read at all. There is no
 * column for it: {@link AppBuildsService.applySnapshot} hands it to `finalize`
 * with the terminal snapshot it arrived in, and a later
 * {@link AppBuildsService.reconfirmDigest} is given it again by its caller.
 */
export interface AppBuildDigestEvidence {
    readonly pushLogDigest?: string;
}

/**
 * How long `finalize` (and `reconfirmDigest`) wait for the registry read of T14's
 * digest confirmation before treating it as unconfirmed.
 *
 * `checkImageAccess` sends up to two requests to ghcr.io (the anonymous `/token`,
 * then the manifest `HEAD`) with no signal of their own, and `finalize` runs after
 * the terminal claim inside the watch lease (`APP_BUILD_WATCH_LEASE_MS`, two
 * minutes). A hung registry therefore costs the confirmation, exactly like a read
 * that throws — never the settlement, and never the lease.
 */
export const APP_BUILD_DIGEST_READ_TIMEOUT_MS = 15_000;

/**
 * Whether an observation keeps the row's commit rather than the run's `head_sha`.
 *
 * The platform dispatches a `manual` or `verification` Build with the row's own
 * `commitSha` as `ew_sha`, and the workflow checks out and tags exactly that
 * commit (`sha-<ew_sha>`). A `workflow_dispatch` run's `head_sha` is the tracked
 * branch's head at dispatch time instead, so for a Build of an older commit it
 * names a commit that was not built — and T14 would then read the wrong `sha-`
 * tag, which exists with another digest whenever a push Build built the head
 * (a false `digestMismatch` that a Rebuild of the same commit only repeats).
 */
function keepsDispatchedCommit(row: WorkBuild): boolean {
    return (row.trigger === 'manual' || row.trigger === 'verification') && Boolean(row.commitSha);
}

/**
 * The image fields one observation writes.
 *
 * The snapshot's `confirmed` flag and repository are the plugin's (the
 * github-actions plugin reports every digest `confirmed: false`, spelled as the
 * artifact spelled it); a confirmation is the PLATFORM's (`confirmDigest`, which
 * also pins `imageRepository` to the derived repository APW-06's deploy reference
 * is built from). The watch runner delivers a terminal snapshot more than once,
 * and the observation is written before the terminal claim refuses the repeat,
 * so a repeat that copied those fields would undo the confirmation with nothing
 * left to redo it. A confirmed row observed with the SAME digest therefore keeps
 * its repository, digest and confirmation; a different digest is a different
 * claim, and is taken unconfirmed.
 */
function observedImage(
    row: WorkBuild,
    image: NonNullable<BuildSnapshot['image']>,
): Partial<WorkBuild> {
    if (row.digestConfirmed && row.imageDigest === image.digest) {
        return { imageTags: image.tags };
    }
    return {
        imageRepository: image.repository,
        imageDigest: image.digest,
        imageTags: image.tags,
        digestConfirmed: image.confirmed,
    };
}

/**
 * `read`, or a rejection once {@link APP_BUILD_DIGEST_READ_TIMEOUT_MS} passes with
 * no answer. The read itself is not cancelled (the binding takes no signal); its
 * late answer is simply ignored, and `Promise.race` has already subscribed to it,
 * so a late rejection is not an unhandled one.
 */
async function withinDigestReadTimeout<T>(read: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`no answer within ${APP_BUILD_DIGEST_READ_TIMEOUT_MS} ms`)),
            APP_BUILD_DIGEST_READ_TIMEOUT_MS,
        );
        // Never the reason a worker process stays alive.
        timer.unref?.();
    });
    try {
        return await Promise.race([read, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * What `reconfirmDigest` answers.
 *
 * `reconfirmed` means the digest is confirmed now and the verdict was settled
 * again — which can still be `deployable: false` when another clause no longer
 * holds (the build values rotated since, say). `unconfirmed` means the row was
 * left `digestUnconfirmed` (with `failureClass: 'digestMismatch'` recorded when
 * the registry reported a different digest).
 */
export interface AppBuildReconfirmResult {
    readonly reconfirmed: boolean;
    readonly reason: 'reconfirmed' | 'notFound' | 'notDigestUnconfirmed' | 'unconfirmed';
    readonly build: WorkBuild | null;
    readonly deployable: boolean;
    readonly notDeployableReason: AppBuildNotDeployableReason | null;
}

/** Why a provider run produced no Build — the accept rules of §7.5. */
export type AppBuildRunRefusal =
    | 'unknownWork'
    | 'strategyNotBuilt'
    | 'forkPullRequestHead'
    | 'manualRunUncorrelated';

/** What `recordProviderRun` answers. */
export type AppBuildRecordRunResult =
    | { readonly accepted: true; readonly build: WorkBuild; readonly created: boolean }
    | { readonly accepted: false; readonly reason: AppBuildRunRefusal };

/** The terminal statuses — a Build that reached one of these is done (§7.3). */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/** How many pages of the Builds list the rebuild-rate scan reads. */
export const REBUILD_SCAN_MAX_PAGES = 10;

/** Is this a terminal `work_builds.status`? */
export function isTerminalBuildStatus(status: string): boolean {
    return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The Activity status a Build transition records (R-34's `status` half). */
function activityStatusFor(status: string): ActivityStatus {
    switch (status) {
        case 'queued':
            return ActivityStatus.PENDING;
        case 'running':
            return ActivityStatus.IN_PROGRESS;
        case 'succeeded':
            return ActivityStatus.COMPLETED;
        case 'failed':
            return ActivityStatus.FAILED;
        case 'cancelled':
            return ActivityStatus.CANCELLED;
        default:
            return ActivityStatus.PENDING;
    }
}

/** A Build row's event payload — names and ids only (`plan.md:1547-1549`). */
function buildEventPayload(
    build: WorkBuild,
    userId: string,
    deployable: boolean,
    notDeployableReason: AppBuildNotDeployableReason | null,
): AppBuildEventPayload {
    return {
        workId: build.workId,
        userId,
        buildId: build.id,
        number: build.number,
        status: build.status,
        trigger: build.trigger,
        branch: build.branch,
        commitSha: build.commitSha,
        pullRequestNumber: build.pullRequestNumber ?? null,
        deployable,
        notDeployableReason,
        imageDigest: build.imageDigest ?? null,
        failureClass: (build.failureClass as AppBuildEventPayload['failureClass']) ?? null,
        cancelReason: build.cancelReason ?? null,
    };
}

/** The Builds-list row of plan §3.2 (`contracts/…/builds.ts:907`). */
export function toAppBuildSummary(build: WorkBuild): AppBuildSummary {
    return {
        id: build.id,
        number: build.number,
        status: build.status,
        trigger: build.trigger,
        branch: build.branch,
        commitSha: build.commitSha,
        pullRequestNumber: build.pullRequestNumber ?? null,
        blockedReason: build.blockedReason ?? null,
        blockedDetail: build.blockedDetail ?? null,
        deployable: build.deployable,
        notDeployableReason:
            (build.notDeployableReason as AppBuildNotDeployableReason | null | undefined) ?? null,
        imageRepository: build.imageRepository ?? null,
        imageDigest: build.imageDigest ?? null,
        imageTags: build.imageTags ?? [],
        failureClass: (build.failureClass as AppBuildSummary['failureClass']) ?? null,
        queuedAt: build.queuedAt ? build.queuedAt.toISOString() : null,
        startedAt: build.startedAt ? build.startedAt.toISOString() : null,
        completedAt: build.completedAt ? build.completedAt.toISOString() : null,
        durationSeconds: build.durationSeconds ?? null,
        logsUrl: build.logsUrl ?? null,
    };
}

/**
 * APW-05 T17 — `AppBuildsService`: one service that owns a Build's whole life.
 *
 * Spec: `…/APW-05-builds/spec.md` (FR-17 the row, FR-31 the verdict, FR-34/35 the
 * two intake paths, FR-41 Rebuild, FR-42 dedupe, FR-54 verification). Plan: §7.2
 * (`requestPrepare` and the `prepareSeq` marker), §7.5 (the shared accept rules),
 * §7.8 (the single Activity + event writer and the status → event map), §5.1 (the
 * verdict) and §7.1 (the null-dispatch fallback).
 *
 * ## One writer, one receipt, one terminal event
 *
 * Plan §7.8:1569-1573 is the rule this class exists to keep: "One helper,
 * `AppBuildsService.publish(build, event)`. It writes the Activity row, emits
 * through `EventEmitter2`, and calls APW-04's
 * `APP_PROVISION_EVENTS_PORT.buildUpdated(buildId)`. These are the only emission
 * points." Every transition below goes through {@link publish}; this file
 * contains no other `emitter.emit`, no other `activityLog.log` and no other
 * `provisionEvents.buildUpdated`.
 *
 * ## The verdict is computed here and nowhere else
 *
 * {@link finalize} computes the verdict (through `verdictFor`, the only caller of
 * `evaluateBuildVerdict`) and writes `deployable` + `notDeployableReason` in the
 * same patch as `completedAt`. "The verdict, recomputed at completion (§5.1) —
 * never set before then" (`work-build.entity.ts:228-230`) is therefore true by
 * construction. The one other writer is {@link reconfirmDigest}, and it only
 * re-settles a verdict `finalize` already wrote as `digestUnconfirmed` (§7.4's
 * recheck), through the same helper.
 *
 * ## The digest is confirmed here, never believed (plan §4.8, T14)
 *
 * The build plugin reports the artifact's digest `confirmed: false`: it is the
 * member's own CI's claim. {@link finalize} reads the image through the
 * binding's `checkImageAccess` and only an equal registry digest (or, when the
 * registry answers that it cannot be read, an equal Push-step log digest)
 * confirms it — see `confirmDigest`.
 *
 * ## Idempotency: the terminal claim, then the verdict guard
 *
 * {@link applySnapshot} claims the terminal transition with ONE conditional
 * UPDATE — `status NOT IN (succeeded, failed, cancelled) OR "completedAt" IS
 * NULL` — and only the call that moves a row calls {@link finalize}, which itself
 * refuses when the verdict is already settled (`deployable === true ||
 * notDeployableReason !== null`). Together those make "the terminal transition
 * finalises exactly once across 3 deliveries" a property of the row rather than
 * of a lease:
 *
 * - a Build the owner cancelled (`cancel` leaves `completedAt` NULL on purpose)
 *   still finalises on the next observation — that is ACC-05-09's sequence;
 * - a Build the sweep failed as `lost` (`markLost` writes `status` +
 *   `completedAt` and no verdict) still finalises, because the guard is the
 *   verdict and not the status.
 *
 * ## Additive by design: unlanded collaborators are optional ports
 *
 * T16 (the facade), T18 (the two dispatchers), T19/T20 (the two runners), APW-03's
 * spec reader, APW-07's runner recipe, APW-04's port and the controller's edit
 * check all have their own tasks. Every one of them is injected `@Optional()`
 * behind a token declared in this file with the mandatory-swap note above, so
 * this service compiles and is testable on its own and **no placeholder is ever
 * bound** — binding one would make an unconfigured installation look configured,
 * which is the failure mode APW-02's module docstring calls out.
 *
 * ## What is deliberately NOT here
 *
 * `releaseRepository` (§7.7) is T19a's; the `AppBuildsListener` (§7.6), the
 * `app-build-*` runners, the jobs and `AppBuildSweepService` are T18-T21's. This
 * class owns the Build row's life and the entry points the plan names for it.
 */
@Injectable()
export class AppBuildsService {
    private readonly logger = new Logger(AppBuildsService.name);

    /**
     * In-process fallback runs in flight, so a slow dispatcher cannot pile them
     * up. `rerun` marks a prepare that was asked for while its Work's run was in
     * flight (see {@link runInProcess}).
     */
    private readonly inProcessRuns = new Map<string, { rerun: boolean }>();

    constructor(
        private readonly builds: AppBuildRepository,
        private readonly preparations: AppBuildPreparationRepository,
        // The entity's own repository, for the two conditional claims and the field
        // patches this service performs. `AppBuildRepository` owns the number
        // arithmetic and the run-identity upsert; it exposes no generic patch, and
        // this service is where a snapshot becomes a row. Routed as a finding: a
        // `patch(id, fields)` there would replace the private helpers below.
        @Optional()
        @InjectRepository(WorkBuild)
        private readonly rows?: Repository<WorkBuild>,
        @Optional()
        private readonly activityLog?: ActivityLogService,
        @Optional()
        private readonly emitter?: EventEmitter2,
        @Optional()
        private readonly usage?: PluginUsageService,
        @Optional()
        @Inject(APP_ENV_RESOLVER_FINGERPRINTS)
        private readonly fingerprints?: AppEnvResolvedFingerprints,
        // 🛑 The token is APW-02's provisional declaration, imported rather than
        // re-declared — see {@link AppBuildProvisionEventsPort}.
        @Optional()
        @Inject(APP_PROVISION_EVENTS_PORT)
        private readonly provisionEvents?: AppBuildProvisionEventsPort,
        @Optional()
        @Inject(APP_BUILD_PLUGIN_RESOLVER)
        private readonly plugins?: AppBuildPluginResolver,
        @Optional()
        @Inject(APP_BUILD_WORK_SOURCE)
        private readonly works?: AppBuildWorkSource,
        @Optional()
        @Inject(APP_BUILD_SPEC_SOURCE)
        private readonly specs?: AppBuildSpecSource,
        @Optional()
        @Inject(APP_BUILD_RUNNER_RECIPE_SOURCE)
        private readonly runnerRecipe?: AppBuildRunnerRecipeSource,
        @Optional()
        @Inject(APP_BUILD_PREPARE_DISPATCHER)
        private readonly prepareDispatcher?: AppBuildPrepareDispatcher,
        @Optional()
        @Inject(APP_BUILD_WATCH_DISPATCHER)
        private readonly watchDispatcher?: AppBuildWatchDispatcher,
        @Optional()
        @Inject(APP_BUILD_PREPARE_RUNNER)
        private readonly prepareRunner?: AppBuildPrepareRunner,
        @Optional()
        @Inject(APP_BUILD_WATCH_RUNNER)
        private readonly watchRunner?: AppBuildWatchRunner,
        @Optional()
        @Inject(APP_BUILD_EDIT_ACCESS)
        private readonly editAccess?: AppBuildEditAccess,
    ) {}

    /* ---------------------------------------------------------------------- *
     * §7.2 — requestPrepare and the prepareSeq marker
     * ---------------------------------------------------------------------- */

    /**
     * Ask for a prepare, durably, and then dispatch it (`plan.md:1366-1382`).
     *
     * Plan §7.2's ordering is the whole method: "It first saves its own durable
     * change …, then bumps the preparation row's `prepareSeq` (§3.1b), and only
     * after that dispatches." The caller's own write has already happened by the
     * time it calls this, so what is left is the bump and the dispatch.
     *
     * The bump is a read-then-merge through
     * `AppBuildPreparationRepository.upsertAfterPrepare`, whose docstring hands
     * this path the column: "`prepareSeq` is deliberately NOT touched here …
     * Whoever lands `requestPrepare` owns it." A Work with **no** preparation row
     * has nothing to coalesce with yet — the row is created by the first prepare
     * (§7.2 step 1) — so this answers `prepareSeq: 0` and still dispatches; the
     * next request bumps the row that pass wrote.
     */
    async requestPrepare(
        workId: string,
        reason: AppBuildPrepareReason,
        buildId?: string,
    ): Promise<{ readonly prepareSeq: number; readonly dispatched: boolean }> {
        const prepareSeq = await this.bumpPrepareSeq(workId);
        const payload: AppBuildPrepareJobPayload = {
            workId,
            reason,
            ...(buildId ? { buildId } : {}),
        };
        const dispatched = await this.dispatchPrepare(payload);
        return { prepareSeq, dispatched };
    }

    /**
     * The `prepareSeq` bump of §7.2 — read, merge, write. No row ⇒ nothing to bump.
     *
     * Never throws: the requester's own durable write is already committed, so a
     * failure to READ or to advance the coalescing marker must cost the marker,
     * never the request — the caller dispatches either way. The answer is the
     * marker after the bump, the old marker when only the write failed, and `0`
     * when the row could not be read at all.
     *
     * The merge names `prepareSeq` ALONE. The row's other columns belong to the
     * prepare, which writes them without this path's lock; echoing back a
     * `buildPluginId` read before a racing prepare changed it would revert that
     * prepare. `buildPluginId` is only needed to CREATE a row, and a Work with no
     * row returns before the write.
     */
    private async bumpPrepareSeq(workId: string): Promise<number> {
        let row: WorkBuildPreparation | null;
        try {
            row = await this.preparations.findByWork(workId);
        } catch (error) {
            this.logger.warn(
                `App builds: reading prepareSeq for work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the prepare is still dispatched.`,
            );
            return 0;
        }
        if (!row) {
            return 0;
        }
        const next = (row.prepareSeq ?? 0) + 1;
        try {
            await this.preparations.upsertAfterPrepare(workId, { prepareSeq: next });
            return next;
        } catch (error) {
            this.logger.warn(
                `App builds: bumping prepareSeq for work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the prepare is still dispatched.`,
            );
            return row.prepareSeq ?? 0;
        }
    }

    /**
     * Dispatch `app-build-prepare`, falling back to the runner in process
     * (`plan.md:1321-1331`, `APW05-G20`).
     *
     * When the dispatcher returns `null` — the job runtime is not configured (the
     * local e2e stack) or is unreachable — the runner runs **in this process**,
     * never awaited by the request, with `void run().catch(log)`. Overlap is
     * guarded by exactly the same `app-build-prepare:<workId>` lock the job takes,
     * so an in-process run and a dispatched one cannot double-fire; that is why
     * this method needs no lock of its own.
     *
     * @returns `true` when a runtime took the dispatch.
     */
    async dispatchPrepare(payload: AppBuildPrepareJobPayload): Promise<boolean> {
        const runId = await this.tryDispatch(() =>
            this.prepareDispatcher?.dispatchAppBuildPrepare(payload),
        );
        if (runId !== null) {
            return true;
        }
        this.runInProcess(
            'prepare',
            payload.workId,
            () => this.prepareRunner?.run(payload),
            // The one re-run a request that met a run in flight earns (§7.2's
            // coalesced dispatch): the Builds come from the database, so the
            // reason is all it needs.
            () => this.prepareRunner?.run({ workId: payload.workId, reason: 'coalesced' }),
        );
        return false;
    }

    /** Dispatch `app-build-watch`, falling back to the runner in process (§7.1). */
    async dispatchWatch(payload: AppBuildWatchJobPayload): Promise<boolean> {
        const runId = await this.tryDispatch(() =>
            this.watchDispatcher?.dispatchAppBuildWatch(payload),
        );
        if (runId !== null) {
            return true;
        }
        this.runInProcess('watch', payload.buildId, () => this.watchRunner?.run(payload));
        return false;
    }

    /** `null` covers "unbound" and "the runtime refused", which §7.1 treats identically. */
    private async tryDispatch(
        call: () => Promise<string | null> | undefined,
    ): Promise<string | null> {
        try {
            return (await call()) ?? null;
        } catch (error) {
            this.logger.warn(
                `App builds: the job runtime refused a dispatch (${
                    error instanceof Error ? error.message : String(error)
                }); running it in process.`,
            );
            return null;
        }
    }

    /**
     * `void run().catch(log)` — fired and forgotten on purpose (`plan.md:1325-1326`).
     *
     * `job + ':' + key` keeps at most one in-process fallback per subject alive at a
     * time; for watch that is §7.1's "capped at 10 concurrent runs per API process"
     * with the excess left to the next sweep tick, which already covers every
     * silent non-terminal Build (§7.4).
     *
     * A PREPARE asked for while its Work's run is in flight is not dropped: it
     * marks the run, and when the run settles `rerun` runs once more (however many
     * requests marked it). Dropping it lost the request whenever the run had
     * already taken its last `prepareSeq` reading — including the runner's OWN
     * coalesced dispatch, which is always made from inside the run that holds the
     * marker. The re-run is never concurrent with the run it follows, so the
     * §7.2 lock is not what keeps the two apart. A watch keeps the drop: the sweep
     * re-drives it.
     */
    private runInProcess(
        job: 'prepare' | 'watch',
        key: string,
        call: () => Promise<unknown> | undefined,
        rerun?: () => Promise<unknown> | undefined,
    ): void {
        const marker = `${job}:${key}`;
        const inFlight = this.inProcessRuns.get(marker);
        if (inFlight) {
            if (rerun) inFlight.rerun = true;
            return;
        }
        const state = { rerun: false };
        this.inProcessRuns.set(marker, state);
        void (async () => {
            try {
                await this.settleInProcess(job, key, call);
                while (rerun && state.rerun) {
                    state.rerun = false;
                    await this.settleInProcess(job, key, rerun);
                }
            } finally {
                this.inProcessRuns.delete(marker);
            }
        })();
    }

    /** One in-process run, its failure logged rather than thrown. */
    private async settleInProcess(
        job: 'prepare' | 'watch',
        key: string,
        call: () => Promise<unknown> | undefined,
    ): Promise<void> {
        try {
            await call();
        } catch (error) {
            this.logger.warn(
                `App builds: the in-process ${job} run for ${key} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * §7.5 — recordProviderRun, the shared accept rules
     * ---------------------------------------------------------------------- */

    /**
     * Record one provider run — the ONE entry point for both intake paths
     * (`plan.md:1458-1465`).
     *
     * "The rules are identical whichever path found the run": the webhook consumer
     * (§7.5) maps a delivery to a `BuildRunRef` and calls this with
     * `source: 'event'`; run discovery (§7.4a) calls it with `source: 'poll'`. The
     * two converge on one row through `uq_work_builds_provider_run`, and
     * `app.build.queued` is published once.
     *
     * The strategy gate ("runs are ignored while the applied `build.strategy` is
     * `image`, `none` or `auto`") and the fork rule ("a `pull_request` run whose
     * head repository differs creates no Build", ACC-05-06) live here rather than in
     * a consumer, so a second consumer cannot reintroduce them differently.
     */
    async recordProviderRun(
        workId: string,
        run: BuildRunRef,
        source: AppBuildRunSource,
    ): Promise<AppBuildRecordRunResult> {
        const context = await this.readWork(workId);
        if (!context) {
            return { accepted: false, reason: 'unknownWork' };
        }

        const spec = await this.readSpec(workId, run.headSha);
        const strategy = spec?.spec?.build?.strategy ?? 'dockerfile';
        if (strategy === 'image' || strategy === 'none' || strategy === 'auto') {
            // Checks-only runs (§4.14): the image comes from elsewhere, so a run of
            // the build workflow records no Build.
            return { accepted: false, reason: 'strategyNotBuilt' };
        }

        if (run.event === 'pull_request') {
            const head = (run.headRepositoryFullName ?? '').toLowerCase();
            if (head && head !== context.repositoryFullName.toLowerCase()) {
                return { accepted: false, reason: 'forkPullRequestHead' };
            }
        }

        if (run.event === 'manual') {
            return this.adoptManualRun(workId, run, source);
        }

        const trigger: AppBuildTrigger = run.event === 'pull_request' ? 'pull_request' : 'push';
        const queuedAt = parseRunInstant(run.createdAt);
        const runIdentity = {
            buildPluginId: context.buildPluginId,
            providerRunId: run.providerRunId,
            runAttempt: run.runAttempt,
        };
        const patch = {
            branch: run.headBranch,
            commitSha: run.headSha,
            ...(trigger === 'pull_request' && run.pullRequestNumber !== undefined
                ? { pullRequestNumber: run.pullRequestNumber }
                : {}),
            ...(queuedAt ? { queuedAt } : {}),
        } satisfies Partial<WorkBuild>;

        // A run the platform already knows about: the row exists, so this is an
        // UPDATE and never a second Build — and the row's OWN progress is kept. A
        // blanket patch here would let a poll of a finished run move a `succeeded`
        // Build back to `running`, which is why the status only ever advances
        // (`queued` → `running`) and never returns.
        const known = await this.findRunRow(workId, context.buildPluginId, run);
        if (known) {
            const mapped = run.status === 'queued' ? 'queued' : 'running';
            const advanced = statusRank(mapped) > statusRank(known.status) ? mapped : known.status;
            const row = await this.persist(known, {
                ...patch,
                ...(advanced !== known.status ? { status: advanced } : {}),
            });
            await this.dispatchWatch({
                buildId: row.id,
                reason: source === 'poll' ? 'sweep' : 'event',
            });
            return { accepted: true, build: row, created: false };
        }

        const { build, created } = await this.builds.upsertByProviderRun(
            workId,
            {
                ...runIdentity,
                ...patch,
                // §7.8:1553 — the insert publishes `app.build.queued`, so a Build row
                // is born `queued` whatever the run's own status already is; the
                // observations that follow are what move it.
                status: 'queued',
                trigger,
            },
            // §7.5:1467-1470 — the three secret-sync columns travel with the insert,
            // in the same transaction, so the verdict sees the values the run read.
            { stampFromPreparation: true },
        );

        if (created) {
            await this.publish(build, 'app.build.queued');
        }
        await this.dispatchWatch({
            buildId: build.id,
            reason: source === 'poll' ? 'sweep' : 'event',
        });

        return { accepted: true, build, created };
    }

    /**
     * The row a run identity already owns, or `null` — the read that tells an insert
     * from an update.
     *
     * `AppBuildRepository` keeps its run-identity lookup private (`findByProviderRun`,
     * `app-build.repository.ts:453`) and this task does not own that file, so the
     * identity is matched over the newest pages of the Builds list. Bounded at
     * {@link REBUILD_SCAN_MAX_PAGES}; the create path below still goes through the
     * repository's race-safe `upsertByProviderRun`, so a run discovered twice at once
     * converges on one row even when this scan misses.
     * Routed as a finding: making that lookup public replaces this scan.
     */
    private async findRunRow(
        workId: string,
        buildPluginId: string,
        run: BuildRunRef,
    ): Promise<WorkBuild | null> {
        for (let page = 1; page <= REBUILD_SCAN_MAX_PAGES; page += 1) {
            const result = await this.builds.findPage(
                workId,
                {},
                page,
                APP_BUILD_LIST_MAX_PAGE_SIZE,
            );
            const hit = result.rows.find(
                (row) =>
                    row.buildPluginId === buildPluginId &&
                    row.providerRunId === run.providerRunId &&
                    row.runAttempt === run.runAttempt,
            );
            if (hit) return hit;
            if (!result.hasMore) break;
        }
        return null;
    }

    /**
     * Adopt a correlated manual run by `display_title` (`plan.md:1450`, §7.5:1463).
     *
     * The dispatch correlation id is what a manual or verification Build writes
     * into `dispatchCorrelationId` at insert — the value `startBuild` puts in the
     * run's display title — so adoption finds the open `manual` Build whose
     * correlation the title carries. **An adopted run publishes no second
     * `queued`** (`plan.md:1564`): the row already published one at insert.
     */
    private async adoptManualRun(
        workId: string,
        run: BuildRunRef,
        source: AppBuildRunSource,
    ): Promise<AppBuildRecordRunResult> {
        const candidate = await this.findUnadoptedManual(workId, run.displayTitle);
        if (!candidate) {
            return { accepted: false, reason: 'manualRunUncorrelated' };
        }

        const adopted = await this.persist(candidate, {
            providerRunId: run.providerRunId,
            runAttempt: run.runAttempt,
            status: run.status === 'queued' ? 'queued' : 'running',
            ...(run.headBranch ? { branch: run.headBranch } : {}),
            ...(run.headSha ? { commitSha: run.headSha } : {}),
        });

        await this.dispatchWatch({
            buildId: adopted.id,
            reason: source === 'poll' ? 'sweep' : 'event',
        });
        return { accepted: true, build: adopted, created: false };
    }

    /** The newest open `manual` Build of this Work whose correlation the title carries. */
    private async findUnadoptedManual(
        workId: string,
        displayTitle: string,
    ): Promise<WorkBuild | null> {
        const title = displayTitle ?? '';
        for (let page = 1; page <= REBUILD_SCAN_MAX_PAGES; page += 1) {
            const result = await this.builds.findPage(
                workId,
                { trigger: ['manual'] },
                page,
                APP_BUILD_LIST_MAX_PAGE_SIZE,
            );
            for (const row of result.rows) {
                if (row.providerRunId) continue;
                const correlation = row.dispatchCorrelationId ?? row.id;
                if (title.includes(correlation) || title.includes(row.id)) return row;
            }
            if (!result.hasMore) break;
        }
        return null;
    }

    /* ---------------------------------------------------------------------- *
     * FR-41/FR-42 — requestRebuild: 10 s dedupe, 10 per hour
     * ---------------------------------------------------------------------- */

    /**
     * Request a Rebuild (FR-41, ACC-05-08).
     *
     * The 10-second dedupe is FR-42's: a second request for the same commit inside
     * `APP_BUILD_REBUILD_DEDUPE_MS` returns the Build that already exists rather
     * than dispatching a second time. The hourly limit is
     * `APP_BUILD_REBUILDS_PER_HOUR`; the 11th answers `rebuildRateLimited` with
     * `retryAfterMinutes`, counted from the OLDEST rebuild inside the window so the
     * answer is a real wait and not a rounded-up hour.
     *
     * ⚠️ **The insert is the last thing that is awaited.** The prepare request is
     * fired with `void …` (see {@link dispatchPrepare}), which is what keeps FR-41's
     * two-second budget when the job runtime is slow. It goes through
     * {@link requestPrepare}, so §7.2's order holds inside that unawaited chain:
     * the Build row (the durable change), then the `prepareSeq` bump, then the
     * dispatch. Without the bump a Rebuild whose dispatch met a running pass was
     * answered `locked` and waited for an unrelated prepare.
     */
    async requestRebuild(
        workId: string,
        userId: string,
        options: { readonly commitSha?: string } = {},
    ): Promise<AppBuildRebuildResult> {
        const context = await this.readWork(workId);
        if (!context) {
            return { ok: false, code: 'nothingToBuild' };
        }

        const spec = await this.readSpec(workId, options.commitSha ?? null);
        const strategy = spec?.spec?.build?.strategy ?? 'dockerfile';
        if (strategy === 'image' || strategy === 'none' || strategy === 'auto') {
            return { ok: false, code: 'nothingToBuild' };
        }

        const commitSha = options.commitSha ?? spec?.commitSha ?? null;
        if (!commitSha) {
            return { ok: false, code: 'commitNotReachable' };
        }

        const now = Date.now();

        const recent = await this.builds.findRecentForCommit(
            workId,
            commitSha,
            now - APP_BUILD_REBUILD_DEDUPE_MS,
        );
        if (recent) {
            return { ok: true, build: recent, deduped: true };
        }

        const rebuilt = await this.countRebuildsSince(workId, now - 3_600_000);
        if (rebuilt.length >= APP_BUILD_REBUILDS_PER_HOUR) {
            const oldest = rebuilt[rebuilt.length - 1].createdAt?.getTime() ?? now;
            const waitMs = Math.max(0, oldest + 3_600_000 - now);
            return {
                ok: false,
                code: 'rebuildRateLimited',
                retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)),
            };
        }

        const build = await this.builds.insertWithNextNumber(workId, {
            buildPluginId: context.buildPluginId,
            status: 'queued',
            trigger: 'manual',
            branch: context.trackedBranch,
            commitSha,
            dispatchCorrelationId: randomUUID(),
            queuedAt: new Date(now),
            triggeredByUserId: userId,
        });

        await this.publish(build, 'app.build.queued');

        // 🛑 Not awaited — FR-41's two-second budget. See the method docstring.
        // Through `requestPrepare`, so the `prepareSeq` bump lands BEFORE the
        // dispatch: a pass already holding the Work's lock then sees this Rebuild
        // when it re-reads the marker, even though this dispatch answers `locked`.
        void this.requestPrepare(workId, 'rebuild', build.id).catch((error: unknown) =>
            this.logger.warn(
                `App builds: the prepare of Rebuild ${build.id} (work ${workId}) could not be requested (${
                    error instanceof Error ? error.message : String(error)
                }); the Build stays queued for the next prepare.`,
            ),
        );

        return { ok: true, build, deduped: false };
    }

    /**
     * The `manual` builds this App Work created inside the hourly window, oldest
     * first.
     *
     * `AppBuildRepository` has no "created since" count and this task does not own
     * that file, so the window is read through `findPage` — which is ordered
     * `createdAt DESC` — and the scan stops as soon as it walks past the cutoff.
     * Bounded at {@link REBUILD_SCAN_MAX_PAGES} pages: a Work with more manual
     * Builds than that inside an hour is already far over the limit, so the answer
     * can only be wrong in the direction of refusing a rebuild the owner could not
     * have been granted anyway. Routed as a finding.
     */
    private async countRebuildsSince(workId: string, sinceMs: number): Promise<WorkBuild[]> {
        const found: WorkBuild[] = [];
        for (let page = 1; page <= REBUILD_SCAN_MAX_PAGES; page += 1) {
            const result = await this.builds.findPage(
                workId,
                { trigger: ['manual'] },
                page,
                APP_BUILD_LIST_MAX_PAGE_SIZE,
            );
            for (const row of result.rows) {
                if ((row.createdAt?.getTime() ?? 0) >= sinceMs) found.push(row);
            }
            const oldestOnPage = result.rows[result.rows.length - 1]?.createdAt?.getTime() ?? 0;
            if (!result.hasMore || oldestOnPage < sinceMs) break;
        }
        return found;
    }

    /* ---------------------------------------------------------------------- *
     * Cancel (ACC-05-09)
     * ---------------------------------------------------------------------- */

    /**
     * Cancel one Build (plan §5:1199, ACC-05-09).
     *
     * A terminal or blocked Build is `notCancellable` and the provider is never
     * called for it. Otherwise the row is marked `cancelled` with
     * `cancelReason: 'user'` and **`completedAt` left NULL on purpose**: the next
     * observation is what finalises it (§7.3) — that is exactly ACC-05-09's
     * sequence, and the terminal claim in {@link applySnapshot} admits a terminal
     * row whose clock is still NULL for this reason.
     *
     * `cancelBuild` is best-effort: the provider may already have finished, and a
     * failure there must not undo the platform's own decision.
     */
    async cancel(workId: string, buildId: string): Promise<AppBuildCancelResult> {
        const row = await this.builds.findByIdForWork(workId, buildId);
        if (!row) {
            return { ok: false, code: 'buildNotFound' };
        }
        if (isTerminalBuildStatus(row.status) || row.status === 'blocked') {
            return { ok: false, code: 'notCancellable' };
        }

        const cancelled = await this.persist(row, { status: 'cancelled', cancelReason: 'user' });

        try {
            const binding = await this.resolvePlugin(workId);
            await binding?.cancelBuild?.({
                buildId: cancelled.id,
                providerRunId: cancelled.providerRunId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `App builds: cancelling build ${buildId} at the provider failed (${
                    error instanceof Error ? error.message : String(error)
                }); the Build is cancelled on the platform regardless.`,
            );
        }

        return { ok: true, build: cancelled };
    }

    /* ---------------------------------------------------------------------- *
     * §4.10 — startVerification
     * ---------------------------------------------------------------------- */

    /**
     * Start a verification Build (plan §4.10:1071-1078, FR-52/FR-53/FR-54).
     *
     * The plan is built from the effective App spec at the requested `sha` and
     * APW-07's **value-free** runner recipe, then checked before anything is
     * dispatched:
     *
     * - a `postgres`/`redis`/`objectStorage` dependency is projected; an `smtp`
     *   dependency the spec's env needs is refused with a **blocked** Build
     *   (`verificationDependencyUnsupported`, §4.10:1067-1069);
     * - a required prompted value that is unset is refused with a **blocked** Build
     *   (`missingBuildValues`, §4.10:1034-1035);
     * - a base64url plan above `APP_BUILD_VERIFY_PLAN_MAX_CHARS` (60,000) or a
     *   summed runner memory above `APP_BUILD_VERIFY_MEMORY_GIB` (12 GiB) is a
     *   **throw**, because no `AppBuildBlockedReason` names either condition and
     *   putting a value the web cannot render into `blockedReason` is worse than
     *   refusing the call (`APW05-G11`).
     *
     * A blocked verification Build publishes **nothing** (§7.8:1560) but still
     * tells the Provisioner once (`plan.md:1576-1580`), which is what stops APW-04
     * polling for a state it can already know.
     */
    async startVerification(
        workId: string,
        request: AppBuildVerificationRequest,
        userId?: string,
    ): Promise<AppBuildStartVerificationResult> {
        const context = await this.readWork(workId);
        if (!context) {
            throw new AppVerificationPlanRefusedError('verificationPlanInvalid', {
                reason: 'unknownWork',
            });
        }

        const ownerUserId = userId ?? context.userId;
        const specRead = await this.readSpec(workId, request.sha);

        const recipe = await this.readRunnerRecipe(workId, request.sha);
        const unsetRequired = [...(recipe?.unsetRequired ?? [])];
        if (unsetRequired.length > 0) {
            // §4.10:1034-1035 — a required prompted value that is unset blocks the
            // verification Build before anything is dispatched.
            const blockedBuild = await this.insertManualBuild(workId, context, {
                trigger: 'verification',
                branch: request.ref,
                commitSha: request.sha,
                userId: ownerUserId,
            });
            return this.blockVerification(blockedBuild, 'missingBuildValues', {
                names: unsetRequired,
            });
        }

        // The plan is built (and its size and memory budget checked) BEFORE the row
        // exists, so a refusal that has no blocked reason leaves no orphan Build.
        let plan: AppVerificationPlan;
        try {
            plan = buildVerificationPlan({
                spec: specRead?.spec ?? null,
                envRecipe: recipe?.recipe ?? [],
                ...(request.reuseImageDigest ? { reuseImageDigest: request.reuseImageDigest } : {}),
            });
        } catch (error) {
            if (
                error instanceof AppVerificationPlanRefusedError &&
                error.reason === 'verificationDependencyUnsupported'
            ) {
                const blockedBuild = await this.insertManualBuild(workId, context, {
                    trigger: 'verification',
                    branch: request.ref,
                    commitSha: request.sha,
                    userId: ownerUserId,
                });
                return this.blockVerification(
                    blockedBuild,
                    'verificationDependencyUnsupported',
                    error.detail,
                );
            }
            throw error;
        }

        const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
        if (encoded.length > APP_BUILD_VERIFY_PLAN_MAX_CHARS) {
            throw new AppVerificationPlanRefusedError('verificationPlanTooLarge', {
                characters: encoded.length,
                max: APP_BUILD_VERIFY_PLAN_MAX_CHARS,
            });
        }

        const build = await this.insertManualBuild(workId, context, {
            trigger: 'verification',
            branch: request.ref,
            commitSha: request.sha,
            userId: ownerUserId,
        });

        const promptedNames = plan.env
            .filter((entry) => entry.source === 'prompted')
            .map((entry) => entry.name);

        const binding = await this.resolvePlugin(workId);
        let dispatched: { providerRunId: string | null; dispatchedAt: string } | null = null;
        try {
            dispatched =
                (await binding?.startBuild?.({
                    buildId: build.id,
                    ref: request.ref,
                    sha: request.sha,
                    mode: 'verify',
                    ...(request.reuseImageDigest
                        ? { reuseImageDigest: request.reuseImageDigest }
                        : {}),
                    verification: { json: encoded, promptedNames },
                })) ?? null;
        } catch (error) {
            this.logger.warn(
                `App builds: dispatching verification build ${build.id} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }

        const started = await this.persist(build, {
            ...(dispatched?.providerRunId ? { providerRunId: dispatched.providerRunId } : {}),
            dispatchedAt: dispatched?.dispatchedAt ? new Date(dispatched.dispatchedAt) : new Date(),
            ...(promptedNames.length > 0
                ? { verifySecretNames: [APP_BUILD_VERIFY_PROMPTED_SECRET] }
                : {}),
        });

        await this.publish(started, 'app.build.queued');
        void this.dispatchWatch({ buildId: started.id, reason: 'dispatched' });

        return { buildId: started.id, blocked: false };
    }

    /**
     * One queued manual or verification Build (`plan.md:342`: a manual or
     * verification Build's `dispatchCorrelationId` is what `startBuild` puts in the
     * run's display title, which is how §7.5:1463 adopts the run later).
     */
    private async insertManualBuild(
        workId: string,
        context: AppBuildWorkContext,
        input: {
            readonly trigger: 'manual' | 'verification';
            readonly branch: string;
            readonly commitSha: string;
            readonly userId: string;
        },
    ): Promise<WorkBuild> {
        return this.builds.insertWithNextNumber(workId, {
            buildPluginId: context.buildPluginId,
            status: 'queued',
            trigger: input.trigger,
            branch: input.branch,
            commitSha: input.commitSha,
            dispatchCorrelationId: randomUUID(),
            queuedAt: new Date(),
            triggeredByUserId: input.userId,
        });
    }

    /** A verification refused before dispatch: silent to the feed, loud to APW-04. */
    private async blockVerification(
        build: WorkBuild,
        reason: AppBuildBlockedReason,
        detail: Record<string, string | number | string[]>,
    ): Promise<AppBuildStartVerificationResult> {
        const blocked = await this.persist(build, {
            status: 'blocked',
            blockedReason: reason,
            blockedDetail: detail,
        });
        await this.notifyProvisioner(blocked);
        return { buildId: blocked.id, blocked: true, blockedReason: reason };
    }

    private async readRunnerRecipe(
        workId: string,
        sha: string,
    ): Promise<{ recipe: readonly AppEnvRecipeEntry[]; unsetRequired: readonly string[] } | null> {
        if (!this.runnerRecipe) return null;
        try {
            const result = await this.runnerRecipe.resolveEphemeral(workId, sha, {
                target: 'runner',
            });
            return { recipe: result.recipe ?? [], unsetRequired: result.unsetRequired ?? [] };
        } catch (error) {
            this.logger.warn(
                `App builds: the runner recipe for work ${workId} could not be resolved (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * §7.3 — applySnapshot and finalize
     * ---------------------------------------------------------------------- */

    /**
     * Apply one observation to the Build row.
     *
     * Four things happen here, in this order, and the order is the contract:
     *
     *   1. **Adoption** — a snapshot carrying a `providerRunId` for a row that has
     *      none records it (§4.8's correlation).
     *   2. **The observation** — every field the snapshot carries, and the row's own
     *      status: `queued` is only ever the insert's value, so an open row advances
     *      to the snapshot's status (or to `running` when the snapshot is already
     *      terminal — the terminal status itself is claimed in step 4). Two things
     *      the platform recorded are not the snapshot's to overwrite: the commit a
     *      `manual`/`verification` Build was dispatched at (`keepsDispatchedCommit`)
     *      and a digest confirmation T14 made (`observedImage`).
     *   3. **Started** — `startedAt` is claimed with a conditional UPDATE
     *      (`AND "startedAt" IS NULL`), so `app.build.started` is published exactly
     *      once across repeated `running` snapshots (§7.8:1565-1568).
     *   4. **The terminal transition** — claimed with the second conditional UPDATE,
     *      then finalised.
     *
     * Step 3 runs before step 4 on purpose, and a snapshot FIRST seen as `completed`
     * therefore still publishes `started` immediately before `succeeded`
     * (§7.8:1566-1568). A Build cancelled before it ever ran goes straight from
     * `queued` to `cancelled`: a `cancelled` snapshot that reports no `startedAt`
     * never claims one, so no `started` event is invented for a run that did not
     * happen.
     */
    async applySnapshot(buildId: string, snapshot: BuildSnapshot): Promise<WorkBuild | null> {
        const row = await this.rowById(buildId);
        if (!row) return null;

        if (snapshot.providerRunId && !row.providerRunId) {
            await this.persist(row, {
                providerRunId: snapshot.providerRunId,
                runAttempt: snapshot.runAttempt,
            });
        }

        const terminal = isTerminalBuildStatus(snapshot.status);
        // Read BEFORE the observation is built: the commit and the image fields it
        // writes depend on what the platform already recorded on the row.
        const current = await this.requireRow(buildId);
        const observation: Partial<WorkBuild> = {
            ...(snapshot.branch ? { branch: snapshot.branch } : {}),
            ...(snapshot.commitSha && !keepsDispatchedCommit(current)
                ? { commitSha: snapshot.commitSha }
                : {}),
            ...(snapshot.pullRequestNumber !== undefined
                ? { pullRequestNumber: snapshot.pullRequestNumber }
                : {}),
            ...(snapshot.runnerLabel ? { runnerLabel: snapshot.runnerLabel } : {}),
            ...(snapshot.logsUrl ? { logsUrl: snapshot.logsUrl } : {}),
            ...(snapshot.billableMinutes !== undefined
                ? { billableMinutes: snapshot.billableMinutes }
                : {}),
            ...(snapshot.checksBillableMinutes !== undefined
                ? { checksBillableMinutes: snapshot.checksBillableMinutes }
                : {}),
            ...(snapshot.image ? observedImage(current, snapshot.image) : {}),
            ...(snapshot.secretCheck ? { secretCheck: snapshot.secretCheck } : {}),
            ...(snapshot.verification
                ? {
                      verificationResult: snapshot.verification as unknown as Record<
                          string,
                          unknown
                      >,
                  }
                : {}),
            ...(snapshot.failure
                ? {
                      failureClass: snapshot.failure.class,
                      failureDetail: snapshot.failure.detail ?? null,
                      failureExcerpt: snapshot.failure.excerpt,
                  }
                : {}),
            lastObservedAt: new Date(),
        };

        const open = !isTerminalBuildStatus(current.status);
        await this.persist(current, {
            ...observation,
            // An open row takes the snapshot's status; a row already terminal (a
            // Build the owner cancelled, say) keeps it — the claim below decides.
            ...(open ? { status: terminal ? 'running' : snapshot.status } : {}),
        });

        const runStarted =
            snapshot.status === 'running' ||
            snapshot.status === 'succeeded' ||
            snapshot.status === 'failed' ||
            (snapshot.status === 'cancelled' && Boolean(snapshot.startedAt));
        const startedAt = snapshot.startedAt ? new Date(snapshot.startedAt) : new Date();
        if (runStarted && (await this.claimStarted(buildId, startedAt))) {
            await this.publish(await this.requireRow(buildId), 'app.build.started');
        }

        if (!terminal) {
            return this.rowById(buildId);
        }

        const claimed = await this.claimTerminal(buildId, snapshot.status, snapshot.completedAt);
        if (!claimed) {
            return this.rowById(buildId);
        }

        // T14 remainder: the Push-step digest travels with the terminal snapshot it
        // arrived in, because there is no column for it (see AppBuildDigestEvidence).
        const result = await this.finalize(
            buildId,
            snapshot.image?.pushLogDigest ? { pushLogDigest: snapshot.image.pushLogDigest } : {},
        );
        return result.build ?? (await this.rowById(buildId));
    }

    /**
     * Finalise one terminal Build — the verdict, the receipt, the Activity row and
     * the one terminal event (`plan.md:1392-1397`, §7.8).
     *
     * Refuses when the verdict is already settled, which is the idempotency guard
     * the class docstring explains. `blocked` is not terminal and is finalised by
     * nothing: it publishes no event at all.
     *
     * The digest is confirmed first (plan §7.3:1392 "On a terminal transition:
     * confirm digest", `confirmDigest`), and its outcome is written in the same
     * patch as the verdict. A registry that throws costs the confirmation, never
     * the finalisation: the Build still settles and still publishes.
     */
    async finalize(
        buildId: string,
        evidence: AppBuildDigestEvidence = {},
    ): Promise<AppBuildFinalizeResult> {
        const row = await this.rowById(buildId);
        if (!row) {
            return {
                finalized: false,
                reason: 'notFound',
                build: null,
                deployable: false,
                notDeployableReason: null,
            };
        }
        if (!isTerminalBuildStatus(row.status)) {
            return {
                finalized: false,
                reason: 'notTerminal',
                build: row,
                deployable: false,
                notDeployableReason: null,
            };
        }
        if (row.deployable || row.notDeployableReason) {
            return {
                finalized: false,
                reason: 'alreadyFinalized',
                build: row,
                deployable: row.deployable,
                notDeployableReason:
                    (row.notDeployableReason as AppBuildNotDeployableReason | null) ?? null,
            };
        }

        const binding = await this.resolvePlugin(row.workId);
        const digest = await this.confirmDigest(row, binding, evidence);
        const { verdict, context } = await this.verdictFor(row, binding, digest.confirmed);

        const usageEventId = await this.recordReceipt(
            row,
            context?.userId ?? row.triggeredByUserId ?? null,
        );

        const settled = await this.persist(row, {
            ...digest.patch,
            completedAt: row.completedAt ?? new Date(),
            deployable: verdict.deployable,
            notDeployableReason: verdict.notDeployableReason,
            ...(usageEventId ? { usageEventId } : {}),
        });

        const event = appBuildEventNameForStatus(settled.status);
        if (event) {
            await this.publish(settled, event, verdict.deployable, verdict.notDeployableReason);
        }

        return {
            finalized: true,
            reason: 'finalized',
            build: settled,
            deployable: verdict.deployable,
            notDeployableReason: verdict.notDeployableReason,
        };
    }

    /**
     * APW-05 T14 remainder — re-check a Build that settled as `digestUnconfirmed`.
     *
     * Plan §7.4 ("re-checks `digestUnconfirmed` Builds whose App Work gained a
     * pull token") and §4.8 ("rechecked on token save"). {@link finalize} is
     * one-shot, so without this a Build whose registry read failed, or whose image
     * was private when it finished, could never become deployable short of a
     * rebuild. `evidence` is the caller's, exactly as for {@link finalize}.
     *
     * Only a row whose verdict is `digestUnconfirmed` is touched. A confirmed
     * digest re-settles the WHOLE verdict through the same helper `finalize`
     * uses, so a clause that stopped holding since (a rotated build value) is
     * reported rather than skipped. It publishes nothing and records no receipt:
     * §7.8's map is keyed on status transitions and this is not one — so T35's
     * build-succeeded auto-deploy does not fire for a late confirmation, and a
     * member deploys that Build by hand. No caller is bound yet: the sweep's
     * recheck pass and the pull-token save are where it belongs.
     */
    async reconfirmDigest(
        buildId: string,
        evidence: AppBuildDigestEvidence = {},
    ): Promise<AppBuildReconfirmResult> {
        const row = await this.rowById(buildId);
        if (!row) {
            return {
                reconfirmed: false,
                reason: 'notFound',
                build: null,
                deployable: false,
                notDeployableReason: null,
            };
        }
        if (row.notDeployableReason !== 'digestUnconfirmed') {
            return {
                reconfirmed: false,
                reason: 'notDigestUnconfirmed',
                build: row,
                deployable: row.deployable,
                notDeployableReason:
                    (row.notDeployableReason as AppBuildNotDeployableReason | null) ?? null,
            };
        }

        const binding = await this.resolvePlugin(row.workId);
        const digest = await this.confirmDigest(row, binding, evidence);
        if (!digest.confirmed) {
            const kept =
                Object.keys(digest.patch).length > 0 ? await this.persist(row, digest.patch) : row;
            return {
                reconfirmed: false,
                reason: 'unconfirmed',
                build: kept,
                deployable: false,
                notDeployableReason: 'digestUnconfirmed',
            };
        }

        const { verdict } = await this.verdictFor(row, binding, true);
        const settled = await this.persist(row, {
            ...digest.patch,
            deployable: verdict.deployable,
            notDeployableReason: verdict.notDeployableReason,
        });
        return {
            reconfirmed: true,
            reason: 'reconfirmed',
            build: settled,
            deployable: verdict.deployable,
            notDeployableReason: verdict.notDeployableReason,
        };
    }

    /**
     * §5.1's verdict for one terminal row — the one place `evaluateBuildVerdict` is
     * called, for {@link finalize} and {@link reconfirmDigest} alike.
     *
     * `digestConfirmed` is passed in rather than read off the row, because the
     * confirmation of this very call has not been written yet: it goes into the
     * same patch as the verdict.
     */
    private async verdictFor(
        row: WorkBuild,
        binding: AppBuildPluginBinding | null,
        digestConfirmed: boolean,
    ): Promise<{ verdict: AppBuildVerdict; context: AppBuildWorkContext | null }> {
        const context = await this.readWork(row.workId);
        const spec = context ? await this.readSpec(row.workId, row.commitSha) : null;
        const buildKind = binding?.buildKind ?? 'github-actions';
        const currentValues = await this.readCurrentInputs(row.workId);

        const verdictRow: AppBuildVerdictRow = {
            status: row.status,
            trigger: row.trigger,
            branch: row.branch,
            // §5.1's `specValidAtCommit`: read now when the row never recorded it.
            // A failed or cancelled Build is not deployable on the first clause, so
            // the extra spec read is skipped for it.
            specValidAtCommit:
                row.specValidAtCommit ??
                (row.status === 'succeeded' ? (spec?.valid ?? null) : null),
            secretsSyncedAt: row.secretsSyncedAt ?? null,
            startedAt: row.startedAt ?? null,
            buildInputsHash: row.buildInputsHash ?? null,
            secretCheck: row.secretCheck ?? null,
            digestConfirmed,
        };

        const verdict = evaluateBuildVerdict({
            build: verdictRow,
            trackedBranch: context?.trackedBranch ?? row.branch,
            currentValues,
            buildKind,
            signatureState: null,
            scan: null,
        });
        return { verdict, context };
    }

    /**
     * APW-05 T14 — confirm the artifact's digest against the registry (plan §4.8).
     *
     * The digest on the row is the member's own CI's claim (the plugin reports it
     * `confirmed: false`, always), so it is only ever confirmed, never believed:
     *
     *  - a row already `digestConfirmed` stays confirmed, with no registry read (a
     *    plugin that can vouch for its own digest keeps doing so);
     *  - only a `succeeded` `push`/`manual` Build with a digest and a commit is
     *    read at all — nothing else can be deployable, so nothing else is worth a
     *    registry request;
     *  - the registry is read through the binding's `checkImageAccess`, for the
     *    PLATFORM-derived repository and the Build's own `sha-<commitSha>` tag,
     *    with no pull token (none can be stored yet: the §4.12 writer is unbound).
     *    An artifact that names a different repository is not read at all — a
     *    member's CI does not get to choose which image the platform confirms;
     *  - registry digest equal → confirmed, and the row's `imageRepository` is
     *    pinned to the derived repository, which is what APW-06's deploy
     *    reference is built from (a `digestMismatch` recorded by an earlier read
     *    is cleared); unequal → `failureClass: 'digestMismatch'`;
     *  - registry answered but unreadable (a private image with no pull token) →
     *    confirmed only when the Push-step log digest equals the artifact digest
     *    (the no-token fallback); otherwise unconfirmed until a recheck;
     *  - no binding, no member, no repository, a read that throws, or one with no
     *    answer inside {@link APP_BUILD_DIGEST_READ_TIMEOUT_MS} → unconfirmed.
     *    Neither propagates: `finalize` must still settle, inside its lease.
     */
    private async confirmDigest(
        row: WorkBuild,
        binding: AppBuildPluginBinding | null,
        evidence: AppBuildDigestEvidence,
    ): Promise<{ readonly confirmed: boolean; readonly patch: Partial<WorkBuild> }> {
        if (row.digestConfirmed) return { confirmed: true, patch: {} };
        const unconfirmed = { confirmed: false, patch: {} };
        if (
            row.status !== 'succeeded' ||
            !(APP_BUILD_DEPLOYABLE_TRIGGERS as readonly string[]).includes(row.trigger) ||
            !row.imageDigest ||
            !row.commitSha
        ) {
            return unconfirmed;
        }

        const repository = binding?.imageRepository ?? null;
        if (!binding || !repository || typeof binding.checkImageAccess !== 'function') {
            return unconfirmed;
        }
        const claimed = (row.imageRepository ?? '').trim().toLowerCase();
        if (claimed !== repository.toLowerCase()) {
            this.logger.warn(
                `App builds: Build ${row.id} (work ${row.workId}) reports its image in a repository the platform did not derive; its digest is not confirmed.`,
            );
            return unconfirmed;
        }

        let answer: Awaited<ReturnType<NonNullable<AppBuildPluginBinding['checkImageAccess']>>>;
        try {
            answer = await withinDigestReadTimeout(
                binding.checkImageAccess({
                    imageRepository: repository,
                    tag: `sha-${row.commitSha}`,
                }),
            );
        } catch (error) {
            this.logger.warn(
                `App builds: reading the image of Build ${row.id} (work ${row.workId}) from the registry failed (${
                    error instanceof Error ? error.message : String(error)
                }); its digest stays unconfirmed.`,
            );
            return unconfirmed;
        }

        // A `digestMismatch` an earlier read recorded (finalize, or a previous
        // recheck) is this method's own verdict, and a confirmation withdraws it:
        // `failureClass` is shown on the Build whatever its status, so a deployable
        // Build must not keep saying its image could not be confirmed.
        const confirmed = {
            confirmed: true,
            patch: {
                digestConfirmed: true,
                imageRepository: repository,
                ...(row.failureClass === 'digestMismatch' ? { failureClass: null } : {}),
            },
        };
        if (answer.readable && answer.digest) {
            if (answer.digest === row.imageDigest) return confirmed;
            this.logger.warn(
                `App builds: the registry reports a different digest for Build ${row.id} (work ${row.workId}) than its artifact claimed (digestMismatch).`,
            );
            return { confirmed: false, patch: { failureClass: 'digestMismatch' } };
        }
        if (
            !answer.readable &&
            evidence.pushLogDigest !== undefined &&
            evidence.pushLogDigest === row.imageDigest
        ) {
            return confirmed;
        }
        return unconfirmed;
    }

    /**
     * The receipt (§7.3:1392, ACC-05-20).
     *
     * `units` is the runner's billable minutes, the payer is the **workspace** (the
     * owner's own GitHub account ran it), the operation is `build.run`, and
     * `costCents` is `0` because GitHub does not bill the platform for a
     * runner-minute — `PluginUsageService` therefore writes an audit row and
     * charges no credits. `null` when the Build never ran or the usage service is
     * unbound; the caller then leaves `usageEventId` NULL.
     */
    private async recordReceipt(build: WorkBuild, userId: string | null): Promise<string | null> {
        const minutes = build.billableMinutes;
        if (!this.usage || !userId || minutes === null || minutes === undefined) {
            return null;
        }
        const row = await this.usage.record({
            workId: build.workId,
            userId,
            pluginId: build.buildPluginId,
            capability: PluginUsageCapability.BUILD,
            units: minutes,
            costCents: 0,
            operation: 'build.run',
            outcome: build.status === 'succeeded' ? UsageOutcome.OK : UsageOutcome.FAILED,
            payer: UsagePayer.WORKSPACE,
            metadata: {
                buildId: build.id,
                runnerClass: build.runnerClass ?? null,
                checksBillableMinutes: build.checksBillableMinutes ?? null,
            },
        });
        return row?.id ?? null;
    }

    /* ---------------------------------------------------------------------- *
     * §7.8 — the single Activity + event writer
     * ---------------------------------------------------------------------- */

    /**
     * The ONE writer (`plan.md:1569-1573`).
     *
     * It (1) writes the Activity row with `actionType: 'app_build'` and
     * `action = <the event name>` (Resolution R-2) and metadata
     * `{ buildId, number, commitSha, trigger, failureClass }` — "never a value or a
     * log line, per FR-40"; (2) emits the event through `EventEmitter2`; and (3) for
     * a **verification** Build calls APW-04's `buildUpdated(buildId)`, including for
     * the `blocked` transition that publishes nothing (§7.8:1576-1580).
     *
     * ## The status → event map is the authority, and `event` must agree with it
     *
     * §7.8 replaces the old `app.build.<status>` template with an explicit map, so
     * the row's status decides which event exists. `event` is the caller's
     * declaration of the transition it just made; when the two disagree — including
     * the case of publishing anything at all for a `blocked` Build, whose only map
     * entry is `null` — nothing is written and nothing is emitted. That is what makes
     * "a `blocked` Build publishes nothing" a property of the writer rather than of
     * every caller remembering not to call it.
     */
    async publish(
        build: WorkBuild,
        event: AppBuildEventName,
        deployable = false,
        notDeployableReason: AppBuildNotDeployableReason | null = null,
    ): Promise<void> {
        const EventClass: AppBuildEventClass | null = APP_BUILD_EVENT_CLASSES[build.status];
        if (!EventClass || EventClass.EVENT_NAME !== event) {
            this.logger.warn(
                `App builds: refusing to publish ${event} for a ${build.status} build ${build.id} — §7.8's status → event map names ${
                    EventClass ? EventClass.EVENT_NAME : 'no event'
                } for that status.`,
            );
            return;
        }

        const userId = (await this.readWork(build.workId))?.userId ?? build.triggeredByUserId ?? '';

        const payload = buildEventPayload(build, userId, deployable, notDeployableReason);

        if (this.activityLog && userId) {
            try {
                await this.activityLog.log({
                    userId,
                    workId: build.workId,
                    actionType: ActivityActionType.APP_BUILD,
                    action: event,
                    status: activityStatusFor(build.status),
                    summary: `Build #${build.number} ${event.slice('app.build.'.length)}`,
                    metadata: {
                        buildId: build.id,
                        number: build.number,
                        commitSha: build.commitSha,
                        trigger: build.trigger,
                        failureClass: build.failureClass ?? null,
                    },
                });
            } catch (error) {
                this.logger.warn(
                    `App builds: the Activity row for build ${build.id} could not be written (${
                        error instanceof Error ? error.message : String(error)
                    }).`,
                );
            }
        }

        if (this.emitter) {
            this.emitter.emit(EventClass.EVENT_NAME, new EventClass(payload));
        }

        await this.notifyProvisioner(build);
    }

    /**
     * APW-04's port (`plan.md:1576-1580`, `APW05-G11`): **every** transition of a
     * Build whose `trigger` is `verification`, including the pre-dispatch `blocked`
     * one. A missing binding or a throwing handler is logged and never fails the
     * watch, the prepare or the dispatch.
     */
    private async notifyProvisioner(build: WorkBuild): Promise<void> {
        if (build.trigger !== 'verification' || !this.provisionEvents?.buildUpdated) {
            return;
        }
        try {
            await this.provisionEvents.buildUpdated(build.id);
        } catch (error) {
            this.logger.warn(
                `App builds: notifying the provisioner about build ${build.id} failed (${
                    error instanceof Error ? error.message : String(error)
                }); the Build is unaffected.`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * getDetail (§5:1197, APW-04's poll fallback)
     * ---------------------------------------------------------------------- */

    /**
     * One Build's drawer (`AppBuildDetail`), and APW-04's 30-second poll fallback
     * (`plan.md:1075-1078`).
     *
     * `canEdit` is resolved through {@link APP_BUILD_EDIT_ACCESS} and is **false when
     * that port is unbound** — fail-closed, because a viewer's response must never
     * claim edit rights. `buildValueNames` is `buildSecretNames`: the NAMES only,
     * never a value (`plan.md:1204-1205`).
     */
    async getDetail(workId: string, buildId: string): Promise<AppBuildDetail | null> {
        const row = await this.builds.findByIdForWork(workId, buildId);
        if (!row) return null;

        const canEdit = (await this.editAccess?.isEditor(workId)) ?? false;

        return {
            ...toAppBuildSummary(row),
            runnerClass: row.runnerClass ?? null,
            runnerLabel: row.runnerLabel ?? null,
            buildValueNames: row.buildSecretNames ?? [],
            failureDetail: row.failureDetail ?? null,
            failureExcerpt: row.failureExcerpt ?? [],
            verificationResult:
                (row.verificationResult as unknown as AppBuildDetail['verificationResult']) ?? null,
            receipt: row.usageEventId
                ? {
                      billableMinutes: row.billableMinutes ?? null,
                      checksBillableMinutes: row.checksBillableMinutes ?? null,
                      payer: 'workspace',
                      costKnown: true,
                  }
                : null,
            triggeredBy: null,
            canEdit,
        };
    }

    /* ---------------------------------------------------------------------- *
     * Private plumbing
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

    private async readSpec(workId: string, sha: string | null): Promise<AppBuildSpecRead | null> {
        if (!this.specs) return null;
        try {
            return await this.specs.read(workId, sha);
        } catch (error) {
            this.logger.warn(
                `App builds: reading the effective App spec of ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    private async resolvePlugin(workId: string): Promise<AppBuildPluginBinding | null> {
        const context = await this.readWork(workId);
        if (!this.plugins || !context) return null;
        try {
            return await this.plugins.resolve(workId, context.userId);
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
     * Today's `(name, fingerprint)` pairs from APW-07 (`plan.md:1244-1247`).
     *
     * `null` is "the resolver could not answer" and the verdict reads it as
     * `staleInputs`; it is never hashed as the empty list, because the empty list is
     * a REAL answer that must pass the clause (see `deployable-verdict.ts`).
     */
    private async readCurrentInputs(
        workId: string,
    ): Promise<readonly { readonly name: string; readonly fingerprint: string }[] | null> {
        if (!this.fingerprints) return null;
        try {
            const map = await this.fingerprints.read(workId, 'build');
            return map === null ? null : fingerprintsToValues(map);
        } catch (error) {
            this.logger.warn(
                `App builds: the build fingerprints of ${workId} could not be read (${
                    error instanceof Error ? error.message : String(error)
                }); the Build is not deployable.`,
            );
            return null;
        }
    }

    /** One row by id, through the entity's own repository. `null` when it is gone. */
    private async rowById(buildId: string): Promise<WorkBuild | null> {
        return this.rowRepository().findOne({ where: { id: buildId } });
    }

    private async requireRow(buildId: string): Promise<WorkBuild> {
        const row = await this.rowById(buildId);
        if (!row) {
            throw new Error(`AppBuildsService: work_builds row ${buildId} disappeared`);
        }
        return row;
    }

    private rowRepository(): Repository<WorkBuild> {
        if (!this.rows) {
            throw new Error(
                'AppBuildsService: the WorkBuild repository is not bound; the persistence half of this service needs AppBuildsModule.',
            );
        }
        return this.rows;
    }

    /**
     * Merge a patch onto a loaded row and store it.
     *
     * `save(merge(row, patch))` rather than a query-builder `UPDATE … SET`, because
     * these patches carry `simple-json` columns (`imageTags`, `blockedDetail`,
     * `failureExcerpt`, `verifySecretNames`) and the entity path is the one that
     * persists them through the column's own transformer on every driver. The two
     * conditional claims below use the query builder instead, because their whole
     * point is the WHERE predicate.
     */
    private async persist(row: WorkBuild, patch: Partial<WorkBuild>): Promise<WorkBuild> {
        const repository = this.rowRepository();
        repository.merge(row, patch);
        return repository.save(row);
    }

    /**
     * `UPDATE work_builds SET "startedAt" = :t WHERE id = :id AND "startedAt" IS NULL`
     * (`plan.md:1565-1566`) — "only the call that changes one row publishes".
     */
    private async claimStarted(buildId: string, startedAt: Date): Promise<boolean> {
        if (!this.rows) return false;
        const result = await this.rows
            .createQueryBuilder()
            .update(WorkBuild)
            .set({ startedAt })
            .where('id = :id', { id: buildId })
            .andWhere('startedAt IS NULL')
            .execute();
        return (result.affected ?? 0) === 1;
    }

    /**
     * The terminal claim: exactly one caller moves a Build into a terminal status
     * **and** stamps `completedAt`.
     *
     * The second arm of the predicate (`completedAt IS NULL`) is what lets a Build
     * the owner cancelled — {@link cancel} writes the status and leaves the clock
     * NULL, so §7.3's next observation is the one that finalises it — still take the
     * claim, while a second delivery of the same terminal snapshot does not.
     */
    private async claimTerminal(
        buildId: string,
        status: string,
        completedAt?: string,
    ): Promise<boolean> {
        if (!this.rows) return false;
        const result = await this.rows
            .createQueryBuilder()
            .update(WorkBuild)
            .set({
                status: status as WorkBuild['status'],
                completedAt: completedAt ? new Date(completedAt) : new Date(),
            })
            .where('id = :id', { id: buildId })
            .andWhere('(status NOT IN (:...terminal) OR completedAt IS NULL)', {
                terminal: [...TERMINAL_STATUSES],
            })
            .execute();
        return (result.affected ?? 0) === 1;
    }
}

/** A provider-reported instant, or `null` when it is missing or unparseable. */
function parseRunInstant(value: string | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * How far along a Build is, for the one comparison that must never go backwards:
 * a poll of a run the platform already recorded may advance a Build, never return
 * it to an earlier state.
 */
function statusRank(status: string): number {
    if (isTerminalBuildStatus(status)) return 2;
    if (status === 'running') return 1;
    return 0;
}
