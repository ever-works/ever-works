/**
 * APW-07 T14 — `AppEnvRuntimeSource`: APW-06's `AppRuntimeEnvSource`
 * (`packages/agent/src/app-runtime/ports.ts:182-205`), bound to
 * `APP_RUNTIME_ENV_SOURCE`.
 *
 * Spec: FR-21…FR-27, FR-62; ACC-07-06, -09, -13, -31, -33. Plan §4.6.1:424-449
 * is the contract of record — `resolve` returns
 * `{ values, fingerprints, secretNames, unsetRequired, notReadyDependencies,
 * egress }`, `resolveEphemeral` has its two targets, and `ew-dep://`
 * placeholders are decided from `ctx.target`.
 *
 * ## What this class is, and what it is not
 *
 * It is a thin ADAPTER. Every decision about a value lives in
 * `AppEnvResolver` (one implementation, used by the Build path too); this file
 * owns exactly three things:
 *
 * 1. the **one** call to `AppDependenciesService.ensureReadyForDeploy(workId)`
 *    whose `notReady` kinds become `notReadyDependencies` — and which also
 *    dispatches provisioning for `pending` kinds (GAP-05), which is why it is
 *    called exactly once per resolution and never from the ephemeral paths —
 *    and whose answer is handed back as `dependencyReadiness`, so APW-06's
 *    Deploy preflight (which calls `resolve` in its step 8) does not make a
 *    second call in its step 9 that would dispatch the `pending` kinds again;
 * 2. the mapping from a resolution to the port's return shape (`values` is a
 *    map here and a list inside, `unsetRequired` is names, …);
 * 3. the two ephemeral targets, each delegating to the resolver method that
 *    guarantees their side-effect-free contract (R-10).
 *
 * ## Beyond the port, additively (R-26)
 *
 * Plan §2.2:143-146 requires `fingerprints` — "exactly the same keys as
 * `values`" — and `ports.ts:187-193` does not declare it yet, so this class
 * returns it (plus `warnings` and `unresolved`, which make a resolution
 * explainable). Extra properties on the returned object are invisible to a
 * caller that only knows the port's type, and `fingerprints` is what APW-05
 * persists as `WorkBuild.buildValueFingerprints` and APW-06 as
 * `appRender.envFingerprints` (CONTRACTS §2, APW07-G03).
 *
 * ## `resolveEphemeral`'s context is WIDER than the port's
 *
 * Plan §4.6.1:446 (APW07-G04) requires the `cluster` target to read the outputs
 * `AppDependenciesService.provisionEphemeral` returned, and
 * `AppRuntimeEnvEphemeralContext` (`ports.ts:164-171`) has no field for them.
 * This file declares {@link AppRuntimeEphemeralEnvContext} — the port's context
 * plus an optional `dependencyOutputs` — and accepts it, which is the additive
 * direction: a caller built against the port's own type still compiles, and
 * APW-06's plan §5:833-835 order (provision ephemeral → resolve ephemeral →
 * render) is the one that fills the field in. APW-06 owns that type and should
 * add it.
 *
 * ## Bindings (a module owner adds them; this file declares none)
 *
 * ```ts
 * { provide: APP_RUNTIME_ENV_SOURCE, useExisting: AppEnvRuntimeSource }
 * { provide: APP_ENV_DEPLOY_READINESS, useExisting: AppDependenciesService }
 * ```
 *
 * Both are unbound-safe: an unbound resolver answers "no values, no
 * fingerprints" and an unbound readiness source answers "no not-ready
 * dependencies" — never a fabricated success, and never a value.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AppDependencyKind } from '@ever-works/contracts';
import {
    type AppRuntimeEnvContext,
    type AppRuntimeEnvEphemeralContext,
    type AppRuntimeEnvSource,
} from '../app-runtime/ports';
import {
    AppEnvResolver,
    valuesToRecord,
    type AppEnvDeployReadiness,
    type AppEnvEphemeralClusterResolution,
    type AppEnvResolutionResult,
    type AppEnvResolutionWarning,
    type AppEnvRunnerRecipeResolution,
    type AppEnvRuntimeRecipeEntry,
} from './app-env.resolver';
import type { AppEnvUnresolved } from '@ever-works/contracts';

/* -------------------------------------------------------------------------- *
 * The readiness seam — plan §4.6.1:432-434 (GAP-05)
 * -------------------------------------------------------------------------- */

/**
 * `AppDependenciesService.ensureReadyForDeploy(workId)`, narrowed to the one
 * method this file calls (`app-dependencies.service.ts:509-551`).
 *
 * Bound to that service with `{ provide: APP_ENV_DEPLOY_READINESS, useExisting:
 * AppDependenciesService }`: the swap is an alias, so the call really is the
 * dependency service's own — including its `reconcile` pass, which is what
 * dispatches provisioning for the `pending` kinds (GAP-05). It is called ONCE
 * per `resolve` (a Deploy preflight), never from an ephemeral path, and never by
 * the resolver: one resolution, one dispatch.
 */
export interface AppEnvDeployReadinessSource {
    ensureReadyForDeploy(workId: string): Promise<AppEnvDeployReadiness>;
}

/** DI token for {@link AppEnvDeployReadinessSource} — bound to T16's `AppDependenciesService`. */
export const APP_ENV_DEPLOY_READINESS = Symbol('APP_ENV_DEPLOY_READINESS');

/* -------------------------------------------------------------------------- *
 * Contexts and results
 * -------------------------------------------------------------------------- */

/**
 * The port's ephemeral context plus the plan's `dependencyOutputs`
 * (APW07-G04, §4.6.1:446) — see this file's docstring.
 */
export interface AppRuntimeEphemeralEnvContext extends AppRuntimeEnvEphemeralContext {
    /**
     * `AppDependenciesService.provisionEphemeral(workId, { namespace, kinds })`'s
     * `outputs`, passed straight back (§5:831-835). In memory only: nothing is
     * stored for a verification's dependencies (R-10, FR-60).
     */
    readonly dependencyOutputs?: Record<string, Record<string, string>> | null;
}

/** What {@link AppEnvRuntimeSource.resolve} answers — the port's shape plus the plan's map. */
export interface AppEnvRuntimeResolveResult {
    values: Record<string, string>;
    /** The §2.2 per-name map, exactly the keys of `values` (plan §2.2:143). */
    fingerprints: Record<string, string>;
    secretNames: string[];
    /** The required prompted names with no value (FR-26, ACC-07-09). */
    unsetRequired: string[];
    /** Referenced kinds `ensureReadyForDeploy` did not report `ready` (§4.6.1:432-434). */
    notReadyDependencies: string[];
    /** The external destinations to open (§4.6.1:434-435). */
    egress: Array<{ host: string; ports: number[] }>;
    /** Additive: why a name has no value — never a value (FR-23). */
    unresolved: AppEnvUnresolved[];
    /** Additive: FR-62's "left out with a warning" items. */
    warnings: AppEnvResolutionWarning[];
    /**
     * Additive (`ports.ts`'s `dependencyReadiness`): the `ensureReadyForDeploy` answer this
     * resolution obtained, or `null` when it has none. A Deploy preflight reuses it rather
     * than asking again — each call re-dispatches every `pending` kind (GAP-05).
     */
    dependencyReadiness: AppEnvDeployReadiness | null;
}

/** What {@link AppEnvRuntimeSource.resolveEphemeral} answers. */
export interface AppEnvRuntimeEphemeralResolveResult {
    /** `cluster` only — `runner` returns **no value at all** (`undefined`). */
    values?: Record<string, string>;
    /** `runner` only — the value-free recipe (§4.6.1:447). */
    recipe?: AppEnvRuntimeRecipeEntry[];
    secretNames: string[];
    unsetRequired: string[];
    /** Additive: the §4.9a omissions, and why a name has no value. */
    warnings: AppEnvResolutionWarning[];
    unresolved: AppEnvUnresolved[];
}

/* -------------------------------------------------------------------------- *
 * The source
 * -------------------------------------------------------------------------- */

@Injectable()
export class AppEnvRuntimeSource implements AppRuntimeEnvSource {
    private readonly logger = new Logger(AppEnvRuntimeSource.name);

    constructor(
        @Optional() private readonly resolver?: AppEnvResolver,
        @Optional()
        @Inject(APP_ENV_DEPLOY_READINESS)
        private readonly readiness?: AppEnvDeployReadinessSource,
    ) {}

    /**
     * Resolve a Deploy's env (plan §4.6.1:428-437).
     *
     * `values` are the `runtime`/`both` entries (plus a keypair's `<NAME>_PUBLIC`
     * half), `fingerprints` is the §2.2 map APW-06 persists inside
     * `appRender.envFingerprints`, `secretNames` is the secret subset,
     * `unsetRequired` the required prompted names, and `egress` the external
     * destinations APW-06 opens.
     *
     * `specCommitSha` is the caller's own commit identity: the effective App spec
     * is APW-03's (`AppEnvSpecSource.read(workId)`, the tracked head), and this
     * method never re-reads a spec by commit — the two must not disagree.
     */
    async resolve(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvContext,
    ): Promise<AppEnvRuntimeResolveResult> {
        void specCommitSha;
        // Exactly one call, before the resolution: its `reconcile` pass is what
        // dispatches the `pending` kinds (GAP-05) and its `notReady` kinds are
        // what a Deploy's preconditions name.
        const readiness = await this.readReadiness(workId);
        const resolution = await this.resolveValues(workId, ctx, readiness);

        return {
            values: valuesToRecord(resolution.values),
            fingerprints: resolution.fingerprints,
            secretNames: resolution.values
                .filter((entry) => entry.secret)
                .map((entry) => entry.name),
            unsetRequired: resolution.missingRequired.map((entry) => entry.name),
            notReadyDependencies: notReadyKinds(readiness),
            egress: resolution.egress,
            unresolved: resolution.unresolved,
            warnings: resolution.warnings,
            // Handed on so the caller's own dependency row (APW-06 §5.1 step 9) reads this
            // one answer instead of making a second dispatching call.
            dependencyReadiness: readiness,
        };
    }

    /**
     * Ephemeral mode (R-10, plan §4.6.1:439-447).
     *
     * `cluster` → in-memory values for a verification namespace, with derived
     * references read from `ctx.dependencyOutputs`; `runner` → the value-free
     * recipe, and **no `values` key at all**. Neither path calls
     * `ensureReadyForDeploy`, writes a row or dispatches anything.
     */
    async resolveEphemeral(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEphemeralEnvContext,
    ): Promise<AppEnvRuntimeEphemeralResolveResult> {
        void specCommitSha;
        if (!this.resolver) {
            return { secretNames: [], unsetRequired: [], warnings: [], unresolved: [] };
        }

        if (ctx?.target === 'runner') {
            const recipe: AppEnvRunnerRecipeResolution = await this.resolver.buildRunnerRecipe(
                workId,
                {
                    target: 'runner',
                    primaryUrl: ctx?.primaryUrl ?? null,
                    primaryHost: ctx?.primaryHost ?? null,
                    commitSha: ctx?.buildCommitSha ?? null,
                    internalUrls: ctx?.internalUrls ?? null,
                },
            );
            return {
                // No `values` key, on purpose: the runner gets a recipe and no
                // value of any kind (§4.6.1:447).
                recipe: recipe.recipe,
                secretNames: recipe.secretNames,
                unsetRequired: recipe.unsetRequired,
                warnings: recipe.warnings,
                unresolved: [],
            };
        }

        const cluster: AppEnvEphemeralClusterResolution =
            await this.resolver.resolveEphemeralForCluster(workId, {
                target: 'cluster',
                primaryUrl: ctx?.primaryUrl ?? null,
                primaryHost: ctx?.primaryHost ?? null,
                commitSha: ctx?.buildCommitSha ?? null,
                internalUrls: ctx?.internalUrls ?? null,
                dependencyOutputs: ctx?.dependencyOutputs ?? null,
            });

        return {
            values: cluster.values,
            secretNames: cluster.secretNames,
            unsetRequired: cluster.unsetRequired,
            warnings: cluster.warnings,
            unresolved: cluster.unresolved,
        };
    }

    /* ---------------------------------------------------------------------- *
     * internals
     * ---------------------------------------------------------------------- */

    /** The one `ensureReadyForDeploy` call; an unbound or throwing seam is "no answer". */
    private async readReadiness(workId: string): Promise<AppEnvDeployReadiness | null> {
        if (!this.readiness) {
            return null;
        }
        try {
            return (await this.readiness.ensureReadyForDeploy(workId)) ?? null;
        } catch (error) {
            // The caller's own preflight asks the same question, so a failed
            // answer here must not invent one.
            this.logger.warn(
                `App env: the dependency readiness of work ${workId} could not be read (${describeError(error)}).`,
            );
            return null;
        }
    }

    /** The resolver's runtime pass, or an empty one when it is unbound. */
    private async resolveValues(
        workId: string,
        ctx: AppRuntimeEnvContext,
        readiness: AppEnvDeployReadiness | null,
    ): Promise<AppEnvResolutionResult> {
        if (!this.resolver) {
            return {
                values: [],
                unresolved: [],
                fingerprints: {},
                warnings: [],
                missingRequired: [],
                egress: [],
            };
        }
        return this.resolver.resolveRuntime(
            workId,
            {
                target: ctx?.target ?? 'your-cluster',
                primaryUrl: ctx?.primaryUrl ?? null,
                primaryHost: ctx?.primaryHost ?? null,
                buildCommitSha: ctx?.buildCommitSha ?? null,
                internalUrls: ctx?.internalUrls ?? null,
            },
            readiness,
        );
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/**
 * The not-ready kinds, deduplicated and sorted so two identical deployments
 * render identically. An unbound readiness source answers `[]` — "no
 * information", never "everything is ready": the resolver's own references fail
 * closed with `dependencyNotReady` regardless.
 */
export function notReadyKinds(readiness: AppEnvDeployReadiness | null): AppDependencyKind[] {
    if (!readiness) return [];
    const kinds = new Set<AppDependencyKind>();
    for (const entry of readiness.notReady ?? []) {
        if (entry?.kind) kinds.add(entry.kind);
    }
    return [...kinds].sort();
}

/** An error's NAME, for a log line that must never carry a value. */
function describeError(error: unknown): string {
    if (error instanceof Error) return error.name;
    return typeof error === 'string' ? 'Error' : typeof error;
}
