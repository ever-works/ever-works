import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_ACTIONS_HYGIENE_MAX_WORKFLOWS,
    APP_BUILD_WORKFLOW_PATH,
    type AppActionsState,
    type AppRepositoryMode,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import type { WorkUpstreamStatePatch } from '../database/repositories/work-upstream-state.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
} from '../entities/activity-log.types';
import type { WorkUpstreamState } from '../entities/work-upstream-state.entity';
import { GitFacadeService, GitOperationNotSupportedError } from '../facades/git.facade';
import { APP_WORK_GIT_PROVIDER_ID } from './app-upstream-state.service';

/**
 * APW-02 T25 — Actions hygiene (plan §6.7, spec §4.6 FR-25…FR-31, ACC-02-08,
 * ACC-02-20).
 *
 * ## What this service is
 *
 * A fresh fork inherits the upstream's `.github/workflows/`, and on the
 * platform's own runners those inherited workflows are somebody else's CI
 * pointed at the member's repository. Hygiene is the one pass that turns them
 * off — **except the Ever Works build workflow**, which is the whole reason the
 * App Work can be built at all — and it is also what stops the App Work from
 * being built if the credential cannot administer Actions.
 *
 * ## The four rules that shape every line below
 *
 *   1. **It never switches Actions off for the repository** (FR-26). The only
 *      `setActionsPermissions` fields this service sets are
 *      `disableWorkflowsExcept`, `skipWorkflowIds` and `maxWorkflows`: no
 *      `enabled`, in either direction, ever — a workflow this platform enabled
 *      for someone else's repository is not a trade hygiene may make.
 *   2. **It does not re-judge a workflow it has already judged** (FR-27). The
 *      ids the last pass saw are stored on the row
 *      (`actionsSeenWorkflowIds`) and passed back as `skipWorkflowIds`, so a
 *      workflow the member deliberately turns back on stays on for good.
 *   3. **It never touches a linked repository** (FR-31). `relation === 'link'`
 *      is `not_applicable`, decided here, before any provider call.
 *   4. **A missing permission never blocks anything** (FR-30). Every failure —
 *      a 403, an unsupported provider, a Work that cannot be read — comes back
 *      as a **return value**, never as a throw, and is recorded in the named
 *      state the Upstream card renders (`needs_admin`,
 *      `permission_missing`, `failed`). The readiness job and the sync run call
 *      this and carry on either way.
 *
 * ## The state row: read for `seenIds`, written once per run
 *
 * The four Actions columns of `work_upstream_states` (plan §3.1:251-254) are
 * this service's own: `AppUpstreamStateService` owns the *lifecycle*
 * transitions (`preparing` → `ready` → …) and hands the Actions block to its
 * response untouched, while every value in that block is written here, by
 * {@link record}. The row itself is reached through the repository rather than
 * through a second copy of the rules, so the worker's remote proxy (the shape
 * `packages/tasks` already uses for `WorkRepository`) is enough to run this
 * off the API event loop.
 *
 * ## Where the refusal states come from
 *
 * Plan §6.7 names four: `clean`, `needs_admin` (an OAuth 403),
 * `permission_missing` (an App 403, with the permission) and `failed`. The
 * provider's own classifier (plan §4.3) is what distinguishes them, and it
 * distinguishes them by **the permission it names**: `administration` is the
 * answer GitHub gives an App installation token ("Resource not accessible by
 * integration"), `actions` the one it gives a user credential. The first means
 * the platform's App needs a permission; the second means the member needs an
 * admin role on the repository — which is exactly the pair of sentences
 * `AppUpstreamStateService.warningsOf` renders for these two states.
 */

/**
 * The reason codes this service records on the row beside a state, in the
 * `needs_admin` / `permission_missing` / `failed` cases (FR-30, FR-54 style: a
 * typed code, never a composed sentence).
 *
 * The provider's own `GitProviderErrorReason` members are recorded verbatim;
 * these four are the ones only this service can know.
 */
export const APP_ACTIONS_HYGIENE_REASONS = [
    /** No state row for the Work — there is nothing to read coordinates from. */
    'state_not_found',
    /** The Work could not be read, so no credential can be resolved for it. */
    'work_not_found',
    /** The provider does not implement the capability (plan §7, `GitOperationNotSupportedError`). */
    'provider_unsupported',
    /** Anything else the provider threw. */
    'unexpected',
] as const;

/** The ceiling the row stores for each recorded workflow list (plan §3.1:252). */
export const APP_ACTIONS_HYGIENE_MAX_RECORDED = 100;

/** The ceiling the row stores for the ids hygiene has judged (plan §3.1:252). */
export const APP_ACTIONS_HYGIENE_MAX_SEEN_IDS = 500;

/** What a caller may already know, so a lean context needs no extra read. */
export interface AppActionsHygieneInput {
    /**
     * The relation, when the caller already has it (the readiness attempt
     * carries it). The row wins whenever it can be read — this only answers
     * when there is no row, so a `link` App Work is still never touched.
     */
    readonly relation?: AppRepositoryMode | null;
    /** The Work Repository coordinates, same rule as {@link relation}. */
    readonly dataOwner?: string | null;
    readonly dataRepo?: string | null;
    /** Ids the caller already knows were judged; merged with the row's (FR-27). */
    readonly seenWorkflowIds?: readonly number[] | null;
}

/** One workflow file, as the row and the Activity entry record it. */
export interface AppHygieneWorkflowRef {
    readonly id: number;
    readonly path: string;
}

/** Everything one hygiene pass did, for the caller and for telemetry (plan §9.1). */
export interface AppActionsHygieneResult {
    /** The named state now recorded on the row (FR-30) — never `pending`. */
    state: AppActionsState;
    /** The typed reason, for the three non-`clean` states. */
    reason?: string;
    /** The permission a refusal named, when the provider named one (FR-54). */
    permission?: string;
    /** The instant the provider named for a rate-limited retry. */
    retryAt?: string;
    /** Disabled by THIS pass (FR-29) — what the Activity entry counts. */
    disabled: AppHygieneWorkflowRef[];
    kept: AppHygieneWorkflowRef[];
    enabled: AppHygieneWorkflowRef[];
    /** Every id this pass judged, merged into `actionsSeenWorkflowIds` (FR-27). */
    seenIds: number[];
    /** The listing cap was reached: a partial pass, reported as one (plan §3.1). */
    truncated: boolean;
    /** Provider calls made. `0` proves the `link` and refusal paths read nothing. */
    calls: number;
    /** `true` when the pass reached the provider and it answered. */
    called: boolean;
    /** `true` when the Activity entry was written (FR-29). */
    emitted: boolean;
    /** `true` when the row was written. */
    recorded: boolean;
}

@Injectable()
export class AppActionsHygieneService {
    private readonly logger = new Logger(AppActionsHygieneService.name);

    constructor(
        /** The epic's own table: where `seenIds` comes from and the result goes. */
        private readonly states: WorkUpstreamStateRepository,
        // Every collaborator below is `@Optional()` and appended in a stable order, so a
        // hand-rolled construction (a unit test, a lean CLI context) can pass a prefix of
        // them and a module that does not import `DatabaseModule` still resolves. Each
        // absent seam has a defined answer, and none of them is "throw": hygiene must
        // never block the caller (FR-30).
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly git?: GitFacadeService,
        @Optional() private readonly activity?: ActivityLogService,
    ) {}

    /**
     * Run one hygiene pass for an App Work (plan §6.7).
     *
     * Never throws. The caller (the readiness job at plan §6.2 step 4, the sync
     * run at §6.3 step 8) records the result and carries on — including when the
     * answer is `failed`, because a repository that cannot be cleaned is still a
     * repository the member can run.
     */
    async apply(workId: string, input?: AppActionsHygieneInput): Promise<AppActionsHygieneResult> {
        const state = await this.loadState(workId);
        const relation = state?.relation ?? input?.relation ?? null;
        const seenIds = mergeIds(
            state?.actionsSeenWorkflowIds,
            input?.seenWorkflowIds,
            APP_ACTIONS_HYGIENE_MAX_SEEN_IDS,
        );

        // FR-31 — a linked repository is not the platform's to touch, and that
        // answer is a property of the relation rather than of a job having run.
        if (relation === 'link') {
            const recorded = await this.record(workId, {
                actionsState: 'not_applicable',
                actionsCheckedAt: new Date(),
            });
            return this.result({ state: 'not_applicable', seenIds, recorded });
        }

        const owner = state?.dataOwner ?? input?.dataOwner ?? null;
        const repo = state?.dataRepo ?? input?.dataRepo ?? null;
        if (!owner || !repo) {
            // No coordinates anywhere: there is nothing to read workflows from, and
            // guessing a repository would be worse than saying so.
            const recorded = await this.record(workId, {
                actionsState: 'failed',
                actionsCheckedAt: new Date(),
            });
            return this.result({
                state: 'failed',
                reason: 'state_not_found',
                seenIds,
                recorded,
            });
        }

        if (!this.git) {
            // §7's posture for a capability the platform cannot reach: a named
            // failure, never a silent skip that looks like a clean pass.
            return this.failed(workId, 'provider_unsupported', seenIds);
        }

        const work = await this.loadWork(workId);
        const userId = work?.userId;
        if (!userId) {
            return this.failed(workId, 'work_not_found', seenIds);
        }

        try {
            const result = await this.git.setActionsPermissions(
                owner,
                repo,
                {
                    // FR-25/FR-66: everything inherited is disabled except the
                    // platform's own build workflow. `enabled` is deliberately
                    // absent — FR-26 forbids switching Actions off, and this
                    // service never enables anything either (APW-02 T51 adds the
                    // one gated-fork exception, with its own call).
                    disableWorkflowsExcept: [APP_BUILD_WORKFLOW_PATH],
                    skipWorkflowIds: seenIds,
                    maxWorkflows: APP_ACTIONS_HYGIENE_MAX_WORKFLOWS,
                },
                { userId, providerId: APP_WORK_GIT_PROVIDER_ID, workId },
            );

            const nextSeenIds = mergeIds(
                seenIds,
                result?.seenIds,
                APP_ACTIONS_HYGIENE_MAX_SEEN_IDS,
            );
            const disabled = toRefs(result?.disabled);
            const kept = toRefs(result?.kept);
            const enabled = toRefs(result?.enabled);

            if (result?.truncated) {
                this.logger.warn(
                    `Actions hygiene for work ${workId} reached the ${APP_ACTIONS_HYGIENE_MAX_WORKFLOWS}-workflow cap: this pass is partial.`,
                );
            }

            const recorded = await this.record(workId, {
                actionsState: 'clean',
                actionsSeenWorkflowIds: nextSeenIds,
                actionsDisabledWorkflows: mergeRefs(
                    state?.actionsDisabledWorkflows,
                    disabled,
                    APP_ACTIONS_HYGIENE_MAX_RECORDED,
                ),
                actionsKeptWorkflows: mergeRefs(
                    state?.actionsKeptWorkflows,
                    kept,
                    APP_ACTIONS_HYGIENE_MAX_RECORDED,
                ),
                actionsCheckedAt: new Date(),
            });

            // FR-29 — one entry per run that disabled at least one workflow, and
            // only then. A clean pass that disabled nothing is not an event.
            const emitted =
                disabled.length > 0 ? await this.emitDisabled(workId, userId, disabled) : false;

            return this.result({
                state: 'clean',
                disabled,
                kept,
                enabled,
                seenIds: nextSeenIds,
                truncated: result?.truncated === true,
                calls: 1,
                called: true,
                emitted,
                recorded,
            });
        } catch (error) {
            return this.refusal(workId, error, seenIds);
        }
    }

    // ── the refusal paths (FR-30) ────────────────────────────────────────────

    /**
     * Map a provider failure onto a named state, record it and return it.
     *
     * The three branches are plan §6.7's own three, and each one is a different
     * sentence to the member: `needs_admin` is a role they can grant,
     * `permission_missing` is an App permission the operator grants, and
     * `failed` is neither — it is the platform telling the truth about a call
     * that did not work.
     */
    private async refusal(
        workId: string,
        error: unknown,
        seenIds: number[],
    ): Promise<AppActionsHygieneResult> {
        if (error instanceof GitOperationNotSupportedError) {
            return this.failed(workId, 'provider_unsupported', seenIds);
        }

        const permission = permissionOf(error);
        const reason = providerReasonOf(error);

        if (reason === 'permission_missing') {
            const state: AppActionsState =
                permission === 'administration' ? 'permission_missing' : 'needs_admin';
            const recorded = await this.record(workId, {
                actionsState: state,
                actionsCheckedAt: new Date(),
            });
            this.logger.warn(
                `Actions hygiene for work ${workId} was refused (${state}, permission: ${permission ?? 'unknown'}); readiness and sync are unaffected.`,
            );
            return this.result({
                state,
                reason,
                permission,
                seenIds,
                calls: 1,
                called: true,
                recorded,
            });
        }

        const retryAt = retryAtOf(error);
        const recorded = await this.record(workId, {
            actionsState: 'failed',
            actionsCheckedAt: new Date(),
        });
        this.logger.warn(
            `Actions hygiene for work ${workId} failed (${reason ?? 'unexpected'}); readiness and sync are unaffected.`,
        );

        return this.result({
            state: 'failed',
            reason: reason ?? 'unexpected',
            permission,
            retryAt,
            seenIds,
            calls: 1,
            called: true,
            recorded,
        });
    }

    /** A failure this service decided itself — no provider call was made. */
    private async failed(
        workId: string,
        reason: string,
        seenIds: number[],
    ): Promise<AppActionsHygieneResult> {
        const recorded = await this.record(workId, {
            actionsState: 'failed',
            actionsCheckedAt: new Date(),
        });
        this.logger.warn(
            `Actions hygiene for work ${workId} could not run (${reason}); readiness and sync are unaffected.`,
        );
        return this.result({ state: 'failed', reason, seenIds, recorded });
    }

    // ── internals ────────────────────────────────────────────────────────────

    private result(
        partial: Partial<AppActionsHygieneResult> & { state: AppActionsState },
    ): AppActionsHygieneResult {
        return {
            reason: undefined,
            permission: undefined,
            retryAt: undefined,
            disabled: [],
            kept: [],
            enabled: [],
            seenIds: [],
            truncated: false,
            calls: 0,
            called: false,
            emitted: false,
            recorded: false,
            ...partial,
        };
    }

    private async loadState(workId: string): Promise<WorkUpstreamState | null> {
        try {
            return await this.states.findByWorkId(workId);
        } catch (error) {
            this.logger.warn(
                `Actions hygiene: reading the state row of work ${workId} failed (${errorText(error)}); falling back to the caller's input.`,
            );
            return null;
        }
    }

    /** The Work owner — every facade call needs a credential, and this is whose it is. */
    private async loadWork(workId: string): Promise<{ userId: string } | null> {
        if (!this.works) {
            return null;
        }
        try {
            return await this.works.findById(workId);
        } catch (error) {
            this.logger.warn(
                `Actions hygiene: reading work ${workId} failed (${errorText(error)}).`,
            );
            return null;
        }
    }

    /** The one write of the four Actions columns; a failure is logged, never thrown. */
    private async record(workId: string, patch: WorkUpstreamStatePatch): Promise<boolean> {
        try {
            return await this.states.update(workId, patch);
        } catch (error) {
            this.logger.warn(
                `Actions hygiene: recording the state of work ${workId} failed (${errorText(error)}); the pass itself is unaffected.`,
            );
            return false;
        }
    }

    /** `app.actions.disabled { count, paths }` — plan §3.5, FR-29. */
    private async emitDisabled(
        workId: string,
        userId: string,
        disabled: AppHygieneWorkflowRef[],
    ): Promise<boolean> {
        if (!this.activity) {
            this.logger.warn(
                `Actions hygiene: app.actions.disabled for work ${workId} was not recorded (no ActivityLogService).`,
            );
            return false;
        }

        const entry: CreateActivityLogDto = {
            userId,
            workId,
            actionType: ActivityActionType.APP_ACTIONS,
            action: 'app.actions.disabled',
            status: ActivityStatus.COMPLETED,
            summary: 'Inherited workflows were disabled',
            details: { count: disabled.length, paths: disabled.map((ref) => ref.path) },
        };

        try {
            await this.activity.log(entry);
            return true;
        } catch (error) {
            this.logger.warn(
                `Actions hygiene: recording app.actions.disabled for work ${workId} failed (${errorText(error)}).`,
            );
            return false;
        }
    }
}

/** The `{ id, path }` refs of a provider answer, defensively shaped. */
function toRefs(
    refs: readonly { id: number; path: string }[] | undefined | null,
): AppHygieneWorkflowRef[] {
    return (refs ?? [])
        .filter((ref) => !!ref && typeof ref.path === 'string')
        .map((ref) => ({ id: ref.id, path: ref.path }));
}

/** Union of two id lists, bounded, order-stable (FR-27's `seen` set). */
function mergeIds(
    first: readonly number[] | null | undefined,
    second: readonly number[] | null | undefined,
    cap: number,
): number[] {
    const merged: number[] = [];
    for (const id of [...(first ?? []), ...(second ?? [])]) {
        if (typeof id !== 'number' || merged.includes(id)) continue;
        if (merged.length >= cap) break;
        merged.push(id);
    }
    return merged;
}

/**
 * Union of two workflow lists, keyed by path, bounded (FR-29: "record the
 * disabled and kept workflow paths").
 *
 * The union rather than the last run's list, and that direction is deliberate:
 * the card exists so a member can see what hygiene turned off, and a later pass
 * that disabled nothing must not erase the answer.
 */
function mergeRefs(
    first: readonly { id: number; path: string }[] | null | undefined,
    second: readonly AppHygieneWorkflowRef[] | null | undefined,
    cap: number,
): AppHygieneWorkflowRef[] {
    const merged: AppHygieneWorkflowRef[] = [];
    const seen = new Set<string>();
    for (const ref of [...(first ?? []), ...(second ?? [])]) {
        if (!ref || typeof ref.path !== 'string' || seen.has(ref.path)) continue;
        if (merged.length >= cap) break;
        seen.add(ref.path);
        merged.push({ id: ref.id, path: ref.path });
    }
    return merged;
}

/** The typed provider reason of a thrown value, or `null` when it is not one. */
function providerReasonOf(error: unknown): string | null {
    if (error instanceof GitProviderRequestError) {
        return error.reason;
    }
    // Across a remote-proxy hop an instance check can fail while the shape survives,
    // so the duck-typed read is the one that keeps the state correct in the worker.
    const candidate = error as { reason?: unknown; status?: unknown } | null | undefined;
    if (candidate && typeof candidate.reason === 'string' && typeof candidate.status === 'number') {
        return candidate.reason;
    }
    return null;
}

/** The permission a provider refusal named, when it named one (FR-54). */
function permissionOf(error: unknown): string | undefined {
    const details = (error as { details?: { permission?: unknown } } | null | undefined)?.details;
    return details && typeof details.permission === 'string' ? details.permission : undefined;
}

/** The instant a rate-limited provider named for the retry (FR-50). */
function retryAtOf(error: unknown): string | undefined {
    const details = (error as { details?: { retryAt?: unknown } } | null | undefined)?.details;
    return details && typeof details.retryAt === 'string' ? details.retryAt : undefined;
}

/** A safe, log-injectable rendering of a caught value. */
function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}
