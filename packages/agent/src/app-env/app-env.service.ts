/**
 * APW-07 T13 — `AppEnvService`: the Environment table's own service
 * (plan §4.2:361-375).
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * FR-1…FR-34 (the table, secrecy, generators, keypairs, validation, limits),
 * S1 (`spec.md:90-94`), S3, S5, S6, S15, S16, S17, S21, S25, S27;
 * ACC-07-01, -03, -07, -08, -09, -11, -12, -13. Plan §2.2 (`plan.md:110-150`) is
 * the comparison rule this file's change flags implement, §4.2 the method table,
 * §3.1 (`plan.md:176-200`) the columns it writes, §4.3 the generators (T10),
 * §4.4 the validator (T11) and §4.5 the `.env` grammar (T12).
 *
 * ## What this service composes, and what it never re-implements
 *
 * It owns the **decisions**: which names exist, which of them are set, what each
 * row's origin is, what a call changes, what a member is allowed to do, and what
 * the table may see. Everything mechanical is somebody else's and is called, not
 * copied:
 *
 * | Layer                        | Owner                                  | This file           |
 * | ---------------------------- | -------------------------------------- | ------------------- |
 * | `enc::v1::` envelope         | T9 `AppEnvCrypto`                      | calls               |
 * | value production             | T10 `generators.ts`                    | calls               |
 * | value validation + patterns  | T11 `validation.ts`                    | calls               |
 * | rows, `version + 1`, racing  | T8 `WorkAppEnvValueRepository`         | calls               |
 * | `.env` grammar               | T12 `dotenv-parser.ts`                 | calls (landed)      |
 * | the effective App spec       | APW-03 T12 `AppSpecService`            | seam                |
 * | change fingerprints          | APW-07 T14, APW-05, APW-06             | seams               |
 * | Activity                     | APW-07 T26 `app-env.activity.ts`       | seam                |
 * | actor display names          | APW-01's Work-member read              | seam                |
 *
 * ## ACC-07-12: the write happens after the key is checked, never before
 *
 * Plan §4.2 fixes the order — encrypt, then write — and this file follows it
 * literally: `ensureGenerated` and `apply` call {@link AppEnvCrypto.isAvailable}
 * (or `assertAvailable`, through `AppEnvCrypto.encrypt`) **before the first
 * repository call**, so an installation with no `PLUGIN_SECRET_ENCRYPTION_KEY`
 * answers `secureStorageUnavailable` (503) with the table untouched. A refusal
 * that happened after a row was written would still have stored a value, which
 * is the outcome S21 exists to prevent.
 *
 * ## FR-12/ACC-07-03: nothing here regenerates implicitly
 *
 * `ensureGenerated` is a **generate-if-absent** pass: an entry that has a row is
 * skipped before a value is produced, so a re-apply of the same App spec, a
 * rebuild, a redeploy and an upstream sync are all the same no-op. The only two
 * paths that replace a value are `apply` (a member typed a new one, or an import
 * that was confirmed) and `rotate` (FR-13) — and `rotate` requires the typed
 * name. A generator that changed in the App spec sets `generatorChanged`
 * (FR-12), never a new value.
 *
 * ## The resolved spec, not the contract's bare default (reported)
 *
 * `appEnvGeneratorFingerprint` (`packages/contracts/src/apps/app-env.ts:218-222`)
 * defaults an omitted `bytes`/`length` to the **minimum** (16), while the App
 * spec schema and APW-03's `generatedLength` default both to **32** — the number
 * T10's generators actually use (`generators.ts:53-67`). This service therefore
 * fingerprints {@link resolvedGenerateSpec}'s output (defaults always explicit),
 * so a row's `generatorFingerprint` describes the value stored beside it, and a
 * bare `base64:16` can never be recorded for a 44-character value. The contract
 * is not edited; the inconsistency is reported to its owner instead.
 *
 * ## An empty value is `unset`, never a stored empty string (decided)
 *
 * `PluginSecretEncService` cannot read back a 28-byte envelope, so
 * `AppEnvCrypto.encrypt('')` refuses with `valueUnstorable`
 * (`app-env-crypto.ts:220-232`) — a limitation of the wrapped envelope, and the
 * plugin file is off-limits. A member clearing the field in the Set dialog means
 * "remove this value", so a `set` (or an import line) whose value is empty is
 * routed to the **unset** path: the row is removed and the result says `unset`.
 * No empty value is ever stored, and `valueUnstorable` is unreachable from here.
 *
 * ## `version + 1` per written name, and why a re-set is not a no-op
 *
 * FR-33's "last-writer-wins per name and idempotent" is per name, not per value:
 * a second `set` of the same value bumps the version again, because deciding "the
 * value is unchanged" would mean decrypting a stored value to compare it — and
 * FR-5/§2.2:143 forbid both that and any hash of a secret value. `changed` in the
 * result therefore lists the names the call **wrote**, which is the only list
 * this service can honestly produce.
 *
 * ## Every collaborator is optional, and every absence has an answer
 *
 * As `app-dependencies.service.ts:44-60` documents for its own seams, the class
 * must be constructible with nothing bound (a lean module graph, this file's own
 * spec), so every dependency is `@Optional()` and no absent answer is "pretend it
 * worked":
 *
 * | Absent seam                        | The answer                                                                        |
 * | ---------------------------------- | --------------------------------------------------------------------------------- |
 * | `WorkAppEnvValueRepository` (T8)   | `list` answers `[]`, writes answer `storeUnavailable`, a redactor is refused       |
 * | `Repository<WorkAppEnvValue>`      | the public half and the redactor's value list answer "nothing to read"             |
 * | `AppEnvCrypto` (T9)                | every write is refused `secureStorageUnavailable`; no plaintext fallback exists    |
 * | `AppEnvSpecSource` (APW-03)        | `list` answers `[]`, `apply`/`ensureGenerated` change nothing and report the reason |
 * | `AppEnvDotenvParser` (T12)         | the import group is refused and reported (`importUnavailable`) — never "0 imported" |
 * | `AppEnvActivity` (T26)             | the change is applied, `activityRecorded: false`, one warning logged               |
 * | `AppEnvRecordedFingerprints`       | `changedSinceBuild`/`changedSinceDeploy` are `false` — never a guess               |
 * | `AppEnvResolvedFingerprints` (T14) | an entry with no stored row has no fingerprint, so its flags stay `false`          |
 * | `AppEnvActorNames` (APW-01)        | `updatedBy.name` stays `null` rather than rendering a uuid as a person             |
 *
 * ## Reported, not silently absorbed
 *
 * 1. **"One transaction per call" (plan §4.2:367) is honoured as one *unit of
 *    work*.** The plan asks `apply` to refuse all on a storage error. Every
 *    storage error this service can detect — no key, an unbound store, an
 *    unreadable App spec — is detected **before the first write**, which is
 *    exactly what ACC-07-12 and FR-30's "all-or-nothing for storage errors" are
 *    about. It cannot wrap T8's writes in one database transaction: the
 *    repository's methods queue themselves on the DataSource
 *    (`single-connection-write-queue.ts:38-41`) and a transaction around them
 *    would wait on its own tail on better-sqlite3 — the default driver. A *mid-
 *    call* database failure therefore stops the writes and reports the remaining
 *    items `refused` with `reason: 'storeUnavailable'`, so the caller sees
 *    exactly what was applied. The fix belongs to T8's owner (a transactional
 *    entry point on the repository) and is reported rather than worked around.
 * 2. **`notGenerated` is not in the contract's code list.** Plan §5:799 names it
 *    (422, rotate on an entry that is not generated) but `APP_ENV_API_ERROR_CODES`
 *    (`app-env.ts:331-340`) does not carry it, so it has no `en.json` leaf and
 *    T2's key test cannot see it. Declared here, reported to T1's owner.
 * 3. **There is no code for FR-28's 500-line paste ceiling.** The two pre-parse
 *    limits reuse the closest existing codes (`valueTooLarge` for 64 KiB + 1,
 *    `tooManyValues` for 501 lines) and the message names the real limit.
 * 4. **A keypair whose public half is missing cannot be repaired here.** T10
 *    exposes no "public half of an existing private key", and regenerating the
 *    pair is forbidden (FR-12), so the pass reports
 *    `skipped: { code: 'publicHalfMissing' }` and rotation fixes it. A
 *    `publicHalfOf(privateValue, format)` in `generators.ts` closes it.
 * 5. **The 10-per-hour rotation cap is not enforced here.** Plan §5:786 puts it
 *    on the route (`POST …/rotate`, "10/hour / Work"), and no column or table
 *    records rotation history, so a service-side counter would be process-local
 *    and wrong behind more than one instance.
 * 6. **The `.env` parser in this file is provisional.** See the block below.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    APP_ENV_KEYPAIR_DEFAULT_FORMAT,
    APP_ENV_MAX_STORED,
    APP_ENV_PUBLIC_HALF_MAX_BYTES,
    APP_ENV_REDACT_MIN_CHARS,
    APP_ENV_TOTAL_MAX_BYTES,
    appEnvGeneratorFingerprint,
    appEnvPublicHalfName,
    appEnvStoredFingerprint,
    hasAppEnvPublicPrefix,
    type AppEnvEntrySource,
    type AppEnvEntryView,
    type AppEnvErrorCode,
    type AppEnvGeneratorKind,
    type AppEnvKeypairFormat,
    type AppEnvOrigin,
    type AppEnvPhase,
    type AppEnvStoredOrigin,
    type AppSpec,
    type AppSpecEnvEntry,
    type AppEnvRecipeGenerateSpec,
} from '@ever-works/contracts';
import { AppEnvCrypto, isAppEnvEncryptionUnavailableError } from './app-env-crypto';
import {
    APP_ENV_GENERATOR_DEFAULT_ALPHABET,
    APP_ENV_GENERATOR_DEFAULT_BYTES,
    APP_ENV_GENERATOR_DEFAULT_KEYPAIR_TYPE,
    APP_ENV_GENERATOR_DEFAULT_LENGTH,
    generateAppEnvValue,
    type AppEnvGeneratedValue,
} from './generators';
import { validateAppEnvValue, type AppEnvValidationRefusal } from './validation';
// T12's `.env` grammar — the frozen API of `dotenv-parser.ts` (see the block
// above {@link APP_ENV_SPEC_SOURCE} for what this file does and does not do with
// it). Its refusals already carry the contract's codes and a line-scoped
// message that names neither the name nor the value (FR-19, FR-30).
import { parseAppEnvDotenv } from './dotenv-parser.js';
import type {
    AppEnvDotenvDuplicate,
    AppEnvDotenvEntry,
    AppEnvDotenvRefusal,
} from './dotenv-parser.js';
import {
    WorkAppEnvValueRepository,
    type WorkAppEnvValueMetadata,
} from '../database/repositories/work-app-env-value.repository';
import { WorkAppEnvValue } from '../entities/work-app-env-value.entity';
import { envEntryDeclaredSecret, envPhaseOf } from '../works-config/schema/app-spec.refs';

/* -------------------------------------------------------------------------- *
 * The caller, and the shapes another owner reads
 * -------------------------------------------------------------------------- */

/**
 * The person a route has already authenticated (APW-01's
 * `AppWorkAccessService.resolve`, APW07-G13).
 *
 * `name` is the caller's own display name — the Set dialog's "Set · by you" row
 * needs it — and `canEdit` is the access the route already resolved; neither is
 * re-derived here (FR-32 is T24's).
 */
export interface AppEnvActor {
    readonly userId: string;
    readonly name?: string | null;
    readonly canEdit?: boolean;
}

/** `list(workId, viewer)`'s second parameter — the same resolved caller. */
export type AppEnvViewer = AppEnvActor;

/** The effective App spec and the identity of the commit it was read from. */
export interface AppEnvSpecSnapshot {
    /** APW-03's canonical hash — the pattern cache's key (plan §4.4:408). */
    readonly specHash: string | null;
    readonly commitSha: string | null;
    readonly spec: AppSpec;
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's, named as its owner
 * fixes it (the programme's established pattern: `app-runtime/ports.ts`,
 * `app-dependencies.service.ts:224-346`).
 * -------------------------------------------------------------------------- */

// ── provisional — APW-03 T12 `AppSpecService` ────────────────────────────────
//
// This comment used to say `AppSpecService.getEffectiveSpec(workId, commitSha?)`
// "does not exist in this tree". It does — `app-spec.service.ts:940` — and it
// has since APW-03 T12 landed. The consequence of believing otherwise was total:
// this seam is what every read in this file goes through, so unbound meant
// `list` answered `[]`, `missingRequired` found nothing missing and
// `ensureGenerated` had nothing to generate, for every App Work.
//
// The adapter is `app-env-spec.source.ts` and `AppEnvModule` binds it. It maps a
// USABLE status — `valid` or `valid_with_warnings`, `APP_SPEC_USABLE_STATUSES`
// — to the snapshot below and everything else to `null`. An earlier draft of
// this comment asked for `valid` alone; that would drop every env value of an
// App Work whose spec has one cosmetic warning, which is a bigger failure than
// the one failing closed guards against.

/** The effective App spec of one App Work. */
export interface AppEnvSpecSource {
    read(workId: string): Promise<AppEnvSpecSnapshot | null>;
}

/** DI token for {@link AppEnvSpecSource} — owned by APW-03 T12. */
export const APP_ENV_SPEC_SOURCE = Symbol('APP_ENV_SPEC_SOURCE');

// ── provisional — APW-01's Work-member read ──────────────────────────────────
//
// `AppEnvEntryView.updatedBy` is `{ userId, name }` (plan §3.3:293) and S3
// renders "Set · by Maya". The caller's own name comes from {@link AppEnvActor};
// every other actor's comes from here, and an absent name stays `null` rather
// than rendering a uuid as a person.
//
// The swap is `{ provide: APP_ENV_ACTOR_NAMES, useExisting: WorkMemberService }`.

/** The display name of one member of one App Work's account. */
export interface AppEnvActorNames {
    nameOf(workId: string, userId: string): Promise<string | null>;
}

/** DI token for {@link AppEnvActorNames} — owned by APW-01. */
export const APP_ENV_ACTOR_NAMES = Symbol('APP_ENV_ACTOR_NAMES');

// ── T12 `dotenv-parser.ts` — LANDED, consumed, not re-implemented ─────────────
//
// `apply({ import })` calls `parseAppEnvDotenv` directly (the frozen API of
// `packages/agent/src/app-env/dotenv-parser.ts`, T12's) and does the four things
// that belong to THIS file:
//
//   1. names the contract code of a whole-paste refusal (`{ ok: false }` carries
//      `tooManyValues` / `valuesTooLarge` — FR-28's 500-line and 64 KiB ceilings,
//      both already in `APP_ENV_API_ERROR_CODES`);
//   2. maps a superseded duplicate (`duplicates`) to FR-29's `skipped`;
//   3. maps a line refusal to its `refused` item, with the parser's own
//      line-scoped message;
//   4. runs every surviving entry through `validateAppEnvValue`, which is where
//      FR-17's `length`/`minLength`/`maxLength`/`pattern` and FR-18's NUL ban
//      live — the parser deliberately does none of those.
//
// There is deliberately no seam here: the parser is a pure function with no
// collaborators, so an `@Optional()` port would only add a way for an import to
// answer "0 imported, all good" when nothing could be parsed.

// ── provisional — APW-05's `WorkBuild.buildValueFingerprints` ────────────────
//
// FR-24's "Changed since the last build" compares an entry's current
// fingerprint with the map APW-05 persists on the latest Build with
// `deployable = true` on the tracked branch (plan §2.2:144-146). The swap is
// `{ provide: APP_ENV_BUILD_FINGERPRINTS, useExisting: WorkBuildService }`.

/** The recorded per-name fingerprints of the last deployable Build. */
export interface AppEnvRecordedFingerprints {
    /** `null` when there is no such Build, or the row predates the column (§2.2:148). */
    read(workId: string): Promise<Record<string, string> | null>;
}

/** DI token for APW-05's Build fingerprint map. */
export const APP_ENV_BUILD_FINGERPRINTS = Symbol('APP_ENV_BUILD_FINGERPRINTS');

// ── provisional — APW-06's `appRender.envFingerprints` ───────────────────────
//
// The Deployment half of the same rule: the map inside
// `WorkAppRuntimeState.currentDeploymentId`'s `appRender` (plan §2.2:146). The
// swap is
// `{ provide: APP_ENV_DEPLOY_FINGERPRINTS, useExisting: AppRuntimeFacadeService }`.

/** The recorded per-name fingerprints of the current Deployment. */
export interface AppEnvDeployedFingerprints {
    read(workId: string): Promise<Record<string, string> | null>;
}

/** DI token for APW-06's Deployment fingerprint map. */
export const APP_ENV_DEPLOY_FINGERPRINTS = Symbol('APP_ENV_DEPLOY_FINGERPRINTS');

// ── provisional — APW-07 T14 `AppEnvResolver` ────────────────────────────────
//
// §2.2's current-fingerprint rule needs the resolver for every entry that has no
// stored row: `d<outputsVersion>` for a direct dependency output, `t<…>` for a
// secret template, `sha256(value)` for a non-secret or build-service value.
// `AppEnvResolver` returns exactly this map, with the same keys as `values`
// (plan §2.2:143-146). The swap is
// `{ provide: APP_ENV_RESOLVER_FINGERPRINTS, useExisting: AppEnvResolver }`.

/** The current per-name fingerprints of one resolution phase. */
export interface AppEnvResolvedFingerprints {
    read(workId: string, phase: 'build' | 'runtime'): Promise<Record<string, string> | null>;
}

/** DI token for APW-07 T14's resolver fingerprints. */
export const APP_ENV_RESOLVER_FINGERPRINTS = Symbol('APP_ENV_RESOLVER_FINGERPRINTS');

// ── provisional — APW-07 T26 `app-env.activity.ts` ───────────────────────────
//
// T26 owns `packages/agent/src/app-env/app-env.activity.ts` AND the
// `ActivityActionType.APP_ENV = 'app_env'` member it writes with
// (`tasks.md:396-403`). That member is not in `activity-log.types.ts` yet, and
// adding it here would break `entities/__tests__/activity-log.types.spec.ts`,
// whose enum-literal count is pinned and whose `FEED_KIND_RULES` coverage
// (`activity-log/feed-kind.ts`) T26 also owes. So the emission is a port:
// the swap is
// `{ provide: APP_ENV_ACTIVITY, useExisting: AppEnvActivityService }`, whose
// `emit` calls `ActivityLogService.log({ actionType: ActivityActionType.APP_ENV, … })`.
//
// 🛑 The `actionType` string below is the value T26's enum member must carry.
// The two are the same string on purpose: a rename on either side must be a
// failing test in T26's spec, not a row nobody can filter.

/** The two dotted events of FR-8 (Resolution R-2). */
export const APP_ENV_ACTIVITY_ACTIONS = ['app.env.changed', 'app.env.rotated'] as const;

/** One dotted Environment event name. */
export type AppEnvActivityAction = (typeof APP_ENV_ACTIVITY_ACTIONS)[number];

/**
 * One Environment Activity row, as T26 will write it.
 *
 * `details` carries names and action verbs only: never a value, a length or a
 * hash (FR-8, FR-5). The shape is what `ActivityLogService.log` takes minus the
 * fields the owner fills in (`userId`, `workId`).
 */
export interface AppEnvActivityEvent {
    readonly actionType: 'app_env';
    readonly action: AppEnvActivityAction;
    readonly status: 'completed';
    readonly summary: string;
    readonly details: { names?: string[]; actions?: string[]; name?: string };
}

/** The Activity writer of {@link AppEnvActivityEvent}. */
export interface AppEnvActivity {
    emit(event: AppEnvActivityEvent): Promise<void>;
}

/** DI token for {@link AppEnvActivity} — owned by APW-07 T26. */
export const APP_ENV_ACTIVITY = Symbol('APP_ENV_ACTIVITY');

/* -------------------------------------------------------------------------- *
 * Warnings, refusals and results
 * -------------------------------------------------------------------------- */

/**
 * The warning codes of plan §8:903 (`dashboard.workDetail.appEnv.warnings.*`).
 *
 * `generatorChanged` and `publicPrefix` are the two flags the table renders on a
 * ROW ({@link AppEnvEntryView.generatorChanged} / `.publicPrefixWarning`), and
 * `undeclared` is the import dialog's "The App spec doesn't declare `FOO`,
 * `BAR`." The contract has no constant for them — reported to T1's owner.
 */
export const APP_ENV_WARNING_CODES = ['generatorChanged', 'publicPrefix', 'undeclared'] as const;

/** One warning code of plan §8:903. */
export type AppEnvWarningCode = (typeof APP_ENV_WARNING_CODES)[number];

/** One warning of an `apply` call: the code, and the names it is about. */
export interface AppEnvApplyWarning {
    readonly code: AppEnvWarningCode;
    readonly names: string[];
}

/**
 * The refusal codes a whole call can answer with, and the HTTP status each one
 * carries (plan §5:798-802 — T24 maps them without re-deriving anything).
 *
 * `notGenerated` is plan §5:799's rotate refusal; `generatorUnavailable` is this
 * service's own and is documented in the class docstring (reported): it answers
 * an App spec generator this build cannot run — the `base64url-raw` and `pkcs12`
 * keypair formats T42 owns — and a keypair whose public half would exceed FR-15's
 * 16 KB ceiling.
 */
export type AppEnvRefusalCode =
    | 'secureStorageUnavailable'
    | 'rotateConfirmationMismatch'
    | 'notGenerated'
    | 'generatorUnavailable';

/** The typed refusal every whole-call failure throws. */
export class AppEnvRefusalError extends Error {
    constructor(
        readonly code: AppEnvRefusalCode,
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'AppEnvRefusalError';
    }
}

/** Whether a caught value is {@link AppEnvRefusalError}, across bundles. */
export function isAppEnvRefusalError(value: unknown): value is AppEnvRefusalError {
    if (value instanceof AppEnvRefusalError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppEnvRefusalError' &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

/** One `set` item of an `apply` call — the DTO's `Record<name, value>` as a list. */
export interface AppEnvSetItem {
    readonly name: string;
    /** The value. An EMPTY one means "clear this name" — see the class docstring. */
    readonly value: string;
}

/** What one `apply` call asks for (FR-33, plan §5:785). */
export interface AppEnvApplyInput {
    readonly set?: readonly AppEnvSetItem[] | null;
    readonly unset?: readonly string[] | null;
    readonly reset?: readonly string[] | null;
    readonly import?: { readonly text: string } | null;
    readonly replaceGenerated?: boolean;
    readonly acknowledgeNeverRotate?: boolean;
}

/** FR-29's per-item outcomes, plus the two write verbs of a `set` call. */
export type AppEnvApplyAction = 'set' | 'created' | 'unset' | 'reset' | 'skipped' | 'refused';

/** One item's outcome. `code` is null when nothing was refused. */
export interface AppEnvApplyResultItem {
    /** The env name, or `null` for a refused line that never had one. */
    readonly name: string | null;
    /** The paste's 1-based line, for import items only. */
    readonly line: number | null;
    readonly action: AppEnvApplyAction;
    readonly code: AppEnvErrorCode | null;
    /** A sentence naming the rule — never the value (FR-19). */
    readonly message: string | null;
    /** The row's version after the change; `null` when nothing was written. */
    readonly version: number | null;
}

/** Why a whole call did nothing. */
export type AppEnvApplyReason = 'specUnavailable' | 'storeUnavailable';

/** What one `apply` call did — the PUT response's `results` and `warnings` (plan §5:785). */
export interface AppEnvApplyResult {
    readonly workId: string;
    readonly results: AppEnvApplyResultItem[];
    readonly warnings: AppEnvApplyWarning[];
    /** The names actually written or removed, in the order they were applied. */
    readonly changed: string[];
    /** True when the one `app.env.changed` row was handed to an Activity writer. */
    readonly activityRecorded: boolean;
    /** Set when the call changed nothing for a reason, never when it simply had nothing to do. */
    readonly reason?: AppEnvApplyReason;
}

/** What one generated entry became. Names and versions only — never a value. */
export interface AppEnvGeneratedEntry {
    readonly name: string;
    readonly version: number;
    readonly fingerprint: string;
    /** `<NAME>_PUBLIC` when the entry is a keypair, else null (FR-15). */
    readonly publicName: string | null;
}

/** Why an entry was left alone. */
export type AppEnvEnsureGeneratedSkipCode =
    | 'tooManyValues'
    | 'valuesTooLarge'
    | 'valueTooLarge'
    | 'generatorUnavailable'
    | 'invalidGeneratedValue'
    | 'generatedByAnotherCaller'
    | 'publicHalfMissing';

/** What one `ensureGenerated` pass did. */
export interface AppEnvEnsureGeneratedResult {
    readonly workId: string;
    readonly created: AppEnvGeneratedEntry[];
    /** FR-16: a keypair whose App spec also declares `<NAME>_PUBLIC`. */
    readonly conflicts: Array<{ name: string; publicName: string }>;
    readonly skipped: Array<{ name: string; code: AppEnvEnsureGeneratedSkipCode }>;
    readonly reason?: 'specUnavailable' | 'storeUnavailable' | 'secureStorageUnavailable';
}

/** One required `prompt` entry with no stored value (FR-26, S4). */
export interface AppEnvMissingRequirement {
    readonly name: string;
    readonly description: string | null;
}

/** `rotate`'s answer — the refreshed row plus the version it moved to (FR-13). */
export interface AppEnvRotateResult {
    readonly entry: AppEnvEntryView;
    readonly version: number;
}

/** The summary line of the Environment table (§6.1:451, FR-26). */
export interface AppEnvSummary {
    readonly total: number;
    readonly set: number;
    readonly missingRequired: number;
    readonly missingRequiredBuild: number;
}

/**
 * The four numbers the table's summary renders, from the views `list` produced.
 *
 * A pure function rather than a second service method: the numbers are a
 * projection of the list (FR-2/FR-26), and T24 must not re-derive them from a
 * second read that could disagree with the first.
 */
export function summarizeAppEnvEntries(entries: readonly AppEnvEntryView[]): AppEnvSummary {
    const missing = entries.filter((entry) => entry.required && !entry.set);
    return {
        total: entries.length,
        set: entries.filter((entry) => entry.set).length,
        missingRequired: missing.length,
        missingRequiredBuild: missing.filter(
            (entry) => entry.phase === 'build' || entry.phase === 'both',
        ).length,
    };
}

/**
 * FR-1's order: **prompt group, then required-and-unset first, then name**.
 *
 * Exported because `missingRequired` and `list` must agree, and because a UI that
 * re-sorted the array would show a different order than the API contract's
 * sentence describes.
 */
export function orderAppEnvEntries(entries: readonly AppEnvEntryView[]): AppEnvEntryView[] {
    return [...entries].sort((left, right) => {
        const groupLeft = left.group ?? '';
        const groupRight = right.group ?? '';
        if (groupLeft !== groupRight) {
            return groupLeft < groupRight ? -1 : 1;
        }
        const missingLeft = left.required && !left.set ? 0 : 1;
        const missingRight = right.required && !right.set ? 0 : 1;
        if (missingLeft !== missingRight) {
            return missingLeft - missingRight;
        }
        if (left.name !== right.name) {
            return left.name < right.name ? -1 : 1;
        }
        return 0;
    });
}

/**
 * The `generate` block as the App spec means it, with every default filled in
 * (plan §4.3:386-397, `app-spec.v1.schema.json` "default: 32").
 *
 * This is the one place the reported default mismatch is contained: the
 * fingerprint of a row is computed from THIS object, so it always describes the
 * value T10 produced beside it.
 */
export function resolvedGenerateSpec(generate: {
    kind: AppEnvGeneratorKind;
    bytes?: number;
    length?: number;
    alphabet?: string;
    keypair?: { type?: string; format?: AppEnvKeypairFormat; passwordEnv?: string };
}): AppEnvRecipeGenerateSpec {
    switch (generate.kind) {
        case 'base64':
        case 'hex':
            return {
                kind: generate.kind,
                bytes: generate.bytes ?? APP_ENV_GENERATOR_DEFAULT_BYTES,
            };
        case 'chars':
            return {
                kind: 'chars',
                length: generate.length ?? APP_ENV_GENERATOR_DEFAULT_LENGTH,
                alphabet:
                    (generate.alphabet as AppEnvRecipeGenerateSpec['alphabet']) ??
                    APP_ENV_GENERATOR_DEFAULT_ALPHABET,
            };
        case 'uuid':
            return { kind: 'uuid' };
        case 'keypair':
            return {
                kind: 'keypair',
                keypair: {
                    type:
                        (generate.keypair?.type as AppEnvRecipeGenerateSpec['keypair']['type']) ??
                        APP_ENV_GENERATOR_DEFAULT_KEYPAIR_TYPE,
                    format: generate.keypair?.format ?? APP_ENV_KEYPAIR_DEFAULT_FORMAT,
                    passwordEnv: generate.keypair?.passwordEnv,
                },
            };
        default:
            return { kind: generate.kind };
    }
}

/** The canonical `generatorFingerprint` of a resolved `generate` block. */
export function resolvedGeneratorFingerprint(generate: {
    kind: AppEnvGeneratorKind;
    bytes?: number;
    length?: number;
    alphabet?: string;
    keypair?: { type?: string; format?: AppEnvKeypairFormat; passwordEnv?: string };
}): string {
    return appEnvGeneratorFingerprint(resolvedGenerateSpec(generate) as never);
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/** One declared App spec entry, with the row that currently serves it. */
interface EnvEntryFacts {
    name: string;
    source: AppEnvEntrySource;
    phase: AppEnvPhase;
    secret: boolean;
    required: boolean;
    description: string | null;
    group: string | null;
    reference: string | null;
    specValue: string | null;
    /** The `validate` block, or null when the entry has none. */
    validate: AppSpecEnvEntry['validate'] | null;
    /** The `generate` block, or null. */
    generate: AppSpecEnvEntry['generate'] | null;
}

/** The parsed App spec: entries by name, and the implicit `<NAME>_PUBLIC` names. */
interface AppEnvSpecIndex {
    entries: Map<string, EnvEntryFacts>;
    /** `<NAME>_PUBLIC` → the keypair entry that implies it (FR-14, FR-16). */
    publicHalves: Map<string, string>;
}

/** One thing `apply` will do, decided before anything is written. */
type ApplyOperation =
    | {
          kind: 'write';
          name: string;
          value: string;
          origin: AppEnvStoredOrigin;
          line: number | null;
          action: 'set' | 'created';
          undeclared: boolean;
      }
    | { kind: 'remove'; name: string; line: number | null; action: 'unset' | 'reset' }
    | { kind: 'result'; item: AppEnvApplyResultItem };

@Injectable()
export class AppEnvService {
    private readonly logger = new Logger(AppEnvService.name);

    constructor(
        // T8's store, first, because every read and every write goes through it.
        @Optional() private readonly values?: WorkAppEnvValueRepository,
        // The entity's own repository, for the TWO reads T8's UI-facing read
        // deliberately withholds (its docstring: `valueEncrypted` is absent from
        // `findByWork`): the keypair public half of FR-15, and the value list
        // `buildRedactor` needs. Both are target reads — `list` loads the
        // envelope of `<NAME>_PUBLIC` rows only, never of a private value.
        @Optional()
        @InjectRepository(WorkAppEnvValue)
        private readonly rows?: Repository<WorkAppEnvValue>,
        @Optional() private readonly crypto?: AppEnvCrypto,
        @Optional()
        @Inject(APP_ENV_SPEC_SOURCE)
        private readonly spec?: AppEnvSpecSource,
        @Optional()
        @Inject(APP_ENV_ACTIVITY)
        private readonly activity?: AppEnvActivity,
        @Optional()
        @Inject(APP_ENV_BUILD_FINGERPRINTS)
        private readonly builds?: AppEnvRecordedFingerprints,
        @Optional()
        @Inject(APP_ENV_DEPLOY_FINGERPRINTS)
        private readonly deployments?: AppEnvRecordedFingerprints,
        @Optional()
        @Inject(APP_ENV_RESOLVER_FINGERPRINTS)
        private readonly resolved?: AppEnvResolvedFingerprints,
        @Optional()
        @Inject(APP_ENV_ACTOR_NAMES)
        private readonly actorNames?: AppEnvActorNames,
    ) {}

    /** The clock, as a method, so a spec can pin an instant without touching a global. */
    protected nowMs(): number {
        return Date.now();
    }

    /**
     * Can this installation store anything? — the `secureStorage: boolean` the
     * GET response carries (plan §5:784), answered by T9's own check so the
     * route and the write path can never disagree (S21, ACC-07-12).
     */
    isSecureStorageAvailable(): boolean {
        return this.crypto?.isAvailable() === true;
    }

    /* ---------------------------------------------------------------------- *
     * list — plan §4.2:365, FR-1…FR-4, FR-24
     * ---------------------------------------------------------------------- */

    /**
     * Every `env` entry of the effective App spec, plus every undeclared name
     * the owner set, as the Environment table renders them (FR-1).
     *
     * It decrypts **nothing but keypair public halves**: `set`, the origins, the
     * change flags and the actor all come from `findByWork`'s metadata read and
     * from APW-03's spec. An App spec that cannot be read answers `[]` — the
     * table is then empty rather than wrong, and the failure is logged.
     */
    async list(workId: string, viewer?: AppEnvActor | null): Promise<AppEnvEntryView[]> {
        const snapshot = await this.readSpec(workId);
        if (!snapshot) {
            return [];
        }

        const rows = await this.readRows(workId);
        const index = indexAppSpec(snapshot.spec);
        const publicValues = await this.readPublicHalves(workId, index, rows);
        const actorNames = await this.readActorNames(workId, rows, viewer);
        const entries = buildAppEnvEntryViews({
            snapshot,
            index,
            rows,
            viewer,
            actorNames,
            publicValues,
        });

        await this.markChangedSince(workId, entries, rows);
        return orderAppEnvEntries(entries);
    }

    /**
     * The required `prompt` entries of one phase that have no value yet — S4's
     * "2 required values are missing", with the description FR-26's message
     * prints in parentheses (ACC-07-09).
     *
     * A Build asks with `'build'` and a Deploy with `'runtime'`: an entry
     * participates when its own phase carries the asked one, so a runtime-only
     * value never blocks a Build. It generates nothing — `ensureGenerated` is the
     * caller's separate step, and the resolver runs it before it gates.
     */
    async missingRequired(
        workId: string,
        phase: 'build' | 'runtime',
    ): Promise<AppEnvMissingRequirement[]> {
        const snapshot = await this.readSpec(workId);
        if (!snapshot) {
            return [];
        }

        const rows = await this.readRows(workId);
        const storedNames = new Set(rows.map((row) => row.name));
        const missing: AppEnvEntryView[] = [];

        for (const entry of snapshot.spec.env ?? []) {
            if (!entry.prompt || entry.prompt.required === false) {
                continue;
            }
            if (!phaseCarries(envPhaseOf(entry), phase)) {
                continue;
            }
            if (storedNames.has(entry.name)) {
                continue;
            }
            const facts = factsOf(entry);
            missing.push({
                ...emptyView(),
                name: entry.name,
                declared: true,
                source: facts.source,
                origin: 'prompted',
                secret: facts.secret,
                phase: facts.phase,
                required: true,
                set: false,
                description: facts.description,
                group: facts.group,
            });
        }

        return orderAppEnvEntries(missing).map((entry) => ({
            name: entry.name,
            description: entry.description,
        }));
    }

    /* ---------------------------------------------------------------------- *
     * ensureGenerated — plan §4.2:366, FR-9, FR-12, ACC-07-01/02/03
     * ---------------------------------------------------------------------- */

    /**
     * Give every `generate` entry without a row exactly one value (FR-9).
     *
     * The pass is idempotent by construction: an entry that has a row is skipped
     * **before** a value is produced, so a re-apply, a rebuild, a redeploy and an
     * upstream sync are all the same no-op (FR-12, ACC-07-03). Where two callers
     * race, T8's `insertIfAbsent` makes the first writer win and every caller
     * read the winner's envelope back (ACC-07-02) — which is also why a keypair's
     * public half is written only by the caller whose private half was stored.
     */
    async ensureGenerated(workId: string): Promise<AppEnvEnsureGeneratedResult> {
        const result = {
            workId,
            created: [] as AppEnvGeneratedEntry[],
            conflicts: [] as Array<{ name: string; publicName: string }>,
            skipped: [] as Array<{ name: string; code: AppEnvEnsureGeneratedSkipCode }>,
        };

        const snapshot = await this.readSpec(workId);
        if (!snapshot) {
            return { ...result, reason: 'specUnavailable' };
        }
        if (!this.values) {
            return { ...result, reason: 'storeUnavailable' };
        }
        if (!this.isSecureStorageAvailable()) {
            // ACC-07-12: nothing is generated, and no row is written, without a key.
            this.logger.warn(
                `App env: generation for work ${workId} refused — secure storage is not configured.`,
            );
            return { ...result, reason: 'secureStorageUnavailable' };
        }

        const rows = await this.readRows(workId);
        const storedNames = new Set(rows.map((row) => row.name));
        const declaredNames = new Set((snapshot.spec.env ?? []).map((entry) => entry.name));
        const totals = await this.values.totals(workId);
        let count = totals.count;
        let bytes = totals.bytes;

        for (const entry of snapshot.spec.env ?? []) {
            const generate = entry.generate;
            if (!generate) {
                continue;
            }

            const publicName = appEnvPublicHalfName(entry.name);
            const isKeypair = generate.kind === 'keypair';
            const hasValue = storedNames.has(entry.name);
            const hasPublicHalf = storedNames.has(publicName);

            if (hasValue) {
                if (isKeypair && !hasPublicHalf) {
                    // Reported, not repaired: deriving a public half from a stored
                    // private key is a generator this build does not have (see the
                    // class docstring), and regenerating the pair is forbidden.
                    result.skipped.push({ name: entry.name, code: 'publicHalfMissing' });
                }
                continue;
            }
            if (isKeypair && declaredNames.has(publicName)) {
                // FR-16: the App spec declares <NAME>_PUBLIC itself, so the pair is
                // not generated until that conflict is resolved.
                result.conflicts.push({ name: entry.name, publicName });
                continue;
            }
            if (count >= APP_ENV_MAX_STORED) {
                result.skipped.push({ name: entry.name, code: 'tooManyValues' });
                continue;
            }

            let generated: AppEnvGeneratedValue;
            try {
                generated = generateAppEnvValue(resolvedGenerateSpec(generate));
            } catch (error) {
                // T42 owns the two keypair formats this build refuses.
                this.logger.warn(
                    `App env: generation of ${entry.name} for work ${workId} is unavailable (${errorText(error)}).`,
                );
                result.skipped.push({ name: entry.name, code: 'generatorUnavailable' });
                continue;
            }

            const validationRefused = validationRefusal(
                validateAppEnvValue(entry.name, generated.value, entry.validate ?? null, {
                    specHash: snapshot.specHash,
                }),
            );
            if (validationRefused) {
                this.logger.warn(
                    `App env: the generated value for ${entry.name} of work ${workId} failed its own rules (${validationRefused.code}).`,
                );
                result.skipped.push({ name: entry.name, code: 'invalidGeneratedValue' });
                continue;
            }

            const privateBytes = Buffer.byteLength(generated.value, 'utf8');
            const publicBytes = generated.publicValue
                ? Buffer.byteLength(generated.publicValue, 'utf8')
                : 0;
            if (publicBytes > APP_ENV_PUBLIC_HALF_MAX_BYTES) {
                result.skipped.push({ name: entry.name, code: 'valueTooLarge' });
                continue;
            }
            if (bytes + privateBytes + publicBytes > APP_ENV_TOTAL_MAX_BYTES) {
                result.skipped.push({ name: entry.name, code: 'valuesTooLarge' });
                continue;
            }

            const stored = await this.values.insertIfAbsent({
                workId,
                name: entry.name,
                origin: 'generated',
                valueEncrypted: this.encrypt(generated.value),
                valueBytes: privateBytes,
                generatorFingerprint: generated.fingerprint,
                derivedFromName: null,
                generatedAt: this.now(),
                setByUserId: null,
            });
            count += 1;
            bytes += privateBytes;
            // Mutable locally so the race check below can withdraw `publicName`
            // before the entry is handed out.
            const created: {
                name: string;
                version: number;
                fingerprint: string;
                publicName: string | null;
            } = {
                name: entry.name,
                version: stored.version,
                fingerprint: stored.generatorFingerprint ?? generated.fingerprint,
                publicName: generated.publicValue ? publicName : null,
            };
            result.created.push(created);

            if (generated.publicValue) {
                // Only the caller whose value was stored writes the public half: a
                // loser of the race would otherwise store a public key that does
                // not match the private key beside it.
                const storedValue = this.crypto.decrypt(stored.valueEncrypted);
                if (storedValue !== generated.value) {
                    created.publicName = null;
                    result.skipped.push({ name: entry.name, code: 'generatedByAnotherCaller' });
                    continue;
                }

                await this.values.insertIfAbsent({
                    workId,
                    name: publicName,
                    origin: 'derived',
                    valueEncrypted: this.encrypt(generated.publicValue),
                    valueBytes: publicBytes,
                    generatorFingerprint: null,
                    derivedFromName: entry.name,
                    generatedAt: this.now(),
                    setByUserId: null,
                });
                count += 1;
                bytes += publicBytes;
            }
        }

        return result;
    }

    /* ---------------------------------------------------------------------- *
     * apply — plan §4.2:367, FR-3, FR-8, FR-28…FR-31, FR-33
     * ---------------------------------------------------------------------- */

    /**
     * One call: `set`, `unset`, `reset` and `import`, with a result per item.
     *
     * The plan's "one transaction per call" is honoured as one unit of work —
     * see the class docstring for what that means and why the database
     * transaction itself cannot be composed with T8's repository. Content errors
     * are per item (FR-30: "every valid line is stored; no invalid line is"), and
     * every storage error this service can see is detected **before the first
     * write**, which is what ACC-07-12's "zero rows written" asserts.
     *
     * The groups run `unset` → `reset` → `set` → `import`, and the 300-row /
     * 1 MiB ceilings are accounted in that order — so a call that removes a value
     * and stores another in the same request fits within the ceiling it frees.
     */
    async apply(
        workId: string,
        actor: AppEnvActor,
        input: AppEnvApplyInput,
    ): Promise<AppEnvApplyResult> {
        const empty: AppEnvApplyResult = {
            workId,
            results: [],
            warnings: [],
            changed: [],
            activityRecorded: false,
        };

        const snapshot = await this.readSpec(workId);
        if (!snapshot) {
            return { ...empty, reason: 'specUnavailable' };
        }
        if (!this.values) {
            return { ...empty, reason: 'storeUnavailable' };
        }

        const setItems = input?.set ?? [];
        const importText = typeof input?.import?.text === 'string' ? input.import.text : null;
        const storesSomething =
            setItems.length > 0 || (importText !== null && importText.trim().length > 0);
        if (storesSomething && !this.isSecureStorageAvailable()) {
            // Before any read that could become a write, and in every NODE_ENV.
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                "Secure storage isn't configured on this installation.",
                503,
            );
        }

        const index = indexAppSpec(snapshot.spec);
        const rows = await this.readRows(workId);
        const rowsByName = new Map(rows.map((row) => [row.name, row]));
        const totals = await this.values.totals(workId);

        const operations: ApplyOperation[] = [];
        const warnings: AppEnvApplyWarning[] = [];
        const undeclaredNames: string[] = [];
        const publicPrefixNames: string[] = [];
        let count = totals.count;
        let bytes = totals.bytes;

        const plan = {
            /** Validate a name the caller asked to touch, without a value. */
            checkName(name: string): AppEnvApplyResultItem | null {
                const refusal = validationRefusal(
                    validateAppEnvValue(name, '', null, { specHash: snapshot.specHash }),
                );
                return refusal ? refusedItem(name, null, refusal.code, refusal.message) : null;
            },
            planSet(name: string, value: string, line: number | null, imported: boolean): void {
                const facts = index.entries.get(name);
                const existing = rowsByName.get(name);

                if (value === '') {
                    // The cleared-field reading: an empty value is `unset`, because
                    // the envelope cannot carry one (class docstring).
                    plan.planRemove(name, line, 'unset', imported);
                    return;
                }
                if (index.publicHalves.has(name)) {
                    operations.push({
                        kind: 'result',
                        item: refusedGenerated(
                            name,
                            line,
                            imported,
                            'generatedValueUseRotate',
                            'This name is the public half of a key pair. Rotate the key pair to replace it.',
                        ),
                    });
                    return;
                }
                if (facts?.generate) {
                    // FR-14/FR-15: a key pair is replaced as a PAIR and only by
                    // `rotate`, so neither confirmation makes a hand-typed value
                    // safe here — the stored public half would be left describing a
                    // key nobody holds.
                    const keypair = facts.generate.kind === 'keypair';
                    if (keypair || !input?.replaceGenerated) {
                        operations.push({
                            kind: 'result',
                            item: refusedGenerated(
                                name,
                                line,
                                imported,
                                'generatedValueUseRotate',
                                'This value is generated. Rotate it to replace it.',
                            ),
                        });
                        return;
                    }
                    if (!input?.acknowledgeNeverRotate) {
                        operations.push({
                            kind: 'result',
                            item: refusedGenerated(
                                name,
                                line,
                                imported,
                                'neverRotateNotAcknowledged',
                                'This app says this value must never change. Confirm that you understand before replacing it.',
                            ),
                        });
                        return;
                    }
                }

                const refusal = validationRefusal(
                    validateAppEnvValue(name, value, facts?.validate ?? null, {
                        specHash: snapshot.specHash,
                    }),
                );
                if (refusal) {
                    operations.push({
                        kind: 'result',
                        item: refusedItem(name, line, refusal.code, refusal.message),
                    });
                    return;
                }

                const valueBytes = Buffer.byteLength(value, 'utf8');
                const previousBytes = existing?.valueBytes ?? 0;
                if (!existing && count >= APP_ENV_MAX_STORED) {
                    operations.push({
                        kind: 'result',
                        item: refusedItem(
                            name,
                            line,
                            'tooManyValues',
                            `An app can hold at most ${APP_ENV_MAX_STORED} values.`,
                        ),
                    });
                    return;
                }
                if (bytes - previousBytes + valueBytes > APP_ENV_TOTAL_MAX_BYTES) {
                    operations.push({
                        kind: 'result',
                        item: refusedItem(
                            name,
                            line,
                            'valuesTooLarge',
                            `An app's values can total at most ${APP_ENV_TOTAL_MAX_BYTES} bytes.`,
                        ),
                    });
                    return;
                }

                count += existing ? 0 : 1;
                bytes = bytes - previousBytes + valueBytes;
                const undeclared = facts === undefined;
                if (undeclared && !undeclaredNames.includes(name)) {
                    undeclaredNames.push(name);
                }
                if (
                    facts?.secret &&
                    hasAppEnvPublicPrefix(name) &&
                    !publicPrefixNames.includes(name)
                ) {
                    publicPrefixNames.push(name);
                }
                operations.push({
                    kind: 'write',
                    name,
                    value,
                    origin: originForWrite(facts, name, index),
                    line,
                    action: undeclared ? 'created' : 'set',
                    undeclared,
                });
            },
            planRemove(
                name: string,
                line: number | null,
                action: 'unset' | 'reset',
                imported = false,
            ): void {
                const facts = index.entries.get(name);
                const existing = rowsByName.get(name);
                const invalid = plan.checkName(name);
                if (invalid) {
                    operations.push({ kind: 'result', item: { ...invalid, line } });
                    return;
                }
                if (index.publicHalves.has(name)) {
                    operations.push({
                        kind: 'result',
                        item: skippedItem(
                            name,
                            line,
                            'generatedValueUseRotate',
                            'This name is the public half of a key pair; it follows the pair.',
                        ),
                    });
                    return;
                }
                if (facts?.generate) {
                    operations.push({
                        kind: 'result',
                        item: skippedItem(
                            name,
                            line,
                            'generatedValueUseRotate',
                            'This value is generated. Rotate it to replace it.',
                        ),
                    });
                    return;
                }
                if (!existing) {
                    operations.push({
                        kind: 'result',
                        item: skippedItem(name, line, null, 'Nothing is stored under this name.'),
                    });
                    return;
                }
                if (action === 'reset') {
                    const isOverride =
                        facts !== undefined &&
                        (facts.reference !== null || facts.specValue !== null);
                    if (!isOverride) {
                        operations.push({
                            kind: 'result',
                            item: skippedItem(
                                name,
                                line,
                                null,
                                imported
                                    ? 'Imported values are removed with the other values.'
                                    : 'This value is not an override of the App spec.',
                            ),
                        });
                        return;
                    }
                }
                count -= 1;
                bytes -= existing.valueBytes;
                operations.push({ kind: 'remove', name, line, action });
            },
        };

        for (const name of input?.unset ?? []) {
            plan.planRemove(String(name), null, 'unset');
        }
        for (const name of input?.reset ?? []) {
            plan.planRemove(String(name), null, 'reset');
        }
        for (const item of setItems) {
            plan.planSet(String(item?.name ?? ''), String(item?.value ?? ''), null, false);
        }

        if (importText !== null) {
            const parsed = parseAppEnvDotenv(importText);
            // Read the limit arm by its `kind`, which narrows in both directions:
            // this package sets `strictNullChecks: false`, under which a union is
            // narrowed by a string discriminant but not by a boolean one — the
            // caveat T12's own spec documents for `ok` (`dotenv-parser.spec.ts`).
            // No cast is needed on either arm (verified by removing them and
            // running `tsc --noEmit`, 2026-09-18).
            if (parsed.kind === 'limits') {
                // FR-28's two pre-parse ceilings: the paste was refused as a whole,
                // so there is no partial entry list to apply.
                const limits = parsed;
                operations.push({
                    kind: 'result',
                    item: refusedItem(null, null, limits.code, limits.message),
                });
            } else {
                const applied = parsed;
                const combined: Array<
                    | { line: number; duplicate: AppEnvDotenvDuplicate }
                    | { line: number; refusal: AppEnvDotenvRefusal }
                    | { line: number; entry: AppEnvDotenvEntry }
                > = [
                    ...applied.duplicates.map((duplicate) => ({ line: duplicate.line, duplicate })),
                    ...applied.refused.map((refusal) => ({ line: refusal.line, refusal })),
                    ...applied.entries.map((entry) => ({ line: entry.line, entry })),
                ].sort((left, right) => left.line - right.line);

                for (const item of combined) {
                    if ('duplicate' in item) {
                        // FR-29: an identical name is last-wins, and every earlier
                        // occurrence is `skipped`.
                        operations.push({
                            kind: 'result',
                            item: skippedItem(
                                item.duplicate.name,
                                item.duplicate.line,
                                null,
                                'A later line sets this name; the last one wins.',
                            ),
                        });
                        continue;
                    }
                    if ('refusal' in item) {
                        operations.push({
                            kind: 'result',
                            item: refusedItem(
                                null,
                                item.refusal.line,
                                item.refusal.reason,
                                item.refusal.message,
                            ),
                        });
                        continue;
                    }
                    plan.planSet(item.entry.name, item.entry.value, item.entry.line, true);
                }
            }
        }

        if (undeclaredNames.length > 0) {
            warnings.push({ code: 'undeclared', names: undeclaredNames });
        }
        if (publicPrefixNames.length > 0) {
            warnings.push({ code: 'publicPrefix', names: publicPrefixNames });
        }

        /* ── execute ─────────────────────────────────────────────────────── */

        const result: {
            results: AppEnvApplyResultItem[];
            changed: string[];
            activityRecorded: boolean;
            reason?: AppEnvApplyReason;
        } = { results: [], changed: [], activityRecorded: false };
        let storageFailed = false;

        for (const operation of operations) {
            if (operation.kind === 'result') {
                result.results.push(operation.item);
                continue;
            }
            if (storageFailed) {
                result.results.push({
                    ...refusedItem(
                        operation.name,
                        operation.line,
                        null,
                        'Not stored: the value store failed earlier in this call.',
                    ),
                    action: 'refused',
                });
                continue;
            }

            if (operation.kind === 'write') {
                try {
                    const row = await this.values.upsertValue(workId, operation.name, {
                        origin: operation.origin,
                        valueEncrypted: this.encrypt(operation.value),
                        valueBytes: Buffer.byteLength(operation.value, 'utf8'),
                        generatorFingerprint: null,
                        derivedFromName: null,
                        generatedAt: null,
                        setByUserId: actor?.userId ?? null,
                    });
                    result.results.push({
                        name: operation.name,
                        line: operation.line,
                        action: operation.action,
                        code: null,
                        message: null,
                        version: row.version,
                    });
                    result.changed.push(operation.name);
                } catch (error) {
                    if (isAppEnvEncryptionUnavailableError(error)) {
                        result.results.push(
                            refusedItem(
                                operation.name,
                                operation.line,
                                'secureStorageUnavailable',
                                "Secure storage isn't configured on this installation.",
                            ),
                        );
                        storageFailed = true;
                        continue;
                    }
                    this.logger.error(
                        `App env: storing ${operation.name} for work ${workId} failed (${errorText(error)}).`,
                    );
                    result.results.push(
                        refusedItem(
                            operation.name,
                            operation.line,
                            null,
                            'The value could not be stored.',
                        ),
                    );
                    storageFailed = true;
                }
                continue;
            }

            try {
                await this.values.deleteNames(workId, [operation.name]);
                result.results.push({
                    name: operation.name,
                    line: operation.line,
                    action: operation.action,
                    code: null,
                    message: null,
                    version: null,
                });
                result.changed.push(operation.name);
            } catch (error) {
                this.logger.error(
                    `App env: removing ${operation.name} for work ${workId} failed (${errorText(error)}).`,
                );
                result.results.push(
                    refusedItem(
                        operation.name,
                        operation.line,
                        null,
                        'The value could not be removed.',
                    ),
                );
                storageFailed = true;
            }
        }

        if (storageFailed) {
            result.reason = 'storeUnavailable';
        }

        if (result.changed.length > 0) {
            // FR-8: one row per call, names and action verbs only.
            result.activityRecorded = await this.emit({
                actionType: 'app_env',
                action: 'app.env.changed',
                status: 'completed',
                summary:
                    result.changed.length === 1
                        ? `Environment value ${result.changed[0]} ${activityWord(operations)}`
                        : `Environment values ${activityWord(operations)} (${result.changed.length})`,
                details: {
                    names: [...result.changed],
                    actions: activityActions(operations, importText !== null),
                },
            });
        }

        return {
            workId,
            results: result.results,
            warnings,
            changed: result.changed,
            activityRecorded: result.activityRecorded,
            ...(result.reason ? { reason: result.reason } : {}),
        };
    }

    /* ---------------------------------------------------------------------- *
     * rotate — plan §4.2:368, FR-13, FR-15, ACC-07-04
     * ---------------------------------------------------------------------- */

    /**
     * Replace a generated entry's value with a fresh one, and — for a keypair —
     * both halves together (FR-15).
     *
     * Only a `generate` entry can be rotated (FR-13), and `confirmName` must be
     * the name exactly: S6's warning exists because rotating a never-rotate value
     * can make data the app encrypted with it unreadable, so the typed name is
     * the acknowledgement. The 10-per-hour ceiling is the route's (plan §5:786) —
     * see the class docstring.
     */
    async rotate(
        workId: string,
        actor: AppEnvActor,
        name: string,
        options: { confirmName: string },
    ): Promise<AppEnvRotateResult> {
        if (options?.confirmName !== name) {
            throw new AppEnvRefusalError(
                'rotateConfirmationMismatch',
                "The name you typed doesn't match this value's name.",
                422,
            );
        }

        const snapshot = await this.readSpec(workId);
        const facts = snapshot ? indexAppSpec(snapshot.spec).entries.get(name) : undefined;
        if (!snapshot || !facts?.generate) {
            throw new AppEnvRefusalError(
                'notGenerated',
                `\`${name}\` is not a generated value of this app.`,
                422,
            );
        }

        if (!this.values) {
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                "Secure storage isn't configured on this installation.",
                503,
            );
        }
        this.assertSecureStorage();

        const rows = await this.readRows(workId);
        if (!rows.some((row) => row.name === name)) {
            throw new AppEnvRefusalError(
                'notGenerated',
                `\`${name}\` has no generated value yet.`,
                422,
            );
        }

        let generated: AppEnvGeneratedValue;
        try {
            generated = generateAppEnvValue(resolvedGenerateSpec(facts.generate));
        } catch (error) {
            throw new AppEnvRefusalError(
                'generatorUnavailable',
                `This entry's generator is not available on this installation (${errorText(error)}).`,
                422,
            );
        }

        const publicName = appEnvPublicHalfName(name);
        const publicBytes = generated.publicValue
            ? Buffer.byteLength(generated.publicValue, 'utf8')
            : 0;
        if (publicBytes > APP_ENV_PUBLIC_HALF_MAX_BYTES) {
            throw new AppEnvRefusalError(
                'generatorUnavailable',
                `The public half would be larger than ${APP_ENV_PUBLIC_HALF_MAX_BYTES} bytes.`,
                422,
            );
        }

        const stored = await this.values.upsertValue(workId, name, {
            origin: 'generated',
            valueEncrypted: this.encrypt(generated.value),
            valueBytes: Buffer.byteLength(generated.value, 'utf8'),
            generatorFingerprint: generated.fingerprint,
            derivedFromName: null,
            generatedAt: this.now(),
            setByUserId: actor?.userId ?? null,
        });

        if (generated.publicValue) {
            await this.values.upsertValue(workId, publicName, {
                origin: 'derived',
                valueEncrypted: this.encrypt(generated.publicValue),
                valueBytes: publicBytes,
                generatorFingerprint: null,
                derivedFromName: name,
                generatedAt: this.now(),
                setByUserId: actor?.userId ?? null,
            });
        }

        // ACC-07-04: `app.env.rotated` carries the name only — never a value, a
        // length or a hash (FR-8).
        await this.emit({
            actionType: 'app_env',
            action: 'app.env.rotated',
            status: 'completed',
            summary: `Environment value ${name} rotated`,
            details: { name },
        });

        const entries = await this.list(workId, actor);
        return {
            entry: entries.find((entry) => entry.name === name) ?? null,
            version: stored.version,
        };
    }

    /* ---------------------------------------------------------------------- *
     * buildRedactor — plan §4.2:370, FR-5
     * ---------------------------------------------------------------------- */

    /**
     * A function that replaces every stored value of six characters or more with
     * `***`, longest first, so a log line built from a request body cannot carry
     * a secret (FR-5).
     *
     * "Decrypts all values ≥ 6 characters once" (§4.2:370) — the result is never
     * cached beyond the call. A redactor that cannot enumerate the values is
     * **refused**, not returned half-built: a function that redacts nothing is
     * worse than no redactor, because its caller believes the line is safe. The
     * caller's answer to that refusal is to skip the log line.
     */
    async buildRedactor(workId: string): Promise<(text: string) => string> {
        if (!this.rows || !this.crypto || !this.isSecureStorageAvailable()) {
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                "Secure storage isn't configured on this installation.",
                503,
            );
        }

        const stored = await this.rows.find({
            where: { workId },
            select: ['id', 'name', 'valueEncrypted'],
        });

        const values: string[] = [];
        for (const row of stored) {
            if (typeof row.valueEncrypted !== 'string' || row.valueEncrypted === '') {
                continue;
            }
            const value = this.crypto.decrypt(row.valueEncrypted);
            if (value.length >= APP_ENV_REDACT_MIN_CHARS) {
                values.push(value);
            }
        }
        values.sort((left, right) => right.length - left.length);

        return (text: string): string => {
            if (typeof text !== 'string' || text === '') {
                return text;
            }
            let redacted = text;
            for (const value of values) {
                redacted = redacted.split(value).join('***');
            }
            return redacted;
        };
    }

    /* ---------------------------------------------------------------------- *
     * internals
     * ---------------------------------------------------------------------- */

    /** The effective App spec, or `null` — never a thrown read in a caller's face. */
    private async readSpec(workId: string): Promise<AppEnvSpecSnapshot | null> {
        if (!this.spec) {
            return null;
        }
        try {
            return await this.spec.read(workId);
        } catch (error) {
            this.logger.warn(
                `App env: the App spec of work ${workId} could not be read (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * The stored rows' metadata, or `[]`.
     *
     * A store that cannot be read answers "nothing is stored", which is the
     * fail-closed direction for every reader of this service (an empty table
     * means everything is unset), and the failure is logged.
     */
    private async readRows(workId: string): Promise<WorkAppEnvValueMetadata[]> {
        if (!this.values) {
            return [];
        }
        try {
            return await this.values.findByWork(workId);
        } catch (error) {
            this.logger.warn(
                `App env: the values of work ${workId} could not be read (${errorText(error)}).`,
            );
            return [];
        }
    }

    /** Encrypt through T9, with the missing-collaborator answer this file documents. */
    private encrypt(value: string): string {
        if (!this.crypto) {
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                "Secure storage isn't configured on this installation.",
                503,
            );
        }
        return this.crypto.encrypt(value);
    }

    /** `assertAvailable`, with T9's own error translated into this file's refusal. */
    private assertSecureStorage(): void {
        if (!this.crypto) {
            throw new AppEnvRefusalError(
                'secureStorageUnavailable',
                "Secure storage isn't configured on this installation.",
                503,
            );
        }
        try {
            this.crypto.assertAvailable();
        } catch (error) {
            if (isAppEnvEncryptionUnavailableError(error)) {
                throw new AppEnvRefusalError(
                    'secureStorageUnavailable',
                    "Secure storage isn't configured on this installation.",
                    503,
                );
            }
            throw error;
        }
    }

    /**
     * The keypair public halves of one Work — the ONE envelope `list` reads, and
     * only for the names the App spec implies (`<NAME>_PUBLIC`, FR-15).
     *
     * A public half that cannot be decrypted is left out and logged: the table
     * then shows no **Copy public key** for that row, which is the fail-closed
     * answer, rather than a ciphertext handed to a browser.
     */
    private async readPublicHalves(
        workId: string,
        index: AppEnvSpecIndex,
        rows: readonly WorkAppEnvValueMetadata[],
    ): Promise<Map<string, string>> {
        const wanted = rows.map((row) => row.name).filter((name) => index.publicHalves.has(name));
        const values = new Map<string, string>();
        if (!this.rows || wanted.length === 0) {
            return values;
        }

        const stored = await this.rows.find({
            where: wanted.map((name) => ({ workId, name })),
            select: ['id', 'name', 'valueEncrypted'],
        });
        for (const row of stored) {
            try {
                values.set(row.name, this.crypto.decrypt(row.valueEncrypted));
            } catch (error) {
                this.logger.warn(
                    `App env: the public half ${row.name} of work ${workId} could not be read (${errorText(error)}).`,
                );
            }
        }
        return values;
    }

    /** The display names of the actors this Work's rows name, excluding the viewer. */
    private async readActorNames(
        workId: string,
        rows: readonly WorkAppEnvValueMetadata[],
        viewer?: AppEnvActor | null,
    ): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        if (!this.actorNames) {
            return names;
        }
        const wanted = [
            ...new Set(
                rows
                    .map((row) => row.setByUserId)
                    .filter(
                        (userId): userId is string =>
                            typeof userId === 'string' && userId !== viewer?.userId,
                    ),
            ),
        ];
        for (const userId of wanted) {
            try {
                const name = await this.actorNames.nameOf(workId, userId);
                if (typeof name === 'string' && name !== '') {
                    names.set(userId, name);
                }
            } catch (error) {
                this.logger.warn(
                    `App env: the actor name of ${userId} for work ${workId} could not be read (${errorText(error)}).`,
                );
            }
        }
        return names;
    }

    /**
     * FR-24's two flags, per §2.2:132-150.
     *
     * A stored row's current fingerprint is `v<version>`, which this service can
     * read without decrypting anything; every other entry's comes from T14's
     * resolver. An entry with no fingerprint, or a Work with no recorded map,
     * gives `false` — "the 'Needed before…' state already covers it" — and
     * neither flag ever reads or decrypts a value.
     */
    private async markChangedSince(
        workId: string,
        entries: AppEnvEntryView[],
        rows: readonly WorkAppEnvValueMetadata[],
    ): Promise<void> {
        const rowsByName = new Map(rows.map((row) => [row.name, row]));
        const needsBuild = entries.some((entry) => participatesIn(entry.phase, 'build'));
        const needsRuntime = entries.some((entry) => participatesIn(entry.phase, 'runtime'));

        const buildMap = needsBuild ? await this.readRecorded(this.builds, workId) : null;
        const deployMap = needsRuntime ? await this.readRecorded(this.deployments, workId) : null;
        const resolvedBuild =
            needsBuild && this.resolved ? await this.readResolved(workId, 'build') : null;
        const resolvedRuntime =
            needsRuntime && this.resolved ? await this.readResolved(workId, 'runtime') : null;

        for (const entry of entries) {
            const row = rowsByName.get(entry.name);
            const storedFingerprint = row ? appEnvStoredFingerprint(row.version) : null;
            const currentBuild = storedFingerprint ?? resolvedBuild?.[entry.name] ?? null;
            const currentRuntime = storedFingerprint ?? resolvedRuntime?.[entry.name] ?? null;
            entry.changedSinceBuild = participatesIn(entry.phase, 'build')
                ? differs(buildMap, entry.name, currentBuild)
                : false;
            entry.changedSinceDeploy = participatesIn(entry.phase, 'runtime')
                ? differs(deployMap, entry.name, currentRuntime)
                : false;
        }
    }

    private async readRecorded(
        source: AppEnvRecordedFingerprints | undefined,
        workId: string,
    ): Promise<Record<string, string> | null> {
        if (!source) {
            return null;
        }
        try {
            return (await source.read(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `App env: a recorded fingerprint map of work ${workId} could not be read (${errorText(error)}).`,
            );
            return null;
        }
    }

    private async readResolved(
        workId: string,
        phase: 'build' | 'runtime',
    ): Promise<Record<string, string> | null> {
        if (!this.resolved) {
            return null;
        }
        try {
            return (await this.resolved.read(workId, phase)) ?? null;
        } catch (error) {
            this.logger.warn(
                `App env: the ${phase} fingerprints of work ${workId} could not be resolved (${errorText(error)}).`,
            );
            return null;
        }
    }

    /**
     * Hand one event to T26's writer. An unbound writer is reported, never
     * worked around: the change it describes has already happened, and a missing
     * feed entry must not undo it — the answer is `activityRecorded: false` and
     * one warning line.
     */
    private async emit(event: AppEnvActivityEvent): Promise<boolean> {
        if (!this.activity) {
            this.logger.warn(
                `App env: ${event.action} was not recorded (no Activity writer is bound).`,
            );
            return false;
        }
        try {
            await this.activity.emit(event);
            return true;
        } catch (error) {
            this.logger.warn(`App env: recording ${event.action} failed (${errorText(error)}).`);
            return false;
        }
    }

    private now(): Date {
        return new Date(this.nowMs());
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — the view, the index and the small predicates
 * -------------------------------------------------------------------------- */

/** An empty view, so every construction below sets exactly the fields it knows. */
function emptyView(): AppEnvEntryView {
    return {
        name: '',
        declared: false,
        source: 'undeclared',
        origin: null,
        overrides: null,
        secret: false,
        phase: 'runtime',
        required: false,
        set: false,
        description: null,
        group: null,
        reference: null,
        specValue: null,
        validation: null,
        generator: null,
        generatorChanged: false,
        publicPrefixWarning: false,
        publicValue: null,
        changedSinceBuild: false,
        changedSinceDeploy: false,
        updatedAt: null,
        updatedBy: null,
    };
}

/** The facts of one App spec entry, as every read of it needs them. */
function factsOf(entry: AppSpecEnvEntry): EnvEntryFacts {
    return {
        name: entry.name,
        source: appEnvEntrySource(entry),
        phase: envPhaseOf(entry) as AppEnvPhase,
        secret: envEntryDeclaredSecret(entry),
        required: entry.prompt?.required !== false && entry.prompt !== undefined,
        description: entry.description ?? entry.prompt?.description ?? null,
        group: entry.prompt?.group ?? null,
        reference: entry.from ?? entry.template ?? null,
        specValue: typeof entry.value === 'string' ? entry.value : null,
        validate: entry.validate ?? null,
        generate: entry.generate ?? null,
    };
}

/** The ONE value source of an entry (APW-03 R7 guarantees exactly one). */
function appEnvEntrySource(entry: AppSpecEnvEntry): AppEnvEntrySource {
    if (entry.generate) return 'generate';
    if (entry.prompt) return 'prompt';
    if (entry.from) return 'from';
    if (entry.template) return 'template';
    if (typeof entry.value === 'string') return 'value';
    return 'undeclared';
}

/** Index one App spec: its entries, and the implicit `<NAME>_PUBLIC` names. */
function indexAppSpec(spec: AppSpec): AppEnvSpecIndex {
    const entries = new Map<string, EnvEntryFacts>();
    const publicHalves = new Map<string, string>();

    for (const entry of spec?.env ?? []) {
        if (entries.has(entry.name)) {
            // APW-03 refuses duplicate names; the first one wins here rather than
            // letting the second silently replace the first's rules.
            continue;
        }
        const facts = factsOf(entry);
        entries.set(entry.name, facts);
        if (facts.generate?.kind === 'keypair') {
            publicHalves.set(appEnvPublicHalfName(entry.name), entry.name);
        }
    }

    return { entries, publicHalves };
}

/** True when an entry at `entryPhase` takes part in `asked`. */
function participatesIn(entryPhase: AppEnvPhase, asked: 'build' | 'runtime'): boolean {
    return entryPhase === 'both' || entryPhase === asked;
}

/** `phaseCarries` is `participatesIn` read from the caller's side — same rule. */
function phaseCarries(entryPhase: AppEnvPhase, asked: 'build' | 'runtime'): boolean {
    return participatesIn(entryPhase, asked);
}

/** §2.2:148-150's comparison: a name on only one side counts as changed. */
function differs(
    recorded: Record<string, string> | null,
    name: string,
    current: string | null,
): boolean {
    if (recorded === null || current === null) {
        return false;
    }
    return (recorded[name] ?? null) !== current;
}

/**
 * The refusal of a validation result, or `null` when it passed.
 *
 * Written as a conversion rather than an `if (!result.ok)` narrowing because this
 * package sets `strictNullChecks: false`, under which TypeScript does not narrow
 * a discriminated union by its discriminant — the same reason
 * `jest.config.js:14-24` excludes `@ever-works/agent-plugins` from ts-jest's
 * diagnostics. `AppEnvValidationResult` is exactly `{ ok: true }` or
 * {@link AppEnvValidationRefusal}, so this conversion is total.
 */
function validationRefusal(result: { readonly ok: boolean }): AppEnvValidationRefusal | null {
    return result.ok === true ? null : (result as AppEnvValidationRefusal);
}

/** The stored origin a `set` produces (plan §4.2:372-374). */
function originForWrite(
    facts: EnvEntryFacts | undefined,
    name: string,
    index: AppEnvSpecIndex,
): AppEnvStoredOrigin {
    if (facts === undefined) {
        // An undeclared name the owner set (FR-1) — or a leftover derived row,
        // which is still "set by you" for every purpose this column serves.
        return index.publicHalves.has(name) ? 'derived' : 'user';
    }
    return facts.source === 'prompt' ? 'prompted' : 'user';
}

/** One refused item. */
function refusedItem(
    name: string | null,
    line: number | null,
    code: AppEnvErrorCode | null,
    message: string,
): AppEnvApplyResultItem {
    return { name, line, action: 'refused', code, message, version: null };
}

/** One skipped item — nothing was wrong with the call, there was nothing to do. */
function skippedItem(
    name: string | null,
    line: number | null,
    code: AppEnvErrorCode | null,
    message: string,
): AppEnvApplyResultItem {
    return { name, line, action: 'skipped', code, message, version: null };
}

/**
 * A generated name the caller tried to set (FR-12, S17).
 *
 * FR-29 fixes the difference between the two doors: a `set` is **refused** — the
 * member asked for something the platform will not do — while the same name
 * arriving inside a pasted `.env` is **skipped**, because S17's copy for an
 * import line is "`NAME` is generated by Ever Works. Rotate it instead." and the
 * rest of the paste still applies. The code is the same on both sides.
 */
function refusedGenerated(
    name: string,
    line: number | null,
    imported: boolean,
    code: 'generatedValueUseRotate' | 'neverRotateNotAcknowledged',
    message: string,
): AppEnvApplyResultItem {
    return imported
        ? skippedItem(name, line, code, message)
        : refusedItem(name, line, code, message);
}

/** FR-8's four action words, from what the call actually did. */
function activityActions(operations: readonly ApplyOperation[], imported: boolean): string[] {
    const actions: string[] = [];
    if (operations.some((operation) => operation.kind === 'write')) {
        actions.push('set');
    }
    if (
        operations.some((operation) => operation.kind === 'remove' && operation.action === 'unset')
    ) {
        actions.push('unset');
    }
    if (
        operations.some((operation) => operation.kind === 'remove' && operation.action === 'reset')
    ) {
        actions.push('reset');
    }
    if (imported) {
        actions.push('imported');
    }
    return actions;
}

/** The one word an Activity summary uses, from the same list. */
function activityWord(operations: readonly ApplyOperation[]): string {
    const actions = activityActions(operations, false);
    return actions.length > 0 ? actions[0] : 'changed';
}

/** Build the table rows of one Work (§3.3:271-294). */
function buildAppEnvEntryViews(input: {
    snapshot: AppEnvSpecSnapshot;
    index: AppEnvSpecIndex;
    rows: readonly WorkAppEnvValueMetadata[];
    viewer?: AppEnvActor | null;
    actorNames: Map<string, string>;
    publicValues: Map<string, string>;
}): AppEnvEntryView[] {
    const { snapshot, index, rows, viewer, actorNames, publicValues } = input;
    const rowsByName = new Map(rows.map((row) => [row.name, row]));
    const views: AppEnvEntryView[] = [];

    for (const facts of index.entries.values()) {
        const row = rowsByName.get(facts.name) ?? null;
        views.push({
            name: facts.name,
            declared: true,
            source: facts.source,
            origin: originOf(facts, row),
            overrides: overridesOf(facts, row),
            secret: facts.secret,
            phase: facts.phase,
            required: facts.required,
            // A `value` literal is present without a row; everything else is set
            // only when a row exists (FR-2's set/unset).
            set: row !== null || facts.source === 'value',
            description: facts.description,
            group: facts.group,
            reference: facts.reference,
            // The App spec's literal is shown only while the entry follows it: an
            // override makes "Default from App spec" a lie (FR-3).
            specValue: row === null ? facts.specValue : null,
            validation: facts.validate ? validationOf(facts.validate) : null,
            generator: facts.generate ? generatorOf(facts.generate) : null,
            generatorChanged: generatorChanged(facts, row),
            publicPrefixWarning: facts.secret && hasAppEnvPublicPrefix(facts.name),
            publicValue: publicValues.get(appEnvPublicHalfName(facts.name)) ?? null,
            changedSinceBuild: false,
            changedSinceDeploy: false,
            updatedAt: isoOf(row?.updatedAt),
            updatedBy: actorOf(row, viewer, actorNames),
        });
    }

    for (const row of rows) {
        if (index.entries.has(row.name) || index.publicHalves.has(row.name)) {
            // Declared entries are above; a public half is folded into its key
            // pair's row (FR-15), never listed twice.
            continue;
        }
        views.push({
            ...emptyView(),
            name: row.name,
            declared: false,
            source: 'undeclared',
            origin: row.origin as AppEnvOrigin,
            secret: true,
            set: true,
            publicPrefixWarning: hasAppEnvPublicPrefix(row.name),
            updatedAt: isoOf(row.updatedAt),
            updatedBy: actorOf(row, viewer, actorNames),
        });
    }

    return views;
}

/** Where an entry's current value comes from (§3.3:487-491). */
function originOf(facts: EnvEntryFacts, row: WorkAppEnvValueMetadata | null): AppEnvOrigin {
    if (row) {
        return row.origin as AppEnvOrigin;
    }
    switch (facts.source) {
        case 'generate':
            return 'generated';
        case 'prompt':
            return 'prompted';
        case 'value':
            return 'default';
        default:
            return 'derived';
    }
}

/** FR-3's override marker: only a derived or default entry can be overridden. */
function overridesOf(
    facts: EnvEntryFacts,
    row: WorkAppEnvValueMetadata | null,
): 'derived' | 'default' | null {
    if (!row || row.origin !== 'user') {
        return null;
    }
    if (facts.source === 'from' || facts.source === 'template') {
        return 'derived';
    }
    if (facts.source === 'value') {
        return 'default';
    }
    return null;
}

/** The view's validation summary (FR-17). */
function validationOf(
    validate: NonNullable<AppSpecEnvEntry['validate']>,
): AppEnvEntryView['validation'] {
    const validation: NonNullable<AppEnvEntryView['validation']> = {
        hasPattern: typeof validate.pattern === 'string',
    };
    if (typeof validate.length === 'number') validation.length = validate.length;
    if (typeof validate.minLength === 'number') validation.minLength = validate.minLength;
    if (typeof validate.maxLength === 'number') validation.maxLength = validate.maxLength;
    return validation;
}

/** The view's generator summary (FR-10, FR-14). */
function generatorOf(
    generate: NonNullable<AppSpecEnvEntry['generate']>,
): NonNullable<AppEnvEntryView['generator']> {
    const kind = generate.kind as AppEnvGeneratorKind;
    return {
        kind,
        ...(kind === 'keypair'
            ? {
                  keypairFormat: (generate.keypair?.format ??
                      APP_ENV_KEYPAIR_DEFAULT_FORMAT) as AppEnvKeypairFormat,
              }
            : {}),
        rotate: (generate.rotate ?? 'never') as AppEnvEntryView['generator']['rotate'],
    };
}

/** FR-12: the App spec's generator no longer matches the one the value was made with. */
function generatorChanged(facts: EnvEntryFacts, row: WorkAppEnvValueMetadata | null): boolean {
    if (!row || !facts.generate || !row.generatorFingerprint) {
        return false;
    }
    return row.generatorFingerprint !== resolvedGeneratorFingerprint(facts.generate);
}

/** The row's "set by" line, or `null` when it has no actor (or no name for one). */
function actorOf(
    row: WorkAppEnvValueMetadata | null,
    viewer: AppEnvActor | null | undefined,
    actorNames: Map<string, string>,
): { userId: string; name: string } | null {
    const userId = row?.setByUserId;
    if (!userId) {
        return null;
    }
    if (viewer && viewer.userId === userId) {
        return { userId, name: viewer.name ?? null };
    }
    return { userId, name: actorNames.get(userId) ?? null };
}

/** An ISO timestamp, or `null` — the view never carries a `Date`. */
function isoOf(value: Date | string | null | undefined): string | null {
    if (!value) {
        return null;
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The message of a caught value, for a log line that must not carry a value. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
