/**
 * APW-03 T28–T31 (lane aw-blueprints) — `AppBlueprintUpgradeService`: a Blueprint
 * applied to an App Work after its creation, and every later **upgrade** of it.
 *
 * Before this service a Blueprint applied once (inline, at create — see
 * `AppBlueprintApplyService`) and could never be upgraded. Now:
 *
 * ```
 * request(workId, mode, version)        ── synchronous, the route's answer
 *   ├─ refuse: noBlueprint · noUpgrade · blueprintNotFound · blueprintVersionNotFound ·
 *   │          blueprintAlreadyApplied · applyInProgress (§4.2)
 *   ├─ an open proposal for that version ⇒ { status: 'existing', pullRequest }  (200)
 *   ├─ claim the Work's one run (blueprintUpgradeStatus = 'queued', guarded UPDATE)
 *   ├─ Activity  app.blueprint.{apply,upgrade}_requested   (who asked — the audit row)
 *   └─ dispatch `app-blueprint-apply` ─ null (no runtime) ⇒ run in this process
 *
 * run(payload)                          ── the job (Trigger task, or in-process)
 *   ├─ per-Work lock app-blueprint-apply:<workId>
 *   ├─ theirs = the Blueprint at the target version   (resolver, SSRF-contained)
 *   ├─ base   = the Blueprint at the applied version  (apply mode: empty; unreadable: two-way)
 *   ├─ ours   = the Work's .works/works.yml at the tracked branch's head
 *   ├─ merge  = mergeAppSpecDocuments(base, ours, theirs)   — conflicts keep ours, listed
 *   ├─ refuse a merge that validates worse than ours did
 *   ├─ ONE pull request: branch ever-works/blueprint[-upgrade]/<id>, an open one updated
 *   │  rather than a second opened (FR-51); NEVER a push to the tracked branch
 *   └─ blueprintUpgradeStatus = 'proposed', blueprintUpgradePr = { … conflicts … }
 *
 * reconcile(workId)                     ── on `app.spec.applied` (the merge landed)
 *   └─ the effective spec names the proposed version ⇒ the Work now follows it:
 *      blueprintVersion / blueprintSha / blueprintApplyStatus = 'applied', proposal cleared,
 *      Activity app.blueprint.applied (apply) · app.blueprint.upgraded (upgrade)
 * ```
 *
 * ## Whose credential, whose decision
 *
 * The pull request is opened with the **Work owner's** git credential (`userId:
 * work.userId`, as every App Works write to the Work Repository is); the member who asked
 * is recorded on the Activity rows. Nothing merges by itself: the proposal is a pull
 * request the member reviews and merges.
 *
 * ## Why every collaborator is optional
 *
 * The class is declared in the agent `AppWorksModule`, which deliberately does not import
 * `AppSpecModule`; the App spec state repository is looked up lazily through `ModuleRef`
 * (exactly as `AppBlueprintApplyService` does), and a graph without it answers
 * `dependenciesUnavailable` rather than failing to compile.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
    APP_BLUEPRINT_UPGRADE_CONFLICTS_LISTED,
    APP_SOURCE_REPOSITORY_TYPE_BY_MODE,
    type AppBlueprintRunMode,
    type AppBlueprintUpgradeConflictSummary,
    type AppBlueprintUpgradePr,
    type AppRepositoryMode,
    type AppSourceRecord,
} from '@ever-works/contracts';
import * as semver from 'semver';
import * as yaml from 'yaml';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityStatus, type ActivityActionType } from '../entities/activity-log.types';
import type { Work } from '../entities/work.entity';
import type { WorkAppSpecState } from '../entities/work-app-spec-state.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import {
    GitFacadeService,
    GitOperationNotSupportedError,
    type GitFacadeOptions,
} from '../facades/git.facade';
import { getOptionalProvider } from '../utils/optional-provider.util';
import { validateAppSpecDocument } from '../works-config/schema/app-spec.validate';
import {
    APP_BLUEPRINT_APPLY_DISPATCHER,
    APP_BLUEPRINT_APPLY_JOB_ID,
    type AppBlueprintApplyDispatcher,
    type AppBlueprintApplyJobPayload,
} from './app-blueprint-apply.job';
import {
    APP_BLUEPRINT_ACTIVITY_ACTION_TYPE,
    adaptBlueprintForRelation,
} from './app-blueprint-apply.service';
import {
    AppBlueprintResolverService,
    AppsCatalogCredentialUnavailableError,
    type AppBlueprintRelease,
} from './app-blueprint-resolver.service';
import {
    formatMergePath,
    mergeAppSpecDocuments,
    previewMergeValue,
    renderMergedAppSpecText,
    type AppSpecMergeResult,
} from './app-spec-merge';

/** The file every run reads and proposes. */
export const APP_BLUEPRINT_SPEC_FILE = '.works/works.yml';

/** Branch of an `apply` proposal: `ever-works/blueprint/<id>` (plan §2.5 step 5). */
export const APP_BLUEPRINT_APPLY_BRANCH_PREFIX = 'ever-works/blueprint/';

/** Branch of an `upgrade` proposal: `ever-works/blueprint-upgrade/<id>` (plan §2.5 "Upgrade"). */
export const APP_BLUEPRINT_UPGRADE_BRANCH_PREFIX = 'ever-works/blueprint-upgrade/';

/** A `queued` / `running` claim older than this is retaken (a lost dispatch). */
export const APP_BLUEPRINT_RUN_STALE_MS = 30 * 60_000;

/** The per-Work lock's TTL; the job's own budget is 300 s. */
export const APP_BLUEPRINT_RUN_LOCK_TTL_MS = 10 * 60_000;

/** How many times a non-fast-forward commit is retried after re-reading the branch. */
export const APP_BLUEPRINT_COMMIT_ATTEMPTS = 3;

/** Notices one fan-out run records at most (plan §6.4: ≤ 500 Works per run). */
export const APP_BLUEPRINT_NOTICES_PER_RUN = 500;

/** Distinct Blueprints one fan-out run reads at most. */
export const APP_BLUEPRINT_NOTICE_BLUEPRINTS_PER_RUN = 100;

/** How many Blueprint changes a pull request body lists by path. */
const PR_BODY_CHANGES_LISTED = 30;

/** The per-Work lock key. */
export function blueprintRunLockKey(workId: string): string {
    return `app-blueprint-apply:${workId}`;
}

/** CONTRACTS §6 names (the first four) and this lane's additive ones. */
export const APP_BLUEPRINT_RUN_EVENTS = {
    matched: 'app.blueprint.matched',
    applied: 'app.blueprint.applied',
    applyFailed: 'app.blueprint.apply_failed',
    upgradeAvailable: 'app.blueprint.upgrade_available',
    applyRequested: 'app.blueprint.apply_requested',
    upgradeRequested: 'app.blueprint.upgrade_requested',
    applyProposed: 'app.blueprint.apply_proposed',
    upgradeProposed: 'app.blueprint.upgrade_proposed',
    upgradeFailed: 'app.blueprint.upgrade_failed',
    upgraded: 'app.blueprint.upgraded',
    upgradeDismissed: 'app.blueprint.upgrade_dismissed',
} as const;

/** Every reason code a request refuses with or a run fails with. */
export const APP_BLUEPRINT_RUN_CODES = {
    dependenciesUnavailable: 'dependenciesUnavailable',
    workNotFound: 'workNotFound',
    notAnAppWork: 'notAnAppWork',
    noBlueprint: 'noBlueprint',
    noUpgrade: 'noUpgrade',
    blueprintNotFound: 'blueprintNotFound',
    blueprintVersionNotFound: 'blueprintVersionNotFound',
    blueprintAlreadyApplied: 'blueprintAlreadyApplied',
    applyInProgress: 'applyInProgress',
    catalogUnavailable: 'catalogUnavailable',
    invalidPayload: 'invalidPayload',
    repositoryUnresolved: 'repositoryUnresolved',
    trackedBranchMissing: 'trackedBranchMissing',
    worksYmlUnreadable: 'worksYmlUnreadable',
    worksYmlUnparseable: 'worksYmlUnparseable',
    worksYmlOtherKind: 'worksYmlOtherKind',
    blueprintUnparseable: 'blueprintUnparseable',
    mergedSpecInvalid: 'mergedSpecInvalid',
    providerUnsupported: 'providerUnsupported',
    branchUnavailable: 'branchUnavailable',
    commitRejected: 'commitRejected',
    pullRequestFailed: 'pullRequestFailed',
    unexpected: 'unexpected',
} as const;

export type AppBlueprintRunCode =
    (typeof APP_BLUEPRINT_RUN_CODES)[keyof typeof APP_BLUEPRINT_RUN_CODES];

/** The HTTP status each request refusal maps to (plan §4.2 where it names one). */
export const APP_BLUEPRINT_REFUSAL_STATUS: Readonly<Record<string, number>> = {
    dependenciesUnavailable: 503,
    catalogUnavailable: 503,
    workNotFound: 404,
    blueprintNotFound: 404,
    blueprintVersionNotFound: 404,
    notAnAppWork: 422,
    noBlueprint: 422,
    noUpgrade: 422,
    blueprintAlreadyApplied: 409,
    applyInProgress: 409,
};

const BLUEPRINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const UUID_LIKE = /^[0-9A-Za-z-]{1,64}$/;

/**
 * `candidate` is a newer Blueprint version than `current`. Semver when both parse (a
 * leading `v` tolerated); with no current version anything valid is newer; two strings
 * semver cannot read are never "newer" — an upgrade is only offered when it is provable.
 */
export function isNewerBlueprintVersion(
    candidate: string | null | undefined,
    current: string | null | undefined,
): boolean {
    const next = cleanVersion(candidate);
    if (!next) return false;
    if (current === null || current === undefined || String(current).trim() === '') return true;
    const now = cleanVersion(current);
    return now ? semver.gt(next, now) : false;
}

/** A semver string, `v` prefix tolerated, or `null`. */
function cleanVersion(value: string | null | undefined): string | null {
    return semver.valid(
        String(value ?? '')
            .trim()
            .replace(/^v/, ''),
    );
}

/** A `MAJOR` bump (FR-51's `Breaking:` label). `0.x → 0.y` is not one. */
export function isBreakingBlueprintUpgrade(
    from: string | null | undefined,
    to: string | null | undefined,
): boolean {
    const a = cleanVersion(from);
    const b = cleanVersion(to);
    return Boolean(a && b && semver.major(b) > semver.major(a));
}

export type AppBlueprintRequestOutcome =
    | {
          readonly status: 'queued';
          readonly mode: AppBlueprintRunMode;
          readonly blueprintId: string;
          readonly version: string;
          readonly runId: string | null;
          /** `true` when no job runtime took it and it runs in this process. */
          readonly inProcess: boolean;
      }
    | {
          readonly status: 'existing';
          readonly mode: AppBlueprintRunMode;
          readonly blueprintId: string;
          readonly version: string;
          readonly pullRequest: AppBlueprintUpgradePr;
      }
    | {
          readonly status: 'refused';
          readonly code: string;
          readonly httpStatus: number;
          readonly message: string;
      };

export interface AppBlueprintRunResult {
    readonly status: 'proposed' | 'unchanged' | 'failed' | 'skipped';
    readonly workId: string;
    readonly mode: AppBlueprintRunMode | null;
    readonly version: string | null;
    readonly reason: string | null;
    readonly pullRequest: { readonly number: number; readonly url: string } | null;
    readonly conflictCount: number;
}

interface RepositoryContext {
    readonly work: Work;
    readonly owner: string;
    readonly repo: string;
    readonly trackedBranch: string;
    readonly gitOptions: GitFacadeOptions;
    readonly relation: AppRepositoryMode;
    readonly sourceOwner: string | null;
}

interface Landing {
    readonly number: number;
    readonly url: string;
    readonly branch: string;
}

class RunFailure extends Error {
    constructor(
        readonly code: AppBlueprintRunCode,
        readonly detail?: Record<string, unknown>,
    ) {
        super(code);
        this.name = 'RunFailure';
    }
}

function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function relationOfRecord(record: AppSourceRecord | null | undefined): AppRepositoryMode {
    const type = record?.type;
    const entry = (
        Object.entries(APP_SOURCE_REPOSITORY_TYPE_BY_MODE) as Array<[AppRepositoryMode, string]>
    ).find(([, value]) => value === type);
    return entry ? entry[0] : 'link';
}

/** The provider's "not a fast-forward" — both spellings (see `isNonFastForward`, APW-01). */
function isNonFastForward(error: unknown): boolean {
    if (isRecord(error) && nonEmpty(error.code) === 'nonFastForward') return true;
    return isRecord(error) && (error as { reason?: unknown }).reason === 'conflict';
}

@Injectable()
export class AppBlueprintUpgradeService {
    private readonly logger = new Logger(AppBlueprintUpgradeService.name);

    /** The clock, replaceable by a spec. */
    now: () => Date = () => new Date();

    constructor(
        @Optional() private readonly resolver?: AppBlueprintResolverService,
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly git?: GitFacadeService,
        @Optional() private readonly activity?: ActivityLogService,
        @Optional() private readonly locks?: DistributedTaskLockService,
        @Optional()
        @Inject(APP_BLUEPRINT_APPLY_DISPATCHER)
        private readonly dispatcher?: AppBlueprintApplyDispatcher,
        @Optional() private readonly moduleRef?: ModuleRef,
    ) {}

    /** The App spec state repository, when this graph has one (the API's does). */
    private states(): WorkAppSpecStateRepository | undefined {
        if (!this.moduleRef) return undefined;
        try {
            return getOptionalProvider<WorkAppSpecStateRepository>(
                this.moduleRef,
                WorkAppSpecStateRepository,
            );
        } catch {
            return undefined;
        }
    }

    /* ------------------------------------------------------------------ *
     * request — the route's synchronous half
     * ------------------------------------------------------------------ */

    async request(input: {
        workId: string;
        userId?: string | null;
        mode: AppBlueprintRunMode;
        blueprintId?: string | null;
        version?: string | null;
    }): Promise<AppBlueprintRequestOutcome> {
        const states = this.states();
        if (!states || !this.works || !this.resolver) {
            return this.refused(
                'dependenciesUnavailable',
                'Blueprint upgrades are not available in this installation.',
            );
        }
        const state = await states.findByWorkId(input.workId);
        const work = state ? await this.works.findById(input.workId) : null;
        if (!state || !work) {
            return this.refused('workNotFound', `Work ${input.workId} has no App spec state yet.`);
        }
        if (work.kind !== 'app') {
            return this.refused('notAnAppWork', `Work ${input.workId} is not an App Work.`);
        }
        const context = this.repositoryContext(work, state);
        const sourceOwner = context?.sourceOwner ?? null;

        let blueprintId: string;
        let wanted: string | null;
        if (input.mode === 'upgrade') {
            if (!state.blueprintId) {
                return this.refused(
                    'noBlueprint',
                    'This App Work follows no Blueprint, so there is nothing to upgrade.',
                );
            }
            blueprintId = state.blueprintId;
            wanted = nonEmpty(input.version) ?? nonEmpty(state.blueprintLatestVersion);
            if (
                !wanted ||
                !VERSION_PATTERN.test(wanted) ||
                !isNewerBlueprintVersion(wanted, state.blueprintVersion)
            ) {
                return this.refused(
                    'noUpgrade',
                    `Version ${wanted ?? '(none)'} is not newer than the applied ${state.blueprintVersion ?? 'version'}.`,
                );
            }
        } else {
            const id = nonEmpty(input.blueprintId);
            if (!id || !BLUEPRINT_ID_PATTERN.test(id)) {
                return this.refused('blueprintNotFound', 'No Blueprint has that id.');
            }
            blueprintId = id;
            wanted = nonEmpty(input.version);
            if (wanted && !VERSION_PATTERN.test(wanted)) {
                return this.refused(
                    'blueprintVersionNotFound',
                    `The Blueprint has no version ${wanted}.`,
                );
            }
            const ownProposal = state.blueprintUpgradePr?.mode === 'apply';
            if (state.blueprintId && state.blueprintApplyStatus === 'applied') {
                return this.refused(
                    'blueprintAlreadyApplied',
                    `This App Work already follows the ${state.blueprintId} Blueprint; upgrade it instead.`,
                );
            }
            if (state.blueprintApplyStatus === 'applying' && !ownProposal) {
                return this.refused(
                    'applyInProgress',
                    'A Blueprint is already being applied to this App Work.',
                );
            }
        }

        // An open proposal for exactly this target is answered, not duplicated (FR-51).
        const proposal = state.blueprintUpgradePr;
        if (
            state.blueprintUpgradeStatus === 'proposed' &&
            proposal &&
            (proposal.mode ?? 'upgrade') === input.mode &&
            (wanted ? proposal.version === wanted : true) &&
            (input.mode === 'upgrade' || state.blueprintId === blueprintId) &&
            context &&
            (await this.isPullRequestOpen(context, proposal.number))
        ) {
            return {
                status: 'existing',
                mode: input.mode,
                blueprintId,
                version: proposal.version,
                pullRequest: proposal,
            };
        }

        let release: AppBlueprintRelease | null;
        try {
            release = await this.resolver.readBlueprintRelease(blueprintId, {
                sourceOwner,
                version: wanted,
            });
        } catch (error) {
            if (!(error instanceof AppsCatalogCredentialUnavailableError)) {
                this.logger.warn(
                    `Blueprint request for work ${input.workId}: reading ${blueprintId} failed (${errorText(error)}).`,
                );
            }
            return this.refused(
                'catalogUnavailable',
                'The Blueprint repositories cannot be read right now.',
            );
        }
        if (!release) {
            return wanted
                ? this.refused(
                      'blueprintVersionNotFound',
                      `The ${blueprintId} Blueprint has no readable version ${wanted}.`,
                  )
                : this.refused('blueprintNotFound', `No readable Blueprint "${blueprintId}".`);
        }
        const version = release.hit.version;
        if (input.mode === 'upgrade' && !isNewerBlueprintVersion(version, state.blueprintVersion)) {
            return this.refused(
                'noUpgrade',
                `Version ${version} is not newer than the applied ${state.blueprintVersion}.`,
            );
        }

        const now = this.now();
        const claimed = await states.claimBlueprintRun(
            input.workId,
            now,
            new Date(now.getTime() - APP_BLUEPRINT_RUN_STALE_MS),
        );
        if (!claimed) {
            return this.refused(
                'applyInProgress',
                'A Blueprint run for this App Work is already in progress.',
            );
        }

        if (input.mode === 'apply') {
            await this.recordApplyMatch(input.workId, release, input.userId ?? null);
        }

        const payload: AppBlueprintApplyJobPayload = {
            workId: input.workId,
            mode: input.mode,
            blueprintId,
            version,
            userId: input.userId ?? null,
            requestedAt: now.toISOString(),
        };
        await this.logActivity(input.workId, input.userId ?? work.userId ?? null, {
            action:
                input.mode === 'apply'
                    ? APP_BLUEPRINT_RUN_EVENTS.applyRequested
                    : APP_BLUEPRINT_RUN_EVENTS.upgradeRequested,
            status: ActivityStatus.PENDING,
            summary:
                input.mode === 'apply'
                    ? `Applying the ${blueprintId} Blueprint ${version} was requested`
                    : `Upgrading the ${blueprintId} Blueprint to ${version} was requested`,
            details: {
                blueprintId,
                version,
                fromVersion: input.mode === 'upgrade' ? (state.blueprintVersion ?? null) : null,
                mode: input.mode,
            },
        });

        let runId: string | null = null;
        if (this.dispatcher) {
            try {
                runId = await this.dispatcher.dispatch(payload);
            } catch (error) {
                this.logger.warn(
                    `Blueprint run for work ${input.workId}: dispatch failed (${errorText(error)}); running in-process.`,
                );
                runId = null;
            }
        }
        const inProcess = runId === null;
        if (inProcess) {
            // No job runtime took it: run it here, after the answer. A user is waiting
            // for a pull request, and a dropped request would leave the claim to go stale.
            void this.run(payload).catch((error) =>
                this.logger.warn(
                    `Blueprint run for work ${input.workId} failed in-process (${errorText(error)}).`,
                ),
            );
        }
        return { status: 'queued', mode: input.mode, blueprintId, version, runId, inProcess };
    }

    /**
     * `POST …/blueprint/dismiss` — hide the upgrade notice for ONE version (FR-50). A
     * newer version raises the notice again. Answers the stored version, or a refusal.
     */
    async dismiss(input: {
        workId: string;
        userId?: string | null;
        version: string;
    }): Promise<
        | { status: 'dismissed'; version: string }
        | { status: 'refused'; code: string; httpStatus: number; message: string }
    > {
        const states = this.states();
        if (!states) {
            return this.refused(
                'dependenciesUnavailable',
                'Blueprint upgrades are not available in this installation.',
            );
        }
        const state = await states.findByWorkId(input.workId);
        if (!state) {
            return this.refused('workNotFound', `Work ${input.workId} has no App spec state yet.`);
        }
        if (!state.blueprintId) {
            return this.refused('noBlueprint', 'This App Work follows no Blueprint.');
        }
        const version = nonEmpty(input.version);
        if (
            !version ||
            !VERSION_PATTERN.test(version) ||
            !isNewerBlueprintVersion(version, state.blueprintVersion)
        ) {
            return this.refused(
                'noUpgrade',
                `Version ${version ?? '(none)'} is not an upgrade of this App Work.`,
            );
        }
        await states.patchBlueprintRun(input.workId, { blueprintUpgradeDismissedVersion: version });
        await this.logActivity(input.workId, input.userId ?? null, {
            action: APP_BLUEPRINT_RUN_EVENTS.upgradeDismissed,
            status: ActivityStatus.COMPLETED,
            summary: `The ${state.blueprintId} Blueprint ${version} upgrade notice was dismissed`,
            details: {
                blueprintId: state.blueprintId,
                version,
                fromVersion: state.blueprintVersion ?? null,
            },
        });
        return { status: 'dismissed', version };
    }

    /* ------------------------------------------------------------------ *
     * run — the job
     * ------------------------------------------------------------------ */

    async run(payload: AppBlueprintApplyJobPayload): Promise<AppBlueprintRunResult> {
        const workId = typeof payload?.workId === 'string' ? payload.workId : '';
        const mode = payload?.mode === 'apply' || payload?.mode === 'upgrade' ? payload.mode : null;
        const blueprintId = typeof payload?.blueprintId === 'string' ? payload.blueprintId : '';
        const version = typeof payload?.version === 'string' ? payload.version : '';
        if (
            !UUID_LIKE.test(workId) ||
            !mode ||
            !BLUEPRINT_ID_PATTERN.test(blueprintId) ||
            !VERSION_PATTERN.test(version)
        ) {
            return this.result(
                'failed',
                workId,
                mode,
                version || null,
                APP_BLUEPRINT_RUN_CODES.invalidPayload,
            );
        }
        const job: AppBlueprintApplyJobPayload = { ...payload, workId, mode, blueprintId, version };
        if (!this.locks) {
            return this.execute(job);
        }
        const locked = await this.locks.runExclusive(
            blueprintRunLockKey(workId),
            () => this.execute(job),
            {
                ttlMs: APP_BLUEPRINT_RUN_LOCK_TTL_MS,
            },
        );
        if (!locked.acquired) {
            return this.result('skipped', workId, mode, version, 'locked');
        }
        return locked.result as AppBlueprintRunResult;
    }

    private async execute(job: AppBlueprintApplyJobPayload): Promise<AppBlueprintRunResult> {
        const states = this.states();
        if (!states || !this.works || !this.git || !this.resolver) {
            return this.result(
                'failed',
                job.workId,
                job.mode,
                job.version,
                APP_BLUEPRINT_RUN_CODES.dependenciesUnavailable,
            );
        }
        const state = await states.findByWorkId(job.workId);
        const work = state ? await this.works.findById(job.workId) : null;
        if (!state || !work) {
            return this.result(
                'failed',
                job.workId,
                job.mode,
                job.version,
                APP_BLUEPRINT_RUN_CODES.workNotFound,
            );
        }
        await states.patchBlueprintRun(job.workId, {
            blueprintUpgradeStatus: 'running',
            blueprintUpgradeError: null,
        });

        try {
            const context = this.repositoryContext(work, state);
            if (!context) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.repositoryUnresolved);

            const theirs = await this.readRelease(
                job.blueprintId,
                context.sourceOwner,
                job.version,
                null,
            );
            if (!theirs) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.blueprintVersionNotFound);
            const theirsDoc = this.blueprintDocument(theirs, context.relation);

            const fromVersion = job.mode === 'upgrade' ? (state.blueprintVersion ?? null) : null;
            let baseDoc: Record<string, unknown> | null = {};
            if (job.mode === 'upgrade') {
                const base = fromVersion
                    ? await this.readRelease(
                          job.blueprintId,
                          context.sourceOwner,
                          fromVersion,
                          state.blueprintSha ?? null,
                      )
                    : null;
                baseDoc = base ? this.blueprintDocument(base, context.relation) : null;
            }

            const ours = await this.readOurs(context);
            const merge = mergeAppSpecDocuments(baseDoc, ours.doc, theirsDoc);
            if (!merge.changed) {
                await states.patchBlueprintRun(job.workId, {
                    blueprintUpgradeStatus: 'unchanged',
                    blueprintUpgradeError: null,
                });
                return this.result('unchanged', job.workId, job.mode, job.version, null);
            }

            const text = renderMergedAppSpecText(ours.text, merge.merged, {
                conflicts: merge.conflicts,
                blueprintVersion: job.version,
            });
            this.assertValidatesNoWorse(ours.text, text);

            const breaking =
                job.mode === 'upgrade' && isBreakingBlueprintUpgrade(fromVersion, job.version);
            const landing = await this.propose(
                context,
                state,
                job,
                text,
                merge,
                theirs,
                fromVersion,
                breaking,
            );

            const conflicts: AppBlueprintUpgradeConflictSummary[] = merge.conflicts
                .slice(0, APP_BLUEPRINT_UPGRADE_CONFLICTS_LISTED)
                .map((conflict) => ({
                    path: conflict.path,
                    kind: conflict.kind,
                    ...(conflict.theirs !== undefined
                        ? { proposed: previewMergeValue(conflict.theirs) }
                        : {}),
                }));
            const proposal: AppBlueprintUpgradePr = {
                number: landing.number,
                url: landing.url,
                version: job.version,
                breaking,
                mode: job.mode,
                fromVersion,
                branch: landing.branch,
                blueprintSha: theirs.sha,
                baseKnown: merge.baseKnown,
                conflictCount: merge.conflictCount,
                conflicts,
                updatedAt: this.now().toISOString(),
            };
            await states.patchBlueprintRun(job.workId, {
                blueprintUpgradeStatus: 'proposed',
                blueprintUpgradeError: null,
                blueprintUpgradePr: proposal,
                ...(theirs.hit.repo ? { blueprintRepo: theirs.hit.repo } : {}),
            });
            await this.logActivity(job.workId, job.userId ?? work.userId ?? null, {
                action:
                    job.mode === 'apply'
                        ? APP_BLUEPRINT_RUN_EVENTS.applyProposed
                        : APP_BLUEPRINT_RUN_EVENTS.upgradeProposed,
                status: ActivityStatus.COMPLETED,
                summary:
                    job.mode === 'apply'
                        ? `The ${job.blueprintId} Blueprint ${job.version} was proposed in pull request #${landing.number}`
                        : `Upgrading the ${job.blueprintId} Blueprint to ${job.version} was proposed in pull request #${landing.number}`,
                details: {
                    blueprintId: job.blueprintId,
                    version: job.version,
                    fromVersion,
                    mode: job.mode,
                    breaking,
                    baseKnown: merge.baseKnown,
                    conflictCount: merge.conflictCount,
                    conflictPaths: conflicts.map((conflict) => conflict.path),
                    pullRequest: { number: landing.number, url: landing.url },
                },
            });
            return {
                status: 'proposed',
                workId: job.workId,
                mode: job.mode,
                version: job.version,
                reason: null,
                pullRequest: { number: landing.number, url: landing.url },
                conflictCount: merge.conflictCount,
            };
        } catch (error) {
            const code =
                error instanceof RunFailure ? error.code : APP_BLUEPRINT_RUN_CODES.unexpected;
            if (!(error instanceof RunFailure)) {
                this.logger.warn(
                    `Blueprint run for work ${job.workId} failed unexpectedly (${errorText(error)}).`,
                );
            }
            await this.recordFailure(
                states,
                work,
                job,
                code,
                error instanceof RunFailure ? error.detail : undefined,
            );
            return this.result('failed', job.workId, job.mode, job.version, code);
        }
    }

    /* ------------------------------------------------------------------ *
     * reconcile — the proposal landed
     * ------------------------------------------------------------------ */

    /**
     * Called on `app.spec.applied`: when the Work's effective spec now names the version
     * a proposal carried, that proposal was merged. Idempotent: a Work with no proposal,
     * or whose effective spec names another version, is left alone. Answers whether it
     * recorded a landing.
     */
    async reconcile(workId: string): Promise<boolean> {
        const states = this.states();
        if (!states || typeof workId !== 'string' || workId === '') return false;
        const state = await states.findByWorkId(workId);
        const proposal = state?.blueprintUpgradePr;
        if (!state || !proposal || state.blueprintUpgradeStatus !== 'proposed') return false;
        const effective = state.effectiveSpec?.blueprint;
        if (
            !effective ||
            effective.id !== state.blueprintId ||
            effective.version !== proposal.version
        ) {
            return false;
        }
        await states.patchBlueprintRun(workId, {
            blueprintVersion: proposal.version,
            blueprintSha: proposal.blueprintSha ?? null,
            blueprintApplyStatus: 'applied',
            blueprintApplyError: null,
            blueprintApplyRef: { kind: 'pull_request', number: proposal.number, url: proposal.url },
            blueprintUpgradePr: null,
            blueprintUpgradeStatus: null,
            blueprintUpgradeError: null,
        });
        const mode = proposal.mode ?? 'upgrade';
        const owner = this.works
            ? ((await this.works.findById(workId).catch(() => null))?.userId ?? null)
            : null;
        await this.logActivity(workId, owner, {
            action:
                mode === 'apply'
                    ? APP_BLUEPRINT_RUN_EVENTS.applied
                    : APP_BLUEPRINT_RUN_EVENTS.upgraded,
            status: ActivityStatus.COMPLETED,
            summary:
                mode === 'apply'
                    ? `The ${state.blueprintId} Blueprint ${proposal.version} was applied (pull request #${proposal.number} merged)`
                    : `The ${state.blueprintId} Blueprint was upgraded to ${proposal.version} (pull request #${proposal.number} merged)`,
            details: {
                blueprintId: state.blueprintId,
                version: proposal.version,
                fromVersion: proposal.fromVersion ?? null,
                mode,
                ref: { kind: 'pull_request', number: proposal.number, url: proposal.url },
            },
        });
        return true;
    }

    /* ------------------------------------------------------------------ *
     * refreshUpgradeNotices — "a new Blueprint version is out"
     * ------------------------------------------------------------------ */

    /**
     * APW-03 T30 — the upgrade-notice fan-out (plan §2.5 "Upgrade", §6.4), run hourly by
     * the API cron (`APPS_CATALOG_REFRESH_CRON`, `23 * * * *`):
     *
     *  1. every distinct Blueprint id an App Work follows;
     *  2. that Blueprint's latest release — its default branch, read through the
     *     resolver (public Blueprints only: no Work's owner is in scope here, so a private
     *     first-party Blueprint is never read on a Work's behalf);
     *  3. each Work on an older version (`findUpgradeCandidates` + `semver`) gets
     *     `blueprintLatestVersion` set and ONE `app.blueprint.upgrade_available` row per
     *     version (the guarded write is the once-only rule), with the `breaking` flag of a
     *     `MAJOR` bump.
     *
     * At most `limit` notices per run (plan: ≤ 500); the rest are reached by the next run.
     * One Blueprint that cannot be read never stops the others.
     */
    async refreshUpgradeNotices(options: { limit?: number } = {}): Promise<{
        blueprints: number;
        scanned: number;
        notices: number;
    }> {
        const summary = { blueprints: 0, scanned: 0, notices: 0 };
        const states = this.states();
        if (!states || !this.resolver) return summary;
        const limit = Math.max(
            1,
            Math.min(options.limit ?? APP_BLUEPRINT_NOTICES_PER_RUN, APP_BLUEPRINT_NOTICES_PER_RUN),
        );

        const ids = await states.listFollowedBlueprintIds(APP_BLUEPRINT_NOTICE_BLUEPRINTS_PER_RUN);
        for (const blueprintId of ids) {
            if (summary.notices >= limit) break;
            let release: AppBlueprintRelease | null = null;
            try {
                release = await this.resolver.readBlueprintRelease(blueprintId, {
                    sourceOwner: null,
                });
            } catch (error) {
                if (error instanceof AppsCatalogCredentialUnavailableError) {
                    return summary; // nothing can be read this run
                }
                this.logger.warn(
                    `Blueprint notices: reading ${blueprintId} failed (${errorText(error)}).`,
                );
                continue;
            }
            if (!release) continue;
            summary.blueprints += 1;
            const latest = release.hit.version;

            const candidates = await states.findUpgradeCandidates(
                blueprintId,
                latest,
                limit - summary.notices,
                { excludeNotified: true },
            );
            for (const candidate of candidates) {
                summary.scanned += 1;
                if (!isNewerBlueprintVersion(latest, candidate.blueprintVersion)) continue;
                if (candidate.blueprintLatestVersion === latest) continue;
                let first = false;
                try {
                    first = await states.markUpgradeAvailable(candidate.workId, latest);
                } catch (error) {
                    this.logger.warn(
                        `Blueprint notices: marking work ${candidate.workId} failed (${errorText(error)}).`,
                    );
                    continue;
                }
                if (!first) continue;
                summary.notices += 1;
                const breaking = isBreakingBlueprintUpgrade(candidate.blueprintVersion, latest);
                const owner = this.works
                    ? ((await this.works.findById(candidate.workId).catch(() => null))?.userId ??
                      null)
                    : null;
                await this.logActivity(candidate.workId, owner, {
                    action: APP_BLUEPRINT_RUN_EVENTS.upgradeAvailable,
                    status: ActivityStatus.COMPLETED,
                    summary: `${breaking ? 'Breaking: ' : ''}the ${blueprintId} Blueprint ${latest} is available (this App Work follows ${candidate.blueprintVersion})`,
                    details: {
                        blueprintId,
                        version: latest,
                        fromVersion: candidate.blueprintVersion ?? null,
                        breaking,
                    },
                });
                if (summary.notices >= limit) break;
            }
        }
        return summary;
    }

    /* ------------------------------------------------------------------ *
     * The steps
     * ------------------------------------------------------------------ */

    private repositoryContext(work: Work, state: WorkAppSpecState): RepositoryContext | null {
        const owner = nonEmpty(work.getRepoOwner?.('website'));
        const repo = nonEmpty(work.getWebsiteRepo?.());
        const trackedBranch = nonEmpty(state.trackedBranch);
        if (!owner || !repo || !trackedBranch) return null;
        const providerId = nonEmpty(work.gitProvider) ?? 'github';
        const record = (work.sourceRepository ?? {}) as AppSourceRecord;
        const relation = relationOfRecord(record);
        const sourceOwner =
            relation === 'link'
                ? (nonEmpty(record.owner) ?? owner)
                : (nonEmpty(record.upstream?.owner) ?? null);
        return {
            work,
            owner,
            repo,
            trackedBranch,
            gitOptions: { userId: work.userId, providerId, workId: work.id },
            relation,
            sourceOwner,
        };
    }

    private async readRelease(
        blueprintId: string,
        sourceOwner: string | null,
        version: string,
        sha: string | null,
    ): Promise<AppBlueprintRelease | null> {
        try {
            return await this.resolver!.readBlueprintRelease(blueprintId, {
                sourceOwner,
                version,
                sha,
            });
        } catch (error) {
            if (error instanceof AppsCatalogCredentialUnavailableError) {
                throw new RunFailure(APP_BLUEPRINT_RUN_CODES.catalogUnavailable);
            }
            throw error;
        }
    }

    /** The release's document, relation-adapted (GAP-02; its own `source` dropped). */
    private blueprintDocument(
        release: AppBlueprintRelease,
        relation: AppRepositoryMode,
    ): Record<string, unknown> {
        let parsed: unknown;
        try {
            parsed = yaml.parse(release.text);
        } catch {
            throw new RunFailure(APP_BLUEPRINT_RUN_CODES.blueprintUnparseable);
        }
        if (!isRecord(parsed)) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.blueprintUnparseable);
        return adaptBlueprintForRelation(parsed, relation).document;
    }

    private async readOurs(
        context: RepositoryContext,
    ): Promise<{ text: string; doc: Record<string, unknown>; head: string }> {
        let head: string | null;
        try {
            const commit = await this.git!.getLatestCommit(
                context.owner,
                context.repo,
                context.trackedBranch,
                context.gitOptions,
            );
            head = nonEmpty(commit?.sha);
        } catch {
            head = null;
        }
        if (!head) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.trackedBranchMissing);

        let text = '';
        try {
            const file = await this.git!.getFileContent(
                context.owner,
                context.repo,
                APP_BLUEPRINT_SPEC_FILE,
                context.gitOptions,
                head,
            );
            text = typeof file?.content === 'string' ? file.content : '';
        } catch (error) {
            this.logger.warn(
                `Blueprint run: reading ${APP_BLUEPRINT_SPEC_FILE} of ${context.owner}/${context.repo} failed (${errorText(error)}).`,
            );
            throw new RunFailure(APP_BLUEPRINT_RUN_CODES.worksYmlUnreadable);
        }

        if (text.trim() === '') return { text, doc: {}, head };
        let parsed: unknown;
        try {
            parsed = yaml.parse(text);
        } catch {
            throw new RunFailure(APP_BLUEPRINT_RUN_CODES.worksYmlUnparseable);
        }
        if (parsed === null || parsed === undefined) return { text, doc: {}, head };
        if (!isRecord(parsed)) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.worksYmlUnparseable);
        if (parsed.kind !== undefined && parsed.kind !== 'app') {
            throw new RunFailure(APP_BLUEPRINT_RUN_CODES.worksYmlOtherKind);
        }
        return { text, doc: parsed, head };
    }

    /** A merge may not validate WORSE than the member's own file did. */
    private assertValidatesNoWorse(oursText: string, mergedText: string): void {
        const merged = validateAppSpecDocument(mergedText, { mode: 'data-repository' });
        const ours =
            oursText.trim() === ''
                ? null
                : validateAppSpecDocument(oursText, { mode: 'data-repository' });
        if (merged.errorCount > (ours?.errorCount ?? 0)) {
            throw new RunFailure(APP_BLUEPRINT_RUN_CODES.mergedSpecInvalid, {
                errorCount: merged.errorCount,
                codes: merged.issues
                    .filter((issue) => issue.severity === 'error')
                    .slice(0, 10)
                    .map((issue) => issue.code),
            });
        }
    }

    private async isPullRequestOpen(context: RepositoryContext, number: number): Promise<boolean> {
        if (!this.git || typeof number !== 'number' || number <= 0) return false;
        try {
            const pr = await this.git.getPullRequest(
                context.owner,
                context.repo,
                number,
                context.gitOptions,
            );
            return pr?.state === 'open';
        } catch {
            return false;
        }
    }

    /** The open pull request whose head is one of `branches`, matched locally too. */
    private async findOpenPullRequest(
        context: RepositoryContext,
        branches: readonly string[],
    ): Promise<{ number: number; url: string; branch: string } | null> {
        for (const branch of branches) {
            let rows: Awaited<ReturnType<GitFacadeService['listPullRequests']>> = [];
            try {
                rows = await this.git!.listPullRequests(
                    context.owner,
                    context.repo,
                    { state: 'open', head: `${context.owner}:${branch}` },
                    context.gitOptions,
                );
            } catch {
                rows = [];
            }
            const match = (Array.isArray(rows) ? rows : []).find(
                (row) =>
                    row?.state === 'open' &&
                    (row.head === branch || row.head?.endsWith(`:${branch}`) === true) &&
                    typeof row.number === 'number',
            );
            if (match) return { number: match.number, url: match.url, branch };
        }
        return null;
    }

    private async branchHead(context: RepositoryContext, branch: string): Promise<string | null> {
        try {
            const commit = await this.git!.getLatestCommit(
                context.owner,
                context.repo,
                branch,
                context.gitOptions,
            );
            return nonEmpty(commit?.sha);
        } catch {
            return null;
        }
    }

    /**
     * ONE pull request: an open one on this run's branch is updated (a new commit and a
     * refreshed body), never duplicated; otherwise a fresh branch from the tracked head.
     * Nothing is ever pushed to the tracked branch, and nothing is force-moved.
     */
    private async propose(
        context: RepositoryContext,
        state: WorkAppSpecState,
        job: AppBlueprintApplyJobPayload,
        text: string,
        merge: AppSpecMergeResult,
        theirs: AppBlueprintRelease,
        fromVersion: string | null,
        breaking: boolean,
    ): Promise<Landing> {
        const git = this.git!;
        const prefix =
            job.mode === 'apply'
                ? APP_BLUEPRINT_APPLY_BRANCH_PREFIX
                : APP_BLUEPRINT_UPGRADE_BRANCH_PREFIX;
        const primary = `${prefix}${job.blueprintId}`;
        const remembered = nonEmpty(state.blueprintUpgradePr?.branch);
        const candidates = [
            primary,
            ...(remembered && remembered !== primary && remembered.startsWith(prefix)
                ? [remembered]
                : []),
        ];

        const head = (await this.branchHead(context, context.trackedBranch)) ?? null;
        if (!head) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.trackedBranchMissing);

        const existing = await this.findOpenPullRequest(context, candidates);
        let branch: string;
        let baseSha: string;
        if (existing) {
            branch = existing.branch;
            baseSha = (await this.branchHead(context, branch)) ?? head;
        } else {
            const versionSlug = job.version.replace(/[^0-9A-Za-z.-]+/g, '-');
            const names = [
                primary,
                `${primary}-${versionSlug}`,
                `${primary}-${versionSlug}-${head.slice(0, 7)}`,
            ];
            let created: { name: string; sha: string } | null = null;
            for (const name of names) {
                try {
                    const made = await git.createBranchFromSha(
                        context.owner,
                        context.repo,
                        name,
                        head,
                        context.gitOptions,
                    );
                    created = { name, sha: nonEmpty(made?.commit) ?? head };
                    break;
                } catch (error) {
                    if (error instanceof GitOperationNotSupportedError) {
                        throw new RunFailure(APP_BLUEPRINT_RUN_CODES.providerUnsupported);
                    }
                    // The name is taken (a closed proposal's branch) — try the next one.
                }
            }
            if (!created) throw new RunFailure(APP_BLUEPRINT_RUN_CODES.branchUnavailable);
            branch = created.name;
            baseSha = created.sha;
        }

        await this.commitIfDifferent(context, branch, baseSha, text, job);

        const title = this.pullRequestTitle(job, breaking);
        const body = this.pullRequestBody(context, job, merge, theirs, fromVersion, breaking);
        if (existing) {
            try {
                await git.updatePullRequest(
                    context.owner,
                    context.repo,
                    existing.number,
                    { title, body },
                    context.gitOptions,
                );
            } catch (error) {
                // The new commit is on the branch either way; a stale description is not a failure.
                this.logger.warn(
                    `Blueprint run: refreshing pull request #${existing.number} failed (${errorText(error)}).`,
                );
            }
            return { number: existing.number, url: existing.url, branch };
        }
        try {
            const created = await git.createPullRequest(
                {
                    owner: context.owner,
                    repo: context.repo,
                    title,
                    head: branch,
                    base: context.trackedBranch,
                    body,
                },
                context.gitOptions,
            );
            if (!created?.url || typeof created.number !== 'number') {
                throw new RunFailure(APP_BLUEPRINT_RUN_CODES.pullRequestFailed);
            }
            return { number: created.number, url: created.url, branch };
        } catch (error) {
            if (error instanceof RunFailure) throw error;
            this.logger.warn(
                `Blueprint run: opening the pull request for work ${job.workId} failed (${errorText(error)}).`,
            );
            throw new RunFailure(APP_BLUEPRINT_RUN_CODES.pullRequestFailed);
        }
    }

    private async commitIfDifferent(
        context: RepositoryContext,
        branch: string,
        baseSha: string,
        text: string,
        job: AppBlueprintApplyJobPayload,
    ): Promise<void> {
        const git = this.git!;
        let onBranch: string | null = null;
        try {
            const file = await git.getFileContent(
                context.owner,
                context.repo,
                APP_BLUEPRINT_SPEC_FILE,
                context.gitOptions,
                baseSha,
            );
            onBranch = typeof file?.content === 'string' ? file.content : null;
        } catch {
            onBranch = null;
        }
        if (onBranch === text) return;

        const message =
            job.mode === 'apply'
                ? `chore(app): apply the ${job.blueprintId} Blueprint ${job.version}`
                : `chore(app): upgrade the ${job.blueprintId} Blueprint to ${job.version}`;
        let sha = baseSha;
        for (let attempt = 1; attempt <= APP_BLUEPRINT_COMMIT_ATTEMPTS; attempt += 1) {
            try {
                await git.commitFiles(
                    context.owner,
                    context.repo,
                    {
                        branch,
                        baseSha: sha,
                        message,
                        files: [
                            { path: APP_BLUEPRINT_SPEC_FILE, content: text, encoding: 'utf-8' },
                        ],
                    },
                    context.gitOptions,
                );
                return;
            } catch (error) {
                if (error instanceof GitOperationNotSupportedError) {
                    throw new RunFailure(APP_BLUEPRINT_RUN_CODES.providerUnsupported);
                }
                if (!isNonFastForward(error) || attempt === APP_BLUEPRINT_COMMIT_ATTEMPTS) {
                    this.logger.warn(
                        `Blueprint run: committing to ${branch} failed (${errorText(error)}).`,
                    );
                    throw new RunFailure(APP_BLUEPRINT_RUN_CODES.commitRejected);
                }
                sha = (await this.branchHead(context, branch)) ?? sha;
            }
        }
    }

    private pullRequestTitle(job: AppBlueprintApplyJobPayload, breaking: boolean): string {
        if (job.mode === 'apply') {
            return `Apply the ${job.blueprintId} Blueprint ${job.version}`;
        }
        return `${breaking ? 'Breaking: ' : ''}Upgrade the ${job.blueprintId} Blueprint to ${job.version}`;
    }

    /**
     * The pull request body: what changed, what collided, what could not be judged. It
     * lists paths and the Blueprint's (public) proposed values only — never a value of the
     * member's own file.
     */
    private pullRequestBody(
        context: RepositoryContext,
        job: AppBlueprintApplyJobPayload,
        merge: AppSpecMergeResult,
        theirs: AppBlueprintRelease,
        fromVersion: string | null,
        breaking: boolean,
    ): string {
        const lines: string[] = [];
        if (job.mode === 'apply') {
            lines.push(
                `This pull request applies the **${job.blueprintId}** Blueprint (${job.version}, \`${theirs.hit.repo}\`) to \`${APP_BLUEPRINT_SPEC_FILE}\`.`,
            );
        } else {
            lines.push(
                `This pull request upgrades the **${job.blueprintId}** Blueprint from ${fromVersion ?? 'an unknown version'} to **${job.version}** (\`${theirs.hit.repo}\`).`,
            );
            if (breaking) {
                lines.push(
                    '',
                    '> **Breaking:** this is a major version bump. Review the changes before merging.',
                );
            }
        }
        lines.push(
            '',
            `Only \`${APP_BLUEPRINT_SPEC_FILE}\` changes. Nothing was pushed to \`${context.trackedBranch}\`; the upgrade takes effect when you merge.`,
        );
        if (!merge.baseKnown) {
            lines.push(
                '',
                `> The Blueprint's ${fromVersion ?? 'previous'} version could not be read, so every value your file and the new version disagree on was treated as a conflict (yours kept), and nothing was removed.`,
            );
        }
        if (merge.applied.length > 0) {
            lines.push('', '### Blueprint changes applied', '');
            for (const change of merge.applied.slice(0, PR_BODY_CHANGES_LISTED)) {
                lines.push(`- \`${change.path}\` — ${change.kind}`);
            }
            if (merge.applied.length > PR_BODY_CHANGES_LISTED) {
                lines.push(`- … and ${merge.applied.length - PR_BODY_CHANGES_LISTED} more`);
            }
        }
        if (merge.conflictCount > 0) {
            lines.push(
                '',
                `### Conflicts (${merge.conflictCount}) — your value was kept`,
                '',
                'Each kept value carries a `# ever-works:` note in the file. Edit it to take the Blueprint value, or leave it as it is.',
                '',
            );
            for (const conflict of merge.conflicts.slice(
                0,
                APP_BLUEPRINT_UPGRADE_CONFLICTS_LISTED,
            )) {
                const proposed =
                    conflict.theirs !== undefined
                        ? `; the Blueprint proposes ${previewMergeValue(conflict.theirs)}`
                        : '';
                lines.push(
                    `- \`${formatMergePath(conflict.segments)}\` — ${conflict.kind.replace(/_/g, ' ')}${proposed}`,
                );
            }
            if (merge.conflictCount > APP_BLUEPRINT_UPGRADE_CONFLICTS_LISTED) {
                lines.push(
                    `- … and ${merge.conflictCount - APP_BLUEPRINT_UPGRADE_CONFLICTS_LISTED} more`,
                );
            }
        }
        lines.push('', '---', `Opened by Ever Works (job \`${APP_BLUEPRINT_APPLY_JOB_ID}\`).`);
        return lines.join('\n');
    }

    private async recordApplyMatch(
        workId: string,
        release: AppBlueprintRelease,
        userId: string | null,
    ): Promise<void> {
        const states = this.states();
        if (!states) return;
        try {
            const first = await states.markBlueprintMatched(
                workId,
                release.hit.id,
                release.hit.version,
                'explicit',
            );
            await states.patchBlueprint(workId, {
                blueprintRepo: release.hit.repo,
                blueprintApplyError: null,
            });
            if (first) {
                await this.logActivity(workId, userId, {
                    action: APP_BLUEPRINT_RUN_EVENTS.matched,
                    status: ActivityStatus.COMPLETED,
                    summary: `The ${release.hit.id} Blueprint was chosen for this App Work`,
                    details: {
                        blueprintId: release.hit.id,
                        version: release.hit.version,
                        matchSource: 'explicit',
                    },
                });
            }
        } catch (error) {
            this.logger.warn(
                `Blueprint request: recording the match for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    private async recordFailure(
        states: WorkAppSpecStateRepository,
        work: Work,
        job: AppBlueprintApplyJobPayload,
        code: string,
        detail?: Record<string, unknown>,
    ): Promise<void> {
        try {
            await states.patchBlueprintRun(job.workId, {
                blueprintUpgradeStatus: 'failed',
                blueprintUpgradeError: code,
                ...(job.mode === 'apply'
                    ? { blueprintApplyStatus: 'failed' as const, blueprintApplyError: code }
                    : {}),
            });
        } catch (error) {
            this.logger.warn(
                `Blueprint run: recording the failure for work ${job.workId} failed (${errorText(error)}).`,
            );
        }
        await this.logActivity(job.workId, job.userId ?? work.userId ?? null, {
            action:
                job.mode === 'apply'
                    ? APP_BLUEPRINT_RUN_EVENTS.applyFailed
                    : APP_BLUEPRINT_RUN_EVENTS.upgradeFailed,
            status: ActivityStatus.FAILED,
            summary:
                job.mode === 'apply'
                    ? `The ${job.blueprintId} Blueprint could not be proposed (${code})`
                    : `The ${job.blueprintId} Blueprint upgrade to ${job.version} could not be proposed (${code})`,
            details: {
                blueprintId: job.blueprintId,
                version: job.version,
                mode: job.mode,
                reason: code,
                ...(detail ?? {}),
            },
        });
    }

    private async logActivity(
        workId: string,
        userId: string | null,
        entry: {
            action: string;
            status: ActivityStatus;
            summary: string;
            details: Record<string, unknown>;
        },
    ): Promise<void> {
        if (!this.activity) return;
        try {
            await this.activity.log({
                userId: userId ?? undefined,
                workId,
                actionType: APP_BLUEPRINT_ACTIVITY_ACTION_TYPE as unknown as ActivityActionType,
                action: entry.action,
                status: entry.status,
                summary: entry.summary,
                details: entry.details,
            } as never);
        } catch (error) {
            this.logger.warn(
                `Blueprint: recording ${entry.action} for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    private refused(code: keyof typeof APP_BLUEPRINT_REFUSAL_STATUS | string, message: string) {
        return {
            status: 'refused' as const,
            code,
            httpStatus: APP_BLUEPRINT_REFUSAL_STATUS[code] ?? 422,
            message,
        };
    }

    private result(
        status: AppBlueprintRunResult['status'],
        workId: string,
        mode: AppBlueprintRunMode | null,
        version: string | null,
        reason: string | null,
    ): AppBlueprintRunResult {
        return { status, workId, mode, version, reason, pullRequest: null, conflictCount: 0 };
    }
}
