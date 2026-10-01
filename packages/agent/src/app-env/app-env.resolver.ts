/**
 * APW-07 T14 — `AppEnvResolver`: the ONE place an App Work's env is turned
 * into values (plan §2.2:110-150, §4.6:422-464).
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * FR-21…FR-27 (derived values and resolution, gating), FR-62 (optional SMTP);
 * ACC-07-06, -09, -10, -13, -31, -33. Plan §2.2 is the resolution table **and**
 * the one fingerprint rule, §4.6.1 the port contract and the runner recipe,
 * §4.6.2 the build-service output table, §4.9a:647-651 what "optional SMTP"
 * means, §4.11:694-696 the `ew-dep://` token of the managed tier.
 *
 * ## The entry points, and who calls them
 *
 * | Method                        | Caller                                            | Returns                                              |
 * | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
 * | `resolveForBuild`             | APW-05's `app-build-prepare` (plan §5:825)        | `AppEnvResolutionResult` (`values`, `unresolved`, …) |
 * | `resolveRuntime`              | this epic's `AppEnvRuntimeSource` only            | the same, for a Deploy's namespace Secret            |
 * | `resolveEphemeralForCluster`  | `AppEnvRuntimeSource.resolveEphemeral` (R-10)     | `values` generated in memory, **nothing stored**     |
 * | `buildRunnerRecipe`           | `AppEnvRuntimeSource.resolveEphemeral` (R-10)     | the value-free `AppEnvRecipeEntry[]` recipe          |
 * | `read`                        | T13's `AppEnvService.list` (FR-24's change flags) | the per-name §2.2 fingerprint map                    |
 *
 * ## The §2.2 fingerprint rule, in one place
 *
 * Every resolved name carries a fingerprint, and this class is its only
 * producer (`read` is what T13's `list` compares against
 * `WorkBuild.buildValueFingerprints` / `appRender.envFingerprints`):
 *
 * | Entry                                                       | Fingerprint                         |
 * | ----------------------------------------------------------- | ----------------------------------- |
 * | a stored row (override, generated, prompted, public half)    | `v<version>` (plan §2.2:138)        |
 * | `from: deps.<kind>.<out>` — a direct dependency output        | `d<outputsVersion>` (plan §2.2:139) |
 * | a secret `template`, or a secret non-dependency `from`        | `t<sha256(…)>` (plan §2.2:140)      |
 * | anything else, non-secret (incl. a build-service output)      | `sha256(value)` (plan §2.2:141)     |
 *
 * **No sha256 of a secret value is ever computed**, here or anywhere: the
 * `t<…>` input is the template/reference TEXT plus the fingerprints of what it
 * resolved, and every one of those fingerprints is a version (`v`/`d`) or a
 * hash of a NON-secret value. The invariant this file enforces, and its spec
 * pins, is: **a bare `sha256(value)` fingerprint belongs only to a non-secret
 * value** — including a Build's own throwaway service output, which §4.6.2:455
 * defines as non-secret by construction and §2.2:141 names as its own arm of the
 * rule (a build-phase entry the spec DECLARES secret is still masked as one; it
 * is the VALUE that is a build artifact, not a stored secret).
 *
 * ## `ctx.target` decides the placeholder, never the stored row
 *
 * `ever-works-apps` is the only target that emits `ew-dep://<kind>/<output>`
 * (plan §4.6.1:436-437, §4.11:694-696): on the managed tier the platform holds
 * no outputs at all (`outputsEncrypted` is `NULL`, §3.2:230), so a dependency
 * reference becomes the literal token the zone substitutes and **no output is
 * read**. On `your-cluster` the reference resolves to the row's real output.
 * A stored row's `deployTarget` is never consulted — it records where something
 * was provisioned, not where this deployment runs (APW06-G08).
 *
 * ## Fail closed, with the reason named (FR-23)
 *
 * Every failure is an `unresolved` item `{ name, reason, ref }` and **never** a
 * value: a reference that cannot resolve blocks the Build or Deploy. The one
 * deliberate exception is FR-62/§4.9a: an entry sourced from an OPTIONAL smtp
 * dependency that is not ready is **left out** of the resolved set with the
 * `smtpNotConfigured` warning, so a Deploy is not blocked by a dependency the
 * App spec itself calls optional.
 *
 * A stored row whose envelope cannot be decrypted is the one case that THROWS
 * (`AppEnvRefusalError('secureStorageUnavailable')`), because plan §9.2:950
 * makes that a blocked Deploy rather than a silently unset name — "reads of
 * existing rows fail closed with the same code".
 *
 * ## Ephemeral mode writes nothing (R-10, ACC-07-31)
 *
 * `resolveEphemeralForCluster`/`buildRunnerRecipe` never create a row, never
 * dispatch a dependency, never call the generate-if-absent pass and never read a
 * stored GENERATED or derived value; a prompted or owner-set value is used only
 * when it is already stored. Generated entries — including a keypair's public
 * half — are produced fresh, in memory, by T10's generators (§4.3), which is why
 * a second verification gets different values (ACC-07-31). The `cluster` target
 * takes its dependency outputs from `ctx.dependencyOutputs`, the map APW-06
 * passes straight back from `AppDependenciesService.provisionEphemeral`
 * (APW07-G04, §4.6.1:446). No fingerprint is produced for an ephemeral value:
 * nothing is persisted, so there is no map to compare against (§2.2:143-150).
 *
 * ## The collaborators, and what an unbound one answers
 *
 * Every parameter is `@Optional()` so the class is constructible with nothing
 * (this file's own spec, and the worker's module graph before its binder lands).
 * This file declares none of the bindings — a module owner adds them:
 *
 * | Seam                           | Bound to                                         | Unbound answer                                  |
 * | ------------------------------ | ------------------------------------------------ | ----------------------------------------------- |
 * | `APP_ENV_SPEC_SOURCE`          | APW-03's `AppSpecService`                        | no entries at all                               |
 * | `WorkAppEnvValueRepository`    | T8 (same folder, own provider)                   | "nothing is stored"                             |
 * | `Repository<WorkAppEnvValue>`  | `TypeOrmModule.forFeature([WorkAppEnvValue])`    | "nothing is stored"                             |
 * | `AppEnvCrypto`                 | T9 (same folder, own provider)                   | a stored row cannot be read → the 503 refusal   |
 * | `Repository<WorkAppDependency>`| `TypeOrmModule.forFeature([WorkAppDependency])`  | every dependency reference `dependencyNotReady` |
 * | `APP_ENV_ENSURE_GENERATED`     | `{ useExisting: AppEnvService }` — see 🛑 below   | a generated entry with no row is unresolved     |
 *
 * 🛑 **`APP_ENV_ENSURE_GENERATED` and `APP_ENV_RESOLVER_FINGERPRINTS` cannot both
 * be plain `useExisting` aliases.** T13's `AppEnvService` takes
 * `APP_ENV_RESOLVER_FINGERPRINTS` (its documented swap is
 * `useExisting: AppEnvResolver`) and this class takes `APP_ENV_ENSURE_GENERATED`
 * (swap `useExisting: AppEnvService`) — together that is a provider cycle Nest
 * refuses to bootstrap. Break it on the generation side with a call-time lookup,
 * which costs nothing because `ensureGenerated` is idempotent:
 *
 * ```ts
 * {
 *     provide: APP_ENV_ENSURE_GENERATED,
 *     useFactory: (ref: ModuleRef) => ({
 *         ensureGenerated: async (workId: string) => {
 *             await ref.get(AppEnvService).ensureGenerated(workId);
 *         },
 *     }),
 *     inject: [ModuleRef],
 * }
 * ```
 *
 * Omitting the port is also correct: T15's listener generates on
 * `app.spec.applied` (ACC-07-01), and this resolver then fails closed with
 * `missingRequired` for a generated entry that has no row — never a silently
 * missing value.
 *
 * ## Reported, not silently absorbed (T14)
 *
 * 1. **The port's recipe type is narrower than the plan's.** Plan §4.6.1:447 and
 *    `packages/contracts/src/apps/app-env.ts:585-590` make `AppEnvRecipeEntry` —
 *    which HAS a `derived` member, because APW-05's `verify-plan.schema.json:202`
 *    permits it — the normative union, while
 *    `packages/agent/src/app-runtime/ports.ts:174-179`
 *    (`AppRuntimeEnvRecipeEntry`) knows only `generate | literal | template |
 *    prompted` and requires `secret`. This file therefore emits only those four
 *    sources, always with `secret` set, and expresses a bare reference as a
 *    one-token `template` (both unions and APW-05's schema carry it). The port's
 *    union should gain `derived`; APW-06 owns that file.
 * 2. **`t<…>` is `sha256` here, not in the contracts helper.** Plan §2.2:140 says
 *    `t<sha256 over the template or reference text plus the sorted pairs>`, but
 *    `appEnvTemplateFingerprint` (`contracts/src/apps/app-env.ts:243-255`)
 *    returns the canonical serialization WITHOUT hashing it. This file keeps the
 *    helper as the one owner of the pair-sorting rule and hashes its output
 *    ({@link appEnvSecretFingerprint}), which satisfies both the plan's wording
 *    and the helper's own docstring. Reported to the contracts owner.
 * 3. **The task text's `deps.postgres.url` omits the query parameter.** It prints
 *    `postgresql://ever-works-build:…@127.0.0.1:5432/app`; plan §4.6.2:459 ends
 *    the same URL with `?sslmode=disable`, and the plan is the spec of record,
 *    so the query parameter is emitted.
 * 4. **`smtpNotConfigured` has no i18n leaf.** Plan §4.9a:649 names the warning;
 *    plan §8:903 lists only `generatorChanged`, `publicPrefix` and `undeclared`
 *    under `dashboard.workDetail.appEnv.warnings.*`, and
 *    `contracts/src/apps/app-env.ts` has no constant for it. Exported here as
 *    {@link APP_ENV_RESOLUTION_WARNING_CODES} and reported (T1/T2 own the copy).
 * 5. **"An entry the App spec marks `required` on the env side" (§4.9a:650) has
 *    no field to live in.** `schema.md` §12:244-255 gives `env[]` no `required`:
 *    the only one is `prompt.required`, which cannot coexist with `from`
 *    (`env_source_count`, exactly one value source). This resolver reads
 *    `prompt.required === true` defensively if a spec somehow declares both, and
 *    otherwise follows the dependency's own `required` — reported to APW-03.
 * 6. **A keypair without its public half blocks the resolution.** T13 reports
 *    `publicHalfMissing` on the generation pass and cannot repair it (T10 has no
 *    "public half of an existing private key"); the pair is incomplete, so this
 *    resolver reports `<NAME>_PUBLIC` `missingRequired` rather than handing the
 *    app a private key whose public half nobody has. Rotation fixes it.
 * 7. **`isAppDependencyOutputSecret` says a bucket name is secret; it is not.**
 *    `contracts/src/apps/app-dependencies.ts:363-366` reads
 *    `APP_DEPENDENCY_OUTPUTS[kind][output] ?? true`, and `objectStorage`'s table
 *    keys the bucket output as the PATTERN `bucket.*` — so
 *    `isAppDependencyOutputSecret('objectStorage', 'bucket.attachments')` answers
 *    `true` while §11:236 says "the bucket *name* is not a credential". This file
 *    therefore calls APW-03's bucket-aware `dependencyOutputSecret`
 *    (`app-spec.refs.ts:566-570`, the same table, prefix handled), so an
 *    `objectStorage` bucket reference is not needlessly masked. Reported to the
 *    contracts owner; the two functions should agree.
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX,
    APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_REGION,
    APP_ENV_BUILD_SERVICE_OUTPUTS,
    APP_ENV_RUNNER_RECIPE_ENDPOINTS,
    APP_ENV_TEMPLATE_MAX_DEPTH,
    appEnvDependencyFingerprint,
    appEnvDependencyPasswordToken,
    appEnvPublicHalfName,
    appEnvStoredFingerprint,
    appEnvTemplateFingerprint,
    type AppDependencyKind,
    type AppDependencyStatus,
    type AppDeployTarget,
    type AppEnvFingerprints,
    type AppEnvRecipeEntry,
    type AppEnvRecipeToken,
    type AppEnvResolution,
    type AppEnvResolutionTarget,
    type AppEnvResolvedValue,
    type AppEnvUnresolved,
    type AppEnvUnresolvedReason,
    type AppSpec,
    type AppSpecBuildService,
    type AppSpecEnvEntry,
    type AppSpecEnvPhase,
} from '@ever-works/contracts';
import {
    dependencyOutputSecret,
    envEntryDeclaredSecret,
    envPhaseOf,
    tokenizeReference,
    tokenizeTemplate,
    type AppSpecDepReference,
    type AppSpecReference,
    type AppSpecTemplateReferencePart,
} from '../works-config/schema/app-spec.refs';
import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import { WorkAppEnvValue } from '../entities/work-app-env-value.entity';
import { WorkAppEnvValueRepository } from '../database/repositories/work-app-env-value.repository';
import { AppEnvCrypto } from './app-env-crypto';
import { generateAppEnvValue } from './generators';
import {
    APP_ENV_SPEC_SOURCE,
    AppEnvRefusalError,
    resolvedGenerateSpec,
    type AppEnvResolvedFingerprints,
    type AppEnvSpecSnapshot,
    type AppEnvSpecSource,
} from './app-env.service';

/* -------------------------------------------------------------------------- *
 * Warnings (plan §4.9a:647-651)
 * -------------------------------------------------------------------------- */

/**
 * The warnings a resolution can carry — plan §4.9a:649's `smtpNotConfigured`.
 *
 * Distinct from T13's `APP_ENV_WARNING_CODES` (`generatorChanged`,
 * `publicPrefix`, `undeclared`), which are warnings about a ROW; these are
 * warnings about a resolved reference. See item 4 of this file's docstring for
 * why the contract has no constant for them yet.
 */
export const APP_ENV_RESOLUTION_WARNING_CODES = ['smtpNotConfigured'] as const;

/** One resolution warning code. */
export type AppEnvResolutionWarningCode = (typeof APP_ENV_RESOLUTION_WARNING_CODES)[number];

/** One warning: the code, the entry, and the reference it came from. */
export interface AppEnvResolutionWarning {
    readonly code: AppEnvResolutionWarningCode;
    /** The entry whose value was left out. */
    readonly name: string;
    /** The reference that could not resolve, e.g. `deps.smtp.host`. */
    readonly ref: string | null;
}

/* -------------------------------------------------------------------------- *
 * Contexts and results
 * -------------------------------------------------------------------------- */

/**
 * What a resolution needs to know about the world outside the App spec.
 *
 * The runtime phase gets these from APW-06's `AppRuntimeEnvContext` (the port
 * forwards its own context straight through); the build phase gets the same four
 * fields from APW-05, which is why `resolveForBuild` takes this as an OPTIONAL
 * third argument (R-26: "a method gains an optional argument").
 */
export interface AppEnvResolutionContext {
    /** `domains.primary.url`; `null`/absent ⇒ `noPrimaryDomain`. */
    readonly primaryUrl?: string | null;
    /** `domains.primary.host`; `null`/absent ⇒ `noPrimaryDomain`. */
    readonly primaryHost?: string | null;
    /** `build.commitSha`; `null`/absent at build ⇒ `notAvailableAtBuild`. */
    readonly commitSha?: string | null;
    /** `components.<n>.internalUrl` by component name (CONTRACTS §1). */
    readonly internalUrls?: Record<string, string> | null;
}

/**
 * The ephemeral context (R-10) — the same four fields plus the target and, for
 * the `cluster` target, the in-memory dependency outputs APW-06 passes back from
 * `AppDependenciesService.provisionEphemeral` (plan §4.6.1:446, §5:831-835,
 * APW07-G04).
 */
export interface AppEnvEphemeralResolutionContext extends AppEnvResolutionContext {
    readonly target: AppEnvResolutionTarget;
    /** `{ postgres: { url, host, … }, … }` — in memory only, never stored (§5:832). */
    readonly dependencyOutputs?: Record<string, Record<string, string>> | null;
}

/**
 * What `ensureReadyForDeploy` answered (T16). Declared structurally so this file
 * does not import another service's module for a type, and so
 * `AppDependenciesService.ensureReadyForDeploy` satisfies it as-is
 * (`app-dependencies.service.ts:121-128`).
 */
export interface AppEnvDeployReadiness {
    readonly ready: boolean;
    readonly notReady: ReadonlyArray<{
        readonly kind: AppDependencyKind;
        readonly status: string;
        readonly reason: string | null;
    }>;
    /** Declared kinds whose provider makes them optional (FR-62 / §4.9a). */
    readonly optional: readonly AppDependencyKind[];
    /** Set when the question could not be answered at all. */
    readonly reason?: string;
}

/** One required value that has no value yet, with the copy its message prints (FR-26). */
export interface AppEnvMissingValue {
    readonly name: string;
    readonly description: string | null;
}

/** One destination an app pod has to reach (plan §4.6.1:434-435). */
export interface AppEnvEgressDestination {
    readonly host: string;
    readonly ports: number[];
}

/**
 * The result of one resolution pass: plan §2.2:113's `AppEnvResolution` plus the
 * three things APW-05/APW-06 read and the contract has no field for yet.
 */
export interface AppEnvResolutionResult extends AppEnvResolution {
    /** FR-62's "left out with a warning" items — never a blocker. */
    readonly warnings: AppEnvResolutionWarning[];
    /** Every required entry with no value, for FR-26's message (ACC-07-09). */
    readonly missingRequired: AppEnvMissingValue[];
    /** The destinations APW-06 opens; empty on the managed tier (§4.11). */
    readonly egress: AppEnvEgressDestination[];
}

/** The `cluster` ephemeral answer — values in memory, nothing stored (ACC-07-31). */
export interface AppEnvEphemeralClusterResolution {
    readonly values: Record<string, string>;
    readonly secretNames: string[];
    readonly unsetRequired: string[];
    readonly warnings: AppEnvResolutionWarning[];
    readonly unresolved: AppEnvUnresolved[];
}

/**
 * One recipe entry: the contracts union with `secret` materialised.
 *
 * `source` carries every `AppEnvRecipeSource` member — `derived` included —
 * because plan §4.6.1:447 makes `AppEnvRecipeEntry`
 * (`contracts/src/apps/app-env.ts:585-590`) the normative union and APW-05's
 * `verify-plan.schema.json:202` permits `derived`. The producer below still
 * emits only `generate | literal | prompted | template` (docstring item 1), so
 * this is a widened TYPE and no behaviour change — and it retires the
 * `Exclude<AppEnvRecipeEntry['source'], 'derived'>` this type used to carry,
 * whose only reason was `AppRuntimeEnvRecipeEntry`
 * (`packages/agent/src/app-runtime/ports.ts:185-196`) knowing four sources.
 * That port now declares all five, which turns its `derived` member into a
 * compile-time requirement of this file rather than a docstring request.
 */
export type AppEnvRuntimeRecipeEntry = AppEnvRecipeEntry & {
    readonly name: string;
    readonly secret: boolean;
};

/** The `runner` ephemeral answer — a recipe and **no value at all**. */
export interface AppEnvRunnerRecipeResolution {
    readonly recipe: AppEnvRuntimeRecipeEntry[];
    readonly secretNames: string[];
    readonly unsetRequired: string[];
    readonly warnings: AppEnvResolutionWarning[];
}

/* -------------------------------------------------------------------------- *
 * The seam this file needs from T13
 * -------------------------------------------------------------------------- */

/**
 * The generate-if-absent pass (plan §4.2:366 — "called from `app.spec.applied`
 * and at the start of every resolve").
 *
 * Bound to T13's `AppEnvService` (`{ useExisting: AppEnvService }`, or the
 * call-time factory of this file's docstring). Its answer is not read: the pass
 * is idempotent and the resolution reads the rows it wrote.
 */
export interface AppEnvGeneratorPass {
    ensureGenerated(
        workId: string,
    ): Promise<{ readonly created: ReadonlyArray<{ name: string }>; readonly reason?: string }>;
}

/** DI token for {@link AppEnvGeneratorPass} — bound to APW-07 T13's `AppEnvService`. */
export const APP_ENV_ENSURE_GENERATED = Symbol('APP_ENV_ENSURE_GENERATED');

/* -------------------------------------------------------------------------- *
 * Small pure helpers
 * -------------------------------------------------------------------------- */

/**
 * The secret `template`/`from` fingerprint of plan §2.2:140:
 * `t<sha256 over the template or reference text plus the sorted (placeholder,
 * fingerprint) pairs it resolved>`.
 *
 * `appEnvTemplateFingerprint` owns the canonical serialization (and the sorting
 * rule); this helper hashes it, which is what the plan asks for and what keeps a
 * 2 KB template from becoming a 2 KB fingerprint on a row. The input contains the
 * template TEXT and fingerprints only — never a value — so the digest can never
 * reveal one.
 */
export function appEnvSecretFingerprint(
    text: string,
    placeholders: readonly { readonly placeholder: string; readonly fingerprint: string }[],
): string {
    const canonical = appEnvTemplateFingerprint(text, placeholders);
    return `t${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** `sha256(value)` — the fingerprint of a NON-secret value (plan §2.2:141). */
export function appEnvValueFingerprint(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Does an entry of `entryPhase` take part in `phase`? (`both` takes part in each
 * — plan §2.2:112-113.)
 *
 * The ephemeral targets are not in `AppEnvPhase`: a `cluster` verification runs
 * the app, so it carries the runtime entries; the `runner` recipe carries every
 * entry, because APW-05's throwaway containers are the Build services AND the
 * run (§4.6.1:447).
 */
export function appEnvPhaseCarries(
    entryPhase: AppSpecEnvPhase,
    phase: 'build' | 'runtime',
): boolean {
    if (entryPhase === 'both') return true;
    return entryPhase === phase;
}

/** The `build.services[].name` each dependency kind is served by (plan §4.6.2:453-455). */
export const APP_ENV_BUILD_SERVICE_NAMES: Record<AppDependencyKind, string> = {
    postgres: 'postgres',
    redis: 'redis',
    objectStorage: 'object-storage',
    smtp: 'smtp',
};

/**
 * The three external providers of plan §4.10 — the only ones whose destinations
 * APW-06 has to open (§4.6.1:434-435). The in-cluster providers live inside the
 * namespace, and the managed tier's destinations belong to the zone (§4.11).
 */
export const APP_ENV_EXTERNAL_PROVIDER_IDS = [
    'smtp-external',
    's3-external',
    'platform-smtp-relay',
] as const;

/** The one provider that serves `platform.smtp.*` (plan §2.2:123, §4.10:662). */
export const APP_ENV_SMTP_RELAY_PROVIDER_ID = 'platform-smtp-relay' as const;

/** The `POSTGRES_*` names a `postgres` build service may carry (plan §4.6.2:459). */
export const APP_ENV_BUILD_SERVICE_POSTGRES_ENV = {
    user: 'POSTGRES_USER',
    password: 'POSTGRES_PASSWORD',
    database: 'POSTGRES_DB',
} as const;

/** The build service's own defaults, shared with APW-05 (plan §4.6.2:459). */
export const APP_ENV_BUILD_SERVICE_POSTGRES_DEFAULTS = {
    user: 'ever-works-build',
    password: 'ever-works-build',
    database: 'app',
} as const;

/**
 * The MinIO root-credential names an `objectStorage` build service may carry.
 *
 * Plan §4.6.2:461 says "keys from the service env root user/password or
 * `ever-works-build`/`ever-works-build`" without naming the variables; these are
 * the image's own spellings (`MINIO_ROOT_*`, plus the older
 * `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` pair), tried in order. A service that
 * carries none of them gets APW-05's defaults.
 */
export const APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_ENV = {
    accessKeyId: ['MINIO_ROOT_USER', 'MINIO_ACCESS_KEY'],
    secretAccessKey: ['MINIO_ROOT_PASSWORD', 'MINIO_SECRET_KEY'],
} as const;

/** The build service's own object-storage default (plan §4.6.2:461). */
export const APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_DEFAULT = 'ever-works-build';

/* -------------------------------------------------------------------------- *
 * Internal shapes
 * -------------------------------------------------------------------------- */

/** One stored `work_app_env_values` row, decrypted — an internal shape. */
interface StoredEnvValue {
    readonly name: string;
    readonly version: number;
    readonly origin: string;
    readonly value: string;
    readonly derivedFromName: string | null;
}

/** One `work_app_dependencies` row with its outputs decrypted — an internal shape. */
export interface AppEnvDependencyFact {
    readonly kind: AppDependencyKind;
    readonly status: AppDependencyStatus;
    readonly providerId: string | null;
    readonly outputsVersion: number;
    readonly outputs: Record<string, string>;
}

/** Everything one resolution pass reads, resolved once. */
interface ResolutionScope {
    readonly spec: AppSpec;
    readonly phase: 'build' | 'runtime';
    readonly ephemeral: boolean;
    readonly target: AppDeployTarget;
    readonly ctx: AppEnvResolutionContext;
    readonly entries: ReadonlyMap<string, AppSpecEnvEntry>;
    readonly stored: ReadonlyMap<string, StoredEnvValue>;
    readonly buildServices: ReadonlyMap<string, AppSpecBuildService>;
    readonly dependencyFacts: ReadonlyMap<AppDependencyKind, AppEnvDependencyFact>;
    readonly ephemeralOutputs: ReadonlyMap<AppDependencyKind, Record<string, string>>;
    readonly optionalKinds: ReadonlySet<AppDependencyKind>;
    readonly buckets: readonly string[];
    readonly warnings: AppEnvResolutionWarning[];
    /** Outcomes already computed at the top level, keyed by name. */
    readonly memo: Map<string, EntryOutcome>;
}

/** What one entry resolved to. `fingerprint` is `''` for an ephemeral value (no map to compare). */
type EntryOutcome =
    | {
          readonly kind: 'value';
          readonly value: string;
          readonly secret: boolean;
          readonly fingerprint: string;
          /** A keypair's public half, when this pass generated it in memory. */
          readonly publicValue?: string | null;
      }
    | {
          readonly kind: 'unresolved';
          readonly reason: AppEnvUnresolvedReason;
          readonly ref: string | null;
      }
    | { readonly kind: 'omitted'; readonly ref: string | null }
    | { readonly kind: 'absent' };

/**
 * What one reference resolved to.
 *
 * `direct` is `d<outputsVersion>` for a live dependency output and `digest` is a
 * sha256 of a value that is safe to hash (a non-secret value, a build-service
 * output, or the managed tier's `ew-dep://` token). Exactly one of them is set
 * for a real value; both are `null` for an ephemeral dependency output, whose
 * value is never persisted and therefore never fingerprinted.
 */
type ReferenceOutcome =
    | {
          readonly kind: 'value';
          readonly value: string;
          readonly secret: boolean;
          readonly direct: string | null;
          readonly digest: string | null;
          /** True for a Build's own throwaway service output (§2.2:141's exception). */
          readonly fromBuildService?: boolean;
      }
    | { readonly kind: 'unresolved'; readonly reason: AppEnvUnresolvedReason; readonly ref: string }
    | { readonly kind: 'omitted'; readonly ref: string };

/* -------------------------------------------------------------------------- *
 * The resolver
 * -------------------------------------------------------------------------- */

@Injectable()
export class AppEnvResolver implements AppEnvResolvedFingerprints {
    private readonly logger = new Logger(AppEnvResolver.name);

    constructor(
        @Optional()
        @Inject(APP_ENV_SPEC_SOURCE)
        private readonly spec?: AppEnvSpecSource,
        // T8's UI-facing read: "which names are set" (its docstring names this
        // pass). The envelope is NOT on that read, which is why the entity's own
        // repository is the second, targeted read below — exactly T13's split
        // (`app-env.service.ts:690-692`).
        @Optional() private readonly values?: WorkAppEnvValueRepository,
        @Optional()
        @InjectRepository(WorkAppEnvValue)
        private readonly rows?: Repository<WorkAppEnvValue>,
        @Optional() private readonly crypto?: AppEnvCrypto,
        @Optional()
        @InjectRepository(WorkAppDependency)
        private readonly dependencyRows?: Repository<WorkAppDependency>,
        @Optional()
        @Inject(APP_ENV_ENSURE_GENERATED)
        private readonly generatorPass?: AppEnvGeneratorPass,
    ) {}

    /* ---------------------------------------------------------------------- *
     * The build phase — plan §4.6.2, ACC-07-10 / ACC-07-13
     * ---------------------------------------------------------------------- */

    /**
     * Resolve every `build`/`both` entry against the Build's ephemeral services.
     *
     * FR-22: a dependency output resolves to the Build's own throwaway service
     * (`build.services[]`), never to a live dependency — which is why this path
     * reads no `work_app_dependencies` row at all. `platform.smtp.*` and
     * `components.<n>.internalUrl` are `notAvailableAtBuild` (§4.6.2:464), and a
     * build-phase reference with no service of its kind is `noBuildService`.
     */
    async resolveForBuild(
        workId: string,
        buildServices?: readonly AppSpecBuildService[] | null,
        ctx?: AppEnvResolutionContext | null,
    ): Promise<AppEnvResolutionResult> {
        await this.ensureGenerated(workId);

        const snapshot = await this.readSpec(workId);
        return this.resolveBuildPhase(workId, snapshot, buildServices ?? [], ctx);
    }

    /** The build phase over one spec snapshot and one service list. */
    private async resolveBuildPhase(
        workId: string,
        snapshot: AppEnvSpecSnapshot | null,
        buildServices: readonly AppSpecBuildService[],
        ctx?: AppEnvResolutionContext | null,
    ): Promise<AppEnvResolutionResult> {
        const scope = await this.buildScope(
            workId,
            snapshot,
            'build',
            false,
            'your-cluster',
            ctx ?? {},
            buildServices,
        );
        return this.resolveScope(scope);
    }

    /* ---------------------------------------------------------------------- *
     * The runtime phase — plan §2.2 / §4.6.1
     * ---------------------------------------------------------------------- */

    /**
     * Resolve every `runtime`/`both` entry for a Deploy.
     *
     * `readiness` is `AppDependenciesService.ensureReadyForDeploy(workId)`'s
     * answer, computed ONCE by the caller (`AppEnvRuntimeSource.resolve`): its
     * `optional` kinds are what §4.9a's non-blocking SMTP rule keys on, and this
     * method never asks again — one call is what GAP-05's dispatch-on-`pending`
     * contract allows.
     */
    async resolveRuntime(
        workId: string,
        ctx: {
            readonly target: AppDeployTarget;
            readonly primaryUrl?: string | null;
            readonly primaryHost?: string | null;
            readonly buildCommitSha?: string | null;
            readonly internalUrls?: Record<string, string> | null;
        },
        readiness?: AppEnvDeployReadiness | null,
    ): Promise<AppEnvResolutionResult> {
        await this.ensureGenerated(workId);

        const snapshot = await this.readSpec(workId);
        const scope = await this.buildScope(
            workId,
            snapshot,
            'runtime',
            false,
            ctx?.target ?? 'your-cluster',
            {
                primaryUrl: ctx?.primaryUrl ?? null,
                primaryHost: ctx?.primaryHost ?? null,
                commitSha: ctx?.buildCommitSha ?? null,
                internalUrls: ctx?.internalUrls ?? null,
            },
            null,
            readiness ?? null,
        );
        return this.resolveScope(scope);
    }

    /* ---------------------------------------------------------------------- *
     * Ephemeral mode — R-10, ACC-07-31
     * ---------------------------------------------------------------------- */

    /**
     * `resolveEphemeral`'s `cluster` target: values generated in memory for a
     * verification namespace, derived references taken from
     * `ctx.dependencyOutputs`, and **nothing written anywhere**.
     *
     * It runs the runtime entries (a verification namespace runs the app) and
     * never calls the generate-if-absent pass: that pass writes.
     */
    async resolveEphemeralForCluster(
        workId: string,
        ctx: AppEnvEphemeralResolutionContext,
    ): Promise<AppEnvEphemeralClusterResolution> {
        const snapshot = await this.readSpec(workId);
        const scope = await this.buildScope(
            workId,
            snapshot,
            'runtime',
            true,
            'your-cluster',
            ctx ?? {},
            null,
            null,
            ctx?.dependencyOutputs ?? null,
        );
        const resolved = this.resolveScope(scope);

        return {
            values: valuesToRecord(resolved.values),
            secretNames: resolved.values.filter((entry) => entry.secret).map((entry) => entry.name),
            unsetRequired: resolved.missingRequired.map((entry) => entry.name),
            warnings: resolved.warnings,
            unresolved: resolved.unresolved,
        };
    }

    /**
     * `resolveEphemeral`'s `runner` target: the value-free recipe APW-05's runner
     * verification materialises (plan §4.6.1:447).
     *
     * **No value is produced at all** — no `values`, no generated secret, no
     * dependency output. The recipe carries the generator parameters, the
     * literals already public in the App spec, the prompted names the runner
     * fetches itself, and the fixed container-host grammar of the throwaway
     * services (`postgres` / `redis` / `object-storage`, with the dependency
     * password as `{{gen:DEP_<KIND>_PASSWORD}}`).
     *
     * The context is accepted for symmetry with the `cluster` target and is
     * deliberately not read: the recipe must not depend on anything that would
     * have to be re-resolved (`domains.*`, `components.*`, `build.commitSha` and
     * `platform.smtp.*` stay as `dep` tokens for the runner to substitute).
     */
    async buildRunnerRecipe(
        workId: string,
        _ctx?: AppEnvEphemeralResolutionContext | null,
    ): Promise<AppEnvRunnerRecipeResolution> {
        const snapshot = await this.readSpec(workId);
        const spec = snapshot?.spec ?? null;
        const warnings: AppEnvResolutionWarning[] = [];
        const recipe: AppEnvRuntimeRecipeEntry[] = [];
        const secretNames: string[] = [];
        const unsetRequired: string[] = [];

        if (!spec) {
            return { recipe, secretNames, unsetRequired, warnings };
        }

        const entries = indexEntries(spec);
        const seen = new Set<string>();

        for (const entry of spec.env ?? []) {
            if (!entry?.name || seen.has(entry.name)) continue;
            if (entries.get(entry.name) !== entry) continue;
            seen.add(entry.name);

            const secret = envEntryDeclaredSecret(entry);
            if (entry.prompt && entry.prompt.required !== false) {
                // The runner fetches every prompted value itself, so every
                // required one has to be supplied by it (§4.6.1:447).
                unsetRequired.push(entry.name);
            }

            const recipeEntry = runnerRecipeEntry(entry, secret, entries);
            if (!recipeEntry) continue;
            recipe.push(recipeEntry);
            if (secret) secretNames.push(entry.name);
        }

        return { recipe, secretNames, unsetRequired, warnings };
    }

    /* ---------------------------------------------------------------------- *
     * FR-24's comparison input — T13's `APP_ENV_RESOLVER_FINGERPRINTS` swap
     * ---------------------------------------------------------------------- */

    /**
     * The current per-name fingerprints of one phase, for T13's `list`.
     *
     * `null` means "cannot answer" and leaves both change flags `false`, which is
     * T13's documented answer for an unbound or unreadable seam.
     *
     * The build phase resolves against the effective spec's OWN
     * `build.services[]` — the list APW-05's prepare runner passes to
     * `resolveForBuild` (`app-build-prepare.runner.ts` `resolveBuildValues`).
     * This map is also the verdict's current-inputs term
     * (`AppBuildsService.readCurrentInputs` → §5.1's `staleInputs` clause), and the
     * prepare-time hash covers every value the plugin syncs, build-service ones
     * included. An earlier revision resolved against an EMPTY list, which turned
     * every build-service reference into `noBuildService`, dropped it from this
     * map, and left every Build of a Work whose build env reads a build service
     * permanently `staleInputs`.
     */
    async read(
        workId: string,
        phase: 'build' | 'runtime',
        ctx?: AppEnvResolutionContext | null,
    ): Promise<AppEnvFingerprints | null> {
        try {
            const resolved =
                phase === 'build'
                    ? await this.resolveBuildWithSpecServices(workId, ctx ?? null)
                    : await this.resolveRuntime(
                          workId,
                          {
                              target: 'your-cluster',
                              primaryUrl: ctx?.primaryUrl ?? null,
                              primaryHost: ctx?.primaryHost ?? null,
                              buildCommitSha: ctx?.commitSha ?? null,
                              internalUrls: ctx?.internalUrls ?? null,
                          },
                          null,
                      );

            const fingerprints: AppEnvFingerprints = {};
            for (const value of resolved.values) {
                if (value.fingerprint.length > 0) fingerprints[value.name] = value.fingerprint;
            }
            return fingerprints;
        } catch (error) {
            this.logger.warn(
                `App env: the ${phase} fingerprints of work ${workId} could not be resolved (${describeError(error)}).`,
            );
            return null;
        }
    }

    /**
     * {@link resolveForBuild} with the service list taken from the same spec
     * snapshot the entries come from, so one spec read answers both.
     */
    private async resolveBuildWithSpecServices(
        workId: string,
        ctx: AppEnvResolutionContext | null,
    ): Promise<AppEnvResolutionResult> {
        await this.ensureGenerated(workId);

        const snapshot = await this.readSpec(workId);
        return this.resolveBuildPhase(workId, snapshot, snapshot?.spec?.build?.services ?? [], ctx);
    }

    /* ---------------------------------------------------------------------- *
     * Reading the world
     * ---------------------------------------------------------------------- */

    private async buildScope(
        workId: string,
        snapshot: AppEnvSpecSnapshot | null,
        phase: 'build' | 'runtime',
        ephemeral: boolean,
        target: AppDeployTarget,
        ctx: AppEnvResolutionContext,
        buildServices?: readonly AppSpecBuildService[] | null,
        readiness?: AppEnvDeployReadiness | null,
        ephemeralOutputs?: Record<string, Record<string, string>> | null,
    ): Promise<ResolutionScope> {
        const spec: AppSpec = snapshot?.spec ?? { env: [] };

        return {
            spec,
            phase,
            ephemeral,
            target,
            ctx,
            entries: indexEntries(spec),
            stored: await this.readStoredValues(workId, ephemeral),
            buildServices: new Map(
                (buildServices ?? [])
                    .filter((service) => typeof service?.name === 'string')
                    .map((service) => [service.name, service]),
            ),
            // The managed tier's row never has an outputs envelope at all
            // (§3.2:230) and the platform must not hold one (§4.11:689-693), so
            // this path does not read them: every dependency reference is a
            // placeholder and `egress` is empty on that target.
            dependencyFacts:
                ephemeral || target === 'ever-works-apps'
                    ? new Map<AppDependencyKind, AppEnvDependencyFact>()
                    : await this.readDependencyFacts(workId),
            ephemeralOutputs: new Map(
                Object.entries(ephemeralOutputs ?? {}) as [
                    AppDependencyKind,
                    Record<string, string>,
                ][],
            ),
            optionalKinds: new Set(readiness?.optional ?? []),
            buckets: (spec.dependencies?.objectStorage?.buckets ?? []).filter(
                (bucket): bucket is string => typeof bucket === 'string',
            ),
            warnings: [],
            memo: new Map<string, EntryOutcome>(),
        };
    }

    /** The effective App spec, or `null` — never a thrown read in a caller's face. */
    private async readSpec(workId: string): Promise<AppEnvSpecSnapshot | null> {
        if (!this.spec) {
            return null;
        }
        try {
            return (await this.spec.read(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `App env: the App spec of work ${workId} could not be read (${describeError(error)}).`,
            );
            return null;
        }
    }

    /**
     * Every stored value of the App Work, decrypted.
     *
     * Two reads, exactly as T13 splits them: T8's `findByWork` is the "which
     * names are set" pass (its own docstring names this consumer, and it is the
     * read that deliberately withholds the envelope), and the entity's repository
     * is the targeted envelope read for the names that pass the filter. A row that
     * exists is therefore a name that is SET even if its value cannot be read, and
     * an unreadable value is a refusal rather than a silently missing name
     * (plan §9.2:950).
     *
     * Ephemeral mode reads neither a GENERATED row nor a derived public half
     * (R-10), and because the filter runs on the METADATA before the second read,
     * their envelopes are never even loaded: the fresh pair is generated in
     * memory, and a stored public half would describe a private key this
     * verification does not hold.
     */
    private async readStoredValues(
        workId: string,
        ephemeral: boolean,
    ): Promise<Map<string, StoredEnvValue>> {
        const stored = new Map<string, StoredEnvValue>();
        if (!this.rows || !workId) {
            return stored;
        }

        let facts: Array<Pick<StoredEnvValue, 'name' | 'version' | 'origin' | 'derivedFromName'>>;
        try {
            const metadata = this.values ? await this.values.findByWork(workId) : null;
            facts = metadata
                ? metadata.map((row) => ({
                      name: row.name,
                      version: row.version ?? 1,
                      origin: row.origin,
                      derivedFromName: row.derivedFromName ?? null,
                  }))
                : (await this.rows.find({ where: { workId } })).map((row) => ({
                      name: row.name,
                      version: row.version ?? 1,
                      origin: row.origin,
                      derivedFromName: row.derivedFromName ?? null,
                  }));
        } catch (error) {
            this.logger.warn(
                `App env: the stored values of work ${workId} could not be read (${describeError(error)}).`,
            );
            return stored;
        }

        const wanted = [
            ...new Set(
                facts
                    .filter(
                        (fact) =>
                            fact.name &&
                            !(
                                ephemeral &&
                                (fact.origin === 'generated' || fact.origin === 'derived')
                            ),
                    )
                    .map((fact) => fact.name),
            ),
        ];
        if (wanted.length === 0) {
            return stored;
        }

        let envelopes: WorkAppEnvValue[];
        try {
            envelopes = await this.rows.find({ where: { workId, name: In(wanted) } });
        } catch (error) {
            this.logger.warn(
                `App env: the stored values of work ${workId} could not be read (${describeError(error)}).`,
            );
            return stored;
        }

        const byName = new Map(envelopes.map((row) => [row.name, row]));
        for (const fact of facts) {
            const row = byName.get(fact.name);
            if (!row) continue;
            stored.set(fact.name, {
                name: fact.name,
                version: fact.version ?? row.version ?? 1,
                origin: fact.origin,
                value: this.decrypt(row),
                derivedFromName: fact.derivedFromName ?? row.derivedFromName ?? null,
            });
        }

        return stored;
    }

    /** One envelope, or the 503 refusal of plan §9.2:949-950. */
    private decrypt(row: WorkAppEnvValue): string {
        if (!this.crypto || typeof row.valueEncrypted !== 'string') {
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                "Secure storage isn't configured on this installation.",
                503,
            );
        }
        try {
            return this.crypto.decrypt(row.valueEncrypted);
        } catch {
            // Never the value, and never the wrapped error's own text.
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                `The stored value ${row.name} cannot be read on this installation.`,
                503,
            );
        }
    }

    /**
     * The active dependency rows of the App Work, with their outputs decrypted.
     *
     * `outputsEncrypted` is one JSON envelope per row (plan §3.2:216) and a
     * managed-tier row never has one (§3.2:230), so an unreadable or absent
     * envelope simply means "no outputs" — the reference then reports
     * `dependencyNotReady`, which is the fail-closed direction (FR-23).
     */
    private async readDependencyFacts(
        workId: string,
    ): Promise<Map<AppDependencyKind, AppEnvDependencyFact>> {
        const facts = new Map<AppDependencyKind, AppEnvDependencyFact>();
        if (!this.dependencyRows || !workId) {
            return facts;
        }

        let rows: WorkAppDependency[];
        try {
            rows = await this.dependencyRows.find({ where: { workId } });
        } catch (error) {
            this.logger.warn(
                `App env: the dependency rows of work ${workId} could not be read (${describeError(error)}).`,
            );
            return facts;
        }

        for (const row of rows) {
            if (!row?.kind) continue;
            if (row.status === 'kept' || row.status === 'deleted') continue;
            facts.set(row.kind, {
                kind: row.kind,
                status: row.status,
                providerId: row.providerId ?? null,
                outputsVersion: row.outputsVersion ?? 0,
                outputs: this.readOutputs(row.outputsEncrypted),
            });
        }

        return facts;
    }

    /** One row's outputs, decrypted and parsed; `{}` when there are none. */
    private readOutputs(envelope?: string | null): Record<string, string> {
        if (!envelope || !this.crypto) {
            return {};
        }
        try {
            const parsed: unknown = JSON.parse(this.crypto.decrypt(envelope));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return {};
            }
            const outputs: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'string') outputs[key] = value;
            }
            return outputs;
        } catch (error) {
            this.logger.warn(
                `App env: a dependency's outputs could not be read (${describeError(error)}).`,
            );
            return {};
        }
    }

    /* ---------------------------------------------------------------------- *
     * The pass itself
     * ---------------------------------------------------------------------- */

    /** Walk the participating entries of the scope and assemble the result. */
    private resolveScope(scope: ResolutionScope): AppEnvResolutionResult {
        const values: AppEnvResolvedValue[] = [];
        const unresolved: AppEnvUnresolved[] = [];
        const missingRequired: AppEnvMissingValue[] = [];

        for (const entry of scope.spec.env ?? []) {
            if (!entry?.name) continue;
            if (scope.entries.get(entry.name) !== entry) continue;
            if (!appEnvPhaseCarries(envPhaseOf(entry), scope.phase)) continue;

            const outcome = this.evaluateEntry(scope, entry.name, 1, []);

            if (outcome.kind === 'value') {
                values.push({
                    name: entry.name,
                    value: outcome.value,
                    secret: outcome.secret,
                    fingerprint: outcome.fingerprint,
                });
                this.pushPublicHalf(scope, entry, outcome, values, unresolved);
                continue;
            }
            if (outcome.kind === 'omitted' || outcome.kind === 'absent') continue;

            if (outcome.reason === 'missingRequired' && isRequiredEntry(entry)) {
                missingRequired.push({
                    name: entry.name,
                    description: entry.description ?? entry.prompt?.description ?? null,
                });
            }
            unresolved.push({ name: entry.name, reason: outcome.reason, ref: outcome.ref });
        }

        const fingerprints: AppEnvFingerprints = {};
        for (const value of values) {
            if (value.fingerprint.length > 0) fingerprints[value.name] = value.fingerprint;
        }

        return {
            values,
            unresolved,
            fingerprints,
            warnings: scope.warnings,
            missingRequired,
            egress: this.collectEgress(scope),
        };
    }

    /**
     * FR-14/FR-15: a keypair exposes `<NAME>_PUBLIC` and nothing else.
     *
     * Non-ephemeral: the derived row T13 wrote is the value (`v<version>`), and a
     * pair whose public half is missing reports `missingRequired` rather than
     * handing the app a private key nobody can verify (docstring item 6).
     * Ephemeral: the half the in-memory generation just produced, so the pair
     * always matches.
     */
    private pushPublicHalf(
        scope: ResolutionScope,
        entry: AppSpecEnvEntry,
        outcome: Extract<EntryOutcome, { kind: 'value' }>,
        values: AppEnvResolvedValue[],
        unresolved: AppEnvUnresolved[],
    ): void {
        if (entry.generate?.kind !== 'keypair') return;

        const publicName = appEnvPublicHalfName(entry.name);
        if (scope.entries.has(publicName)) return;
        if (values.some((value) => value.name === publicName)) return;

        if (typeof outcome.publicValue === 'string' && outcome.publicValue.length > 0) {
            values.push({
                name: publicName,
                value: outcome.publicValue,
                secret: false,
                fingerprint: '',
            });
            return;
        }

        const stored = scope.stored.get(publicName);
        if (stored) {
            values.push({
                name: publicName,
                value: stored.value,
                secret: false,
                fingerprint: appEnvStoredFingerprint(stored.version),
            });
            return;
        }

        unresolved.push({ name: publicName, reason: 'missingRequired', ref: null });
    }

    /**
     * One entry, by name: the §2.2 table row by row.
     *
     * `depth` is 1 for an entry resolved for itself and grows by one per
     * `{{env.<NAME>}}` hop; `path` is the chain being resolved, so a cycle fails
     * closed instead of hanging (the spec reports `template_cycle` separately —
     * this is the runtime's own guard).
     */
    private evaluateEntry(
        scope: ResolutionScope,
        name: string,
        depth: number,
        path: readonly string[],
    ): EntryOutcome {
        if (depth > APP_ENV_TEMPLATE_MAX_DEPTH) {
            return { kind: 'unresolved', reason: 'templateUnresolvable', ref: name };
        }
        if (path.includes(name)) {
            return { kind: 'unresolved', reason: 'templateUnresolvable', ref: name };
        }
        if (path.length === 0) {
            const memoised = scope.memo.get(name);
            if (memoised) return memoised;
        }

        const entry = scope.entries.get(name);
        if (!entry) {
            return { kind: 'absent' };
        }

        const outcome = this.evaluateEntryUncached(scope, entry, depth, path);
        if (path.length === 0) {
            scope.memo.set(name, outcome);
        }
        return outcome;
    }

    private evaluateEntryUncached(
        scope: ResolutionScope,
        entry: AppSpecEnvEntry,
        depth: number,
        path: readonly string[],
    ): EntryOutcome {
        const declaredSecret = envEntryDeclaredSecret(entry);
        const chain = [...path, entry.name];

        // 1. A stored row wins for EVERY source (§2.2:117 "stored override",
        //    §2.2:118-119 "stored value"): the row is the value the platform
        //    actually handed out, so it is the one a Build or Deploy must see.
        const stored = scope.stored.get(entry.name);
        if (stored) {
            return {
                kind: 'value',
                value: stored.value,
                secret: declaredSecret,
                fingerprint: appEnvStoredFingerprint(stored.version),
            };
        }

        // 2. `generate` with no row: the pass has already run (or could not), so
        //    this is a missing value and never an invented one.
        if (entry.generate) {
            return scope.ephemeral
                ? this.generateEphemeral(entry, declaredSecret)
                : { kind: 'unresolved', reason: 'missingRequired', ref: null };
        }

        // 3. `prompt` with no row (§2.2:119: required blocks, optional is omitted).
        if (entry.prompt) {
            if (entry.prompt.required === false) {
                return { kind: 'absent' };
            }
            return { kind: 'unresolved', reason: 'missingRequired', ref: null };
        }

        // 4. A `value` literal (never secret — APW-03 R8).
        if (typeof entry.value === 'string') {
            return {
                kind: 'value',
                value: entry.value,
                secret: declaredSecret,
                fingerprint: declaredSecret
                    ? appEnvSecretFingerprint(entry.value, [])
                    : appEnvValueFingerprint(entry.value),
            };
        }

        // 5. `from:` — a bare Reference (§21:421-428).
        if (typeof entry.from === 'string') {
            return this.evaluateFrom(scope, entry, entry.from, declaredSecret, depth, chain);
        }

        // 6. `template:` — literals and `{{ … }}` placeholders (§21:429).
        if (typeof entry.template === 'string') {
            return this.evaluateTemplate(
                scope,
                entry,
                entry.template,
                declaredSecret,
                depth,
                chain,
            );
        }

        // 7. No source at all is a spec error (`env_source_count`); there is no
        //    value to hand out, so the entry blocks (FR-23).
        return { kind: 'unresolved', reason: 'missingRequired', ref: null };
    }

    /** A `generate` entry of an EPHEMERAL resolution: fresh, in memory, never stored. */
    private generateEphemeral(entry: AppSpecEnvEntry, declaredSecret: boolean): EntryOutcome {
        try {
            const generated = generateAppEnvValue(resolvedGenerateSpec(entry.generate as never));
            return {
                kind: 'value',
                value: generated.value,
                secret: declaredSecret,
                // Fresh every call by design (ACC-07-31): there is no version and
                // no persisted map, so an ephemeral value has no fingerprint.
                fingerprint: '',
                publicValue: generated.publicValue ?? null,
            };
        } catch (error) {
            this.logger.warn(
                `App env: ${entry.name} cannot be generated for a verification (${describeError(error)}).`,
            );
            return { kind: 'unresolved', reason: 'missingRequired', ref: null };
        }
    }

    /** A `from:` reference, wrapped in the entry-level fingerprint rule. */
    private evaluateFrom(
        scope: ResolutionScope,
        entry: AppSpecEnvEntry,
        text: string,
        declaredSecret: boolean,
        depth: number,
        chain: readonly string[],
    ): EntryOutcome {
        const parsed = tokenizeReference(text);
        if (!parsed.ok || !parsed.reference) {
            return { kind: 'unresolved', reason: 'templateUnresolvable', ref: parsed.text };
        }

        const outcome = this.evaluateReference(scope, parsed.reference, depth, chain);
        if (outcome.kind !== 'value') {
            return outcome.kind === 'omitted'
                ? this.omit(scope, entry.name, outcome.ref)
                : { kind: 'unresolved', reason: outcome.reason, ref: outcome.ref };
        }

        const secret = declaredSecret || outcome.secret;
        // §2.2:139-141, in this order: a direct dependency output keeps its
        // `d<outputsVersion>`; a build service keeps `sha256(value)` (its outputs
        // are non-secret by construction, §4.6.2:455); a SECRET entry gets the
        // template rule over its reference text and the source's own identity, so
        // no bare hash of a secret value is ever produced; everything else is
        // `sha256(value)`.
        const fingerprint = outcome.direct
            ? outcome.direct
            : outcome.fromBuildService
              ? (outcome.digest ?? appEnvValueFingerprint(outcome.value))
              : secret
                ? appEnvSecretFingerprint(
                      parsed.reference.text,
                      outcome.digest === null
                          ? []
                          : [{ placeholder: parsed.reference.text, fingerprint: outcome.digest }],
                  )
                : (outcome.digest ?? appEnvValueFingerprint(outcome.value));

        return { kind: 'value', value: outcome.value, secret, fingerprint };
    }

    /** A `template:` — tokenise, resolve, substitute, depth re-checked (§4.6.1:449). */
    private evaluateTemplate(
        scope: ResolutionScope,
        entry: AppSpecEnvEntry,
        text: string,
        declaredSecret: boolean,
        depth: number,
        chain: readonly string[],
    ): EntryOutcome {
        const placeholders: { placeholder: string; fingerprint: string }[] = [];
        let value = '';
        let secret = declaredSecret;

        for (const part of tokenizeTemplate(text)) {
            if (part.kind === 'literal') {
                value += part.text;
                continue;
            }
            if (part.kind === 'syntax') {
                return {
                    kind: 'unresolved',
                    reason: 'templateUnresolvable',
                    ref: part.placeholder,
                };
            }

            const reference = (part as AppSpecTemplateReferencePart).reference;
            const outcome = this.evaluateReference(scope, reference, depth, chain);
            if (outcome.kind === 'omitted') {
                return this.omit(scope, entry.name, outcome.ref);
            }
            if (outcome.kind === 'unresolved') {
                return { kind: 'unresolved', reason: outcome.reason, ref: outcome.ref };
            }

            value += outcome.value;
            secret = secret || outcome.secret;
            placeholders.push({
                placeholder: part.placeholder,
                fingerprint: outcome.direct ?? outcome.digest ?? '',
            });
        }

        return {
            kind: 'value',
            value,
            secret,
            fingerprint: secret
                ? appEnvSecretFingerprint(text, placeholders)
                : appEnvValueFingerprint(value),
        };
    }

    /**
     * One reference of the §21 grammar — the §2.2 table's right-hand column.
     *
     * `depth`/`chain` are only used by `env.<NAME>`, the one reference that
     * resolves through another entry.
     */
    private evaluateReference(
        scope: ResolutionScope,
        reference: AppSpecReference,
        depth: number,
        chain: readonly string[],
    ): ReferenceOutcome {
        switch (reference.kind) {
            case 'domain': {
                const value =
                    reference.output === 'url'
                        ? (scope.ctx.primaryUrl ?? null)
                        : (scope.ctx.primaryHost ?? null);
                if (!value) {
                    return { kind: 'unresolved', reason: 'noPrimaryDomain', ref: reference.text };
                }
                return this.plainValue(value);
            }

            case 'build': {
                const value = scope.ctx.commitSha ?? null;
                if (!value) {
                    return {
                        kind: 'unresolved',
                        reason: 'notAvailableAtBuild',
                        ref: reference.text,
                    };
                }
                return this.plainValue(value);
            }

            case 'component': {
                const value = scope.ctx.internalUrls?.[reference.component] ?? null;
                if (!value) {
                    // A component address never exists at build time
                    // (§4.6.2:464); at runtime a missing one is a render gap.
                    // Both fail closed.
                    return {
                        kind: 'unresolved',
                        reason:
                            scope.phase === 'build'
                                ? 'notAvailableAtBuild'
                                : 'templateUnresolvable',
                        ref: reference.text,
                    };
                }
                return this.plainValue(value);
            }

            case 'platform':
                return this.evaluatePlatformSmtp(scope, reference.output, reference.text);

            case 'dep':
                return this.evaluateDependencyReference(scope, reference);

            case 'env':
            default: {
                const outcome = this.evaluateEntry(scope, reference.entry, depth + 1, chain);
                if (outcome.kind === 'value') {
                    return {
                        kind: 'value',
                        value: outcome.value,
                        secret: outcome.secret,
                        direct: null,
                        digest: outcome.fingerprint.length > 0 ? outcome.fingerprint : null,
                    };
                }
                if (outcome.kind === 'omitted') {
                    return { kind: 'omitted', ref: outcome.ref ?? reference.text };
                }
                if (outcome.kind === 'unresolved') {
                    return { kind: 'unresolved', reason: outcome.reason, ref: reference.text };
                }
                return { kind: 'unresolved', reason: 'templateUnresolvable', ref: reference.text };
            }
        }
    }

    /** A non-secret value that is safe to hash (`domains.*`, `build.*`, `components.*`). */
    private plainValue(value: string): ReferenceOutcome {
        return {
            kind: 'value',
            value,
            secret: false,
            direct: null,
            digest: appEnvValueFingerprint(value),
        };
    }

    /** `platform.smtp.*` — a relay output at runtime, `notAvailableAtBuild` at build. */
    private evaluatePlatformSmtp(
        scope: ResolutionScope,
        output: string,
        text: string,
    ): ReferenceOutcome {
        if (scope.phase === 'build') {
            return { kind: 'unresolved', reason: 'notAvailableAtBuild', ref: text };
        }

        // The managed tier never sees outputs (§4.11:689-693), so the reference
        // becomes the zone's token — the relay serves both targets (GAP-22).
        if (scope.target === 'ever-works-apps') {
            const placeholder = `ew-dep://smtp/${output}`;
            return {
                kind: 'value',
                value: placeholder,
                secret: dependencyOutputSecret('smtp', output),
                direct: null,
                digest: appEnvValueFingerprint(placeholder),
            };
        }

        const fact = scope.dependencyFacts.get('smtp');
        if (!fact || fact.providerId !== APP_ENV_SMTP_RELAY_PROVIDER_ID) {
            // No relay is selected: `relayNotSelected`, and an OPTIONAL smtp
            // dependency leaves the entry out with its warning (§4.9a:647-651)
            // instead of blocking the Deploy.
            if (scope.optionalKinds.has('smtp')) {
                return { kind: 'omitted', ref: text };
            }
            return { kind: 'unresolved', reason: 'relayNotSelected', ref: text };
        }

        if (fact.status !== 'ready') {
            if (scope.optionalKinds.has('smtp')) {
                return { kind: 'omitted', ref: text };
            }
            return { kind: 'unresolved', reason: 'dependencyNotReady', ref: text };
        }

        const value = fact.outputs[output];
        if (typeof value !== 'string') {
            return { kind: 'unresolved', reason: 'dependencyNotReady', ref: text };
        }

        return {
            kind: 'value',
            value,
            secret: dependencyOutputSecret('smtp', output),
            direct: appEnvDependencyFingerprint(fact.outputsVersion),
            digest: null,
        };
    }

    /** `deps.<kind>.<output>` — build service, live outputs, or the managed token. */
    private evaluateDependencyReference(
        scope: ResolutionScope,
        reference: AppSpecDepReference,
    ): ReferenceOutcome {
        // The managed tier: the platform holds no outputs, so the reference
        // becomes the zone's literal token — decided from the TARGET, never from
        // the stored row.
        if (scope.target === 'ever-works-apps') {
            const placeholder = `ew-dep://${reference.dependency}/${reference.output}`;
            return {
                kind: 'value',
                value: placeholder,
                secret: dependencyOutputSecret(reference.dependency, reference.output),
                direct: null,
                digest: appEnvValueFingerprint(placeholder),
            };
        }

        if (scope.phase === 'build') {
            return this.evaluateBuildServiceReference(scope, reference);
        }

        if (scope.ephemeral) {
            const outputs = scope.ephemeralOutputs.get(reference.dependency);
            const value = outputs?.[reference.output];
            if (typeof value !== 'string') {
                return { kind: 'unresolved', reason: 'dependencyNotReady', ref: reference.text };
            }
            return {
                kind: 'value',
                value,
                secret: dependencyOutputSecret(reference.dependency, reference.output),
                // Nothing is stored and nothing is compared: no fingerprint inputs.
                direct: null,
                digest: null,
            };
        }

        const fact = scope.dependencyFacts.get(reference.dependency);
        if (!fact || fact.status !== 'ready') {
            if (scope.optionalKinds.has(reference.dependency)) {
                return { kind: 'omitted', ref: reference.text };
            }
            return { kind: 'unresolved', reason: 'dependencyNotReady', ref: reference.text };
        }

        const value = fact.outputs[reference.output];
        if (typeof value !== 'string') {
            // A ready row that does not publish the output is the `degraded
            // outputsUnavailable` case of plan §9.2:955 — the reference blocks.
            return { kind: 'unresolved', reason: 'dependencyNotReady', ref: reference.text };
        }

        return {
            kind: 'value',
            value,
            secret: dependencyOutputSecret(reference.dependency, reference.output),
            direct: appEnvDependencyFingerprint(fact.outputsVersion),
            digest: null,
        };
    }

    /**
     * A build-phase dependency output — the Build's own ephemeral service
     * (FR-22: "a build-phase reference with no such service is reported as a
     * missing build value"), from the §4.6.2 table.
     */
    private evaluateBuildServiceReference(
        scope: ResolutionScope,
        reference: AppSpecDepReference,
    ): ReferenceOutcome {
        const serviceName = APP_ENV_BUILD_SERVICE_NAMES[reference.dependency];
        const service = serviceName ? scope.buildServices.get(serviceName) : undefined;
        if (!service) {
            return { kind: 'unresolved', reason: 'noBuildService', ref: reference.text };
        }

        const value = buildServiceOutputs(scope, reference.dependency, service)[reference.output];
        if (typeof value !== 'string') {
            return { kind: 'unresolved', reason: 'noBuildService', ref: reference.text };
        }

        return {
            kind: 'value',
            value,
            secret: false,
            direct: null,
            digest: appEnvValueFingerprint(value),
            fromBuildService: true,
        };
    }

    /** Record the §4.9a omission and hand the entry back as `omitted`. */
    private omit(scope: ResolutionScope, name: string, ref: string | null): EntryOutcome {
        if (!scope.warnings.some((warning) => warning.name === name && warning.ref === ref)) {
            scope.warnings.push({ code: 'smtpNotConfigured', name, ref });
        }
        return { kind: 'omitted', ref };
    }

    /**
     * The destinations APW-06 opens: the READY external providers' own hosts and
     * ports (§4.6.1:434-435). In-cluster providers need nothing (they are inside
     * the namespace) and the managed tier's destinations are the zone's business
     * (§4.11), so both contribute nothing — which is also why this is empty on
     * the managed target, where no output is read at all.
     */
    private collectEgress(scope: ResolutionScope): AppEnvEgressDestination[] {
        const byHost = new Map<string, Set<number>>();

        for (const fact of scope.dependencyFacts.values()) {
            if (fact.status !== 'ready') continue;
            if (!isExternalProvider(fact.providerId)) continue;

            const destination = externalDestination(fact);
            if (!destination) continue;
            const ports = byHost.get(destination.host) ?? new Set<number>();
            for (const port of destination.ports) ports.add(port);
            byHost.set(destination.host, ports);
        }

        return [...byHost.entries()]
            .map(([host, ports]) => ({
                host,
                ports: [...ports].sort((left, right) => left - right),
            }))
            .sort((left, right) => (left.host < right.host ? -1 : left.host > right.host ? 1 : 0));
    }

    /** The generate-if-absent pass, once per resolve, only when one is bound. */
    private async ensureGenerated(workId: string): Promise<void> {
        if (!this.generatorPass) {
            return;
        }
        try {
            await this.generatorPass.ensureGenerated(workId);
        } catch (error) {
            this.logger.warn(
                `App env: generating the missing values of work ${workId} failed (${describeError(error)}).`,
            );
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/** The declared entries of a spec by name, first declaration winning. */
function indexEntries(spec: AppSpec): Map<string, AppSpecEnvEntry> {
    const entries = new Map<string, AppSpecEnvEntry>();
    for (const entry of spec.env ?? []) {
        if (!entry?.name) continue;
        if (!entries.has(entry.name)) entries.set(entry.name, entry);
    }
    return entries;
}

/** True when an entry's absence blocks (FR-26): a required prompt. */
function isRequiredEntry(entry: AppSpecEnvEntry): boolean {
    if (entry.prompt) return entry.prompt.required !== false;
    return false;
}

/** `Record<name, value>` from the resolved list — the port's `values` shape. */
export function valuesToRecord(values: readonly AppEnvResolvedValue[]): Record<string, string> {
    const record: Record<string, string> = {};
    for (const value of values) {
        record[value.name] = value.value;
    }
    return record;
}

/** The build service's env value for one name, or `null`. */
function buildServiceEnv(service: AppSpecBuildService, name: string): string | null {
    const found = (service.env ?? []).find((entry) => entry?.name === name);
    return found && typeof found.value === 'string' ? found.value : null;
}

/** The first of `names` that is set in the service's env, or `null`. */
function firstBuildServiceEnv(
    service: AppSpecBuildService,
    names: readonly string[],
): string | null {
    for (const name of names) {
        const value = buildServiceEnv(service, name);
        if (value !== null) return value;
    }
    return null;
}

/**
 * The build service's outputs for one kind — plan §4.6.2:457-462, with the
 * host/port/region/from defaults read from the contract's own table so the two
 * cannot drift.
 *
 * Every output is non-secret by construction ("Outputs of a build service (all
 * non-secret, flagged `fromBuildService`)", §4.6.2:455), which is why the
 * password of a throwaway service is part of the URL and the fingerprint table's
 * `sha256(value)` arm applies to all of them.
 */
export function buildServiceOutputs(
    scope: { readonly buckets: readonly string[] },
    kind: AppDependencyKind,
    service: AppSpecBuildService,
): Record<string, string> {
    const table = APP_ENV_BUILD_SERVICE_OUTPUTS[kind];
    const host = table.host;
    const port = service.port ?? table.port;

    switch (kind) {
        case 'postgres': {
            const user =
                buildServiceEnv(service, APP_ENV_BUILD_SERVICE_POSTGRES_ENV.user) ??
                APP_ENV_BUILD_SERVICE_POSTGRES_DEFAULTS.user;
            const password =
                buildServiceEnv(service, APP_ENV_BUILD_SERVICE_POSTGRES_ENV.password) ??
                APP_ENV_BUILD_SERVICE_POSTGRES_DEFAULTS.password;
            const database =
                buildServiceEnv(service, APP_ENV_BUILD_SERVICE_POSTGRES_ENV.database) ??
                APP_ENV_BUILD_SERVICE_POSTGRES_DEFAULTS.database;
            const url = `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=disable`;
            return { url, directUrl: url, host, port: String(port), database, user, password };
        }
        case 'redis':
            return { url: `redis://${host}:${port}/0`, host, port: String(port), password: '' };
        case 'objectStorage': {
            const outputs: Record<string, string> = {
                endpoint: `http://${host}:${port}`,
                region: table.region ?? APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_REGION,
                accessKeyId:
                    firstBuildServiceEnv(
                        service,
                        APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_ENV.accessKeyId,
                    ) ?? APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_DEFAULT,
                secretAccessKey:
                    firstBuildServiceEnv(
                        service,
                        APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_ENV.secretAccessKey,
                    ) ?? APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_DEFAULT,
            };
            for (const bucket of scope.buckets) {
                outputs[`${APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX}${bucket}`] = bucket;
            }
            return outputs;
        }
        case 'smtp':
        default:
            return {
                host,
                port: String(port),
                user: '',
                password: '',
                from: table.from ?? '',
                secure: 'false',
            };
    }
}

/** Is this row's provider one of the three external ones? (plan §4.10) */
function isExternalProvider(providerId: string | null): boolean {
    return (
        providerId !== null &&
        (APP_ENV_EXTERNAL_PROVIDER_IDS as readonly string[]).includes(providerId)
    );
}

/** One external provider's destination, or `null` when its outputs do not carry one. */
function externalDestination(fact: AppEnvDependencyFact): { host: string; ports: number[] } | null {
    if (fact.kind === 'smtp') {
        const host = fact.outputs.host;
        const port = Number(fact.outputs.port);
        if (typeof host !== 'string' || host.length === 0) return null;
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
        return { host, ports: [port] };
    }
    if (fact.kind === 'objectStorage') {
        const endpoint = fact.outputs.endpoint;
        if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
        try {
            const url = new URL(endpoint);
            const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
            if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
            return { host: url.hostname, ports: [port] };
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * One entry of the runner recipe (plan §4.6.1:447) — the fixed container-host
 * grammar, and never a value.
 *
 * A `keypair`'s `<NAME>_PUBLIC` half is deliberately NOT an entry: the runner
 * derives both halves from the one `genpkey` it runs, while the `cluster` target
 * materialises the pair here and therefore includes it.
 */
function runnerRecipeEntry(
    entry: AppSpecEnvEntry,
    secret: boolean,
    entries: ReadonlyMap<string, AppSpecEnvEntry>,
): AppEnvRuntimeRecipeEntry | null {
    if (entry.generate) {
        return {
            name: entry.name,
            secret: true,
            source: 'generate',
            spec: resolvedGenerateSpec(entry.generate as never),
        };
    }

    if (typeof entry.value === 'string') {
        return { name: entry.name, secret, source: 'literal', spec: { value: entry.value } };
    }

    if (entry.prompt) {
        return {
            name: entry.name,
            secret,
            source: 'prompted',
            spec: { required: entry.prompt.required !== false },
        };
    }

    if (typeof entry.from === 'string') {
        const parsed = tokenizeReference(entry.from);
        if (!parsed.ok || !parsed.reference) {
            return {
                name: entry.name,
                secret,
                source: 'template',
                spec: { text: entry.from, tokens: [] as AppEnvRecipeToken[] },
            };
        }
        const rendered = runnerReference(parsed.reference, entries);
        return { name: entry.name, secret, source: 'template', spec: rendered };
    }

    if (typeof entry.template === 'string') {
        return {
            name: entry.name,
            secret,
            source: 'template',
            spec: runnerTemplate(entry.template, entries),
        };
    }

    return null;
}

/**
 * A `template:` as the runner sees it: the same text with every placeholder
 * expanded to what the runner substitutes, plus the token list that names each
 * one (`gen` / `prompted` / `dep`, plan §4.6.1:447).
 */
function runnerTemplate(
    text: string,
    entries: ReadonlyMap<string, AppSpecEnvEntry>,
): { text: string; tokens: AppEnvRecipeToken[] } {
    const tokens: AppEnvRecipeToken[] = [];
    let rendered = '';

    for (const part of tokenizeTemplate(text)) {
        if (part.kind === 'literal') {
            rendered += part.text;
            continue;
        }
        if (part.kind === 'syntax') {
            rendered += part.placeholder;
            continue;
        }

        const reference = (part as AppSpecTemplateReferencePart).reference;
        const expansion = runnerExpansion(reference, part.placeholder, entries);
        tokens.push(...expansion.tokens);
        rendered += expansion.text;
    }

    return { text: rendered, tokens };
}

/** A bare `from:` reference as the runner sees it. */
function runnerReference(
    reference: AppSpecReference,
    entries: ReadonlyMap<string, AppSpecEnvEntry>,
): { text: string; tokens: AppEnvRecipeToken[] } {
    return runnerExpansion(reference, `{{${reference.text}}}`, entries);
}

/**
 * One placeholder's expansion: the text the runner writes, and the tokens it has
 * to resolve. An `env.<NAME>` placeholder becomes the `gen`/`prompted` token of
 * the entry it reads; a dependency output becomes the container grammar (or the
 * reference itself when the grammar has nothing to say about it).
 */
function runnerExpansion(
    reference: AppSpecReference,
    placeholder: string,
    entries: ReadonlyMap<string, AppSpecEnvEntry>,
): { text: string; tokens: AppEnvRecipeToken[] } {
    if (reference.kind === 'env') {
        const target = entries.get(reference.entry);
        if (target?.generate) {
            const rewritten = `{{gen:${reference.entry}}}`;
            return {
                text: rewritten,
                tokens: [{ kind: 'gen', name: reference.entry, placeholder: rewritten }],
            };
        }
        if (target?.prompt) {
            const rewritten = `{{prompted:${reference.entry}}}`;
            return {
                text: rewritten,
                tokens: [{ kind: 'prompted', name: reference.entry, placeholder: rewritten }],
            };
        }
    }

    if (reference.kind === 'dep') {
        const grammar = runnerDependencyLiteral(reference.dependency, reference.output);
        if (grammar) return grammar;
    }

    return {
        text: placeholder,
        tokens: [{ kind: 'dep', name: reference.text, placeholder }],
    };
}

/**
 * The fixed container-host grammar of plan §4.6.1:447, built from the contract's
 * own endpoint table so the two epics cannot drift: `postgres` → host
 * `postgres`, port `5432`, user/db `ever-works-build`/`app`; `redis` → host
 * `redis`, port `6379`, password `""`; `objectStorage` → host `object-storage`,
 * port `9000`, access key `ever-works-build`. The dependency password is
 * `{{gen:DEP_<KIND>_PASSWORD}}`, uppercased from the kind.
 *
 * `null` means the grammar says nothing about this output (`smtp`, …): the caller
 * then emits the reference itself, which is exactly what a `dep` token is for.
 */
export function runnerDependencyLiteral(
    kind: AppDependencyKind,
    output: string,
): { text: string; tokens: AppEnvRecipeToken[] } | null {
    const passwordToken: AppEnvRecipeToken = {
        kind: 'gen',
        name: appEnvDependencyPasswordToken(kind),
        placeholder: `{{gen:${appEnvDependencyPasswordToken(kind)}}}`,
    };
    const literal = (value: string) => ({ text: value, tokens: [] as AppEnvRecipeToken[] });

    switch (kind) {
        case 'postgres': {
            const endpoint = APP_ENV_RUNNER_RECIPE_ENDPOINTS.postgres;
            switch (output) {
                case 'url':
                case 'directUrl':
                    return {
                        text: `postgresql://${endpoint.user}:${passwordToken.placeholder}@${endpoint.host}:${endpoint.port}/${endpoint.database}`,
                        tokens: [passwordToken],
                    };
                case 'host':
                    return literal(endpoint.host);
                case 'port':
                    return literal(String(endpoint.port));
                case 'user':
                    return literal(endpoint.user);
                case 'database':
                    return literal(endpoint.database);
                case 'password':
                    return { text: passwordToken.placeholder, tokens: [passwordToken] };
                default:
                    return null;
            }
        }
        case 'redis': {
            const endpoint = APP_ENV_RUNNER_RECIPE_ENDPOINTS.redis;
            switch (output) {
                case 'url':
                    return literal(`redis://${endpoint.host}:${endpoint.port}/0`);
                case 'host':
                    return literal(endpoint.host);
                case 'port':
                    return literal(String(endpoint.port));
                case 'password':
                    return literal(endpoint.password);
                default:
                    return null;
            }
        }
        case 'objectStorage': {
            const endpoint = APP_ENV_RUNNER_RECIPE_ENDPOINTS.objectStorage;
            if (output.startsWith(APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX)) {
                return literal(output.slice(APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX.length));
            }
            switch (output) {
                case 'endpoint':
                    return literal(`http://${endpoint.host}:${endpoint.port}`);
                case 'region':
                    return literal(APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_REGION);
                case 'accessKeyId':
                    return literal(endpoint.accessKeyId);
                case 'secretAccessKey':
                    return { text: passwordToken.placeholder, tokens: [passwordToken] };
                default:
                    return null;
            }
        }
        case 'smtp':
        default:
            // §4.6.1:447 fixes three kinds; an `smtp` reference in a runner recipe
            // falls back to the reference itself.
            return null;
    }
}

/** An error's NAME, for a log line that must never carry a value. */
function describeError(error: unknown): string {
    if (error instanceof Error) return error.name;
    return typeof error === 'string' ? 'Error' : typeof error;
}
