import { Injectable, Logger } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';

import { WorkRepository } from '../database/repositories/work.repository';
import {
    AppWorkIsolationService,
    type AppWorkSourceBranchSource,
} from './app-work-isolation.service';

/**
 * APW-08 T50 — **the one-off backfill of App Work isolation columns** (APW08-G07, ACC-08-43).
 *
 * T11's `app.spec.applied` listener fires only on an effective-hash change, so an App Work created
 * between APW-01/03 landing and APW-08 P1 is never visited: its `taskIsolationBaseBranch` stays
 * null, `isDeliveryTracked` is never true for it, and its merges complete as before with no
 * delivery chain at all. This runner walks every `kind = 'app'` Work whose base branch is unset
 * and writes the three isolation columns:
 *
 * - `taskIsolation = 'worktree'`
 * - `taskIsolationBaseBranch = <branch>`
 * - `taskIsolationTargetRepo = 'website'`
 *
 * The branch is resolved **exactly as T11's listener does, by the same method**:
 * `AppWorkIsolationService.resolveSourceBranch` (applied spec → `WorkAppSpecState` tracked branch
 * → Work Repository default). The write goes through **the same ownership-scoped update**,
 * `AppWorkIsolationService.apply` (`WHERE id AND userId AND kind = 'app'`). This file owns neither
 * half, so the two cannot drift.
 *
 * ## A job, not a migration
 *
 * Step 3 reads the git provider (the Work Repository's default branch), which a migration cannot.
 * It is exposed as the one-shot Trigger.dev task `app-work-isolation-backfill`
 * (`packages/tasks/src/tasks/trigger/app-work-isolation-backfill.task.ts`), which calls
 * {@link AppWorkIsolationBackfillRunner.run} over the internal RPC channel one PAGE at a time —
 * so no single call holds the channel for more than one page of provider reads — and loops on
 * `nextAfterId` until `done`. Running it is the owner's call; nothing schedules it.
 *
 * ## Idempotent and re-runnable
 *
 * - The page query (`WorkRepository.findAppWorkIdsWithoutIsolationBase`) returns `kind = 'app'`
 *   Works with no base branch ONLY — a non-App Work is never visited, and a Work that already
 *   carries a base branch is never returned. Each row is re-read and both facts re-checked, so a
 *   Work the listener wrote in the meantime is skipped rather than overwritten.
 * - A second run therefore finds nothing to do and writes nothing.
 * - A Work whose branch cannot be resolved (its repository unreadable, no coordinates) is
 *   COUNTED and left alone — never failed, never half-written — and the next run tries it again.
 * - One Work's failure is counted; the run moves on.
 *
 * ## Only the isolation columns
 *
 * T50 names three columns, and this writes three. The checks switches T11 also sets (APW08-G02:
 * `checksPolicy`, `repoDeclaredCommands`) change how an existing App Work's runs are graded, so
 * they are left to the next `app.spec.applied` of each Work — an owner question on the PR, not a
 * side effect of a backfill.
 */

/** The job id the Trigger task registers under (`app-work-isolation-backfill.task.ts`). */
export const APP_WORK_ISOLATION_BACKFILL_JOB_ID = 'app-work-isolation-backfill' as const;

/** Works one {@link AppWorkIsolationBackfillRunner.run} call visits by default. */
export const APP_WORK_ISOLATION_BACKFILL_PAGE = 25;

/** The ceiling on one call's page — each Work may cost one provider read. */
export const APP_WORK_ISOLATION_BACKFILL_PAGE_MAX = 100;

/** How many Work ids an answer lists per bucket, so a run record stays small. */
const LISTED_IDS_MAX = 50;

/** One page of the walk. Serialisable: it crosses the internal RPC channel. */
export interface AppWorkIsolationBackfillOptions {
    /** Works visited by this call (1..{@link APP_WORK_ISOLATION_BACKFILL_PAGE_MAX}). */
    limit?: number;
    /** Keyset cursor: visit Works whose id sorts after this one. */
    afterId?: string | null;
    /** Resolve and count, write nothing. */
    dryRun?: boolean;
}

/** What one page did. Every counter is a count of Works. */
export interface AppWorkIsolationBackfillSummary {
    /** Works the page query returned and this call visited. */
    scanned: number;
    /** Works written (in a dry run: the Works that WOULD be written). */
    updated: number;
    /** Works that needed nothing: already carrying a base branch, gone, or no longer `app`. */
    skipped: number;
    /** Works whose branch could not be resolved — counted and left alone. */
    unresolved: number;
    /** Works whose read or write threw — counted, and the run moved on. */
    failed: number;
    /** Which source answered, for the Works written. */
    bySource: Record<AppWorkSourceBranchSource, number>;
    /** The ids behind `unresolved` and `failed`, each capped at 50. */
    unresolvedWorkIds: string[];
    failedWorkIds: string[];
    /** The cursor for the next page — the last id visited — or the one passed in when none was. */
    nextAfterId: string | null;
    /** `true` when the walk reached the end: the page came back short. */
    done: boolean;
    dryRun: boolean;
    durationMs: number;
}

@Injectable()
export class AppWorkIsolationBackfillRunner {
    private readonly logger = new Logger(AppWorkIsolationBackfillRunner.name);

    constructor(
        private readonly works: WorkRepository,
        /** THE resolver and THE write — shared with T11's listener. */
        private readonly isolation: AppWorkIsolationService,
    ) {}

    /**
     * Visit one page of App Works with no base branch. Never throws for one Work; throws only
     * when the page itself cannot be read (the task then fails loudly and can be re-run).
     */
    async run(
        options: AppWorkIsolationBackfillOptions = {},
    ): Promise<AppWorkIsolationBackfillSummary> {
        const started = Date.now();
        const limit = pageSize(options?.limit);
        const dryRun = options?.dryRun === true;
        const afterId =
            typeof options?.afterId === 'string' && options.afterId.trim()
                ? options.afterId.trim()
                : null;

        const summary: AppWorkIsolationBackfillSummary = {
            scanned: 0,
            updated: 0,
            skipped: 0,
            unresolved: 0,
            failed: 0,
            bySource: { spec: 0, tracked: 0, repository: 0 },
            unresolvedWorkIds: [],
            failedWorkIds: [],
            nextAfterId: afterId,
            done: false,
            dryRun,
            durationMs: 0,
        };

        const ids = await this.works.findAppWorkIdsWithoutIsolationBase(limit, afterId);
        for (const id of ids) {
            summary.scanned += 1;
            summary.nextAfterId = id;
            try {
                await this.visit(id, dryRun, summary);
            } catch (error) {
                summary.failed += 1;
                listed(summary.failedWorkIds, id);
                this.logger.warn(
                    `APW-08 T50: backfilling App Work ${id} failed (${errorText(error)}); moving on.`,
                );
            }
        }
        summary.done = ids.length < limit;
        summary.durationMs = Date.now() - started;

        if (summary.scanned > 0) {
            this.logger.log(
                `APW-08 T50: ${dryRun ? 'dry run — ' : ''}scanned ${summary.scanned}, ` +
                    `${dryRun ? 'would update' : 'updated'} ${summary.updated}, skipped ${summary.skipped}, ` +
                    `unresolved ${summary.unresolved}, failed ${summary.failed}.`,
            );
        }
        return summary;
    }

    /** One Work: re-read, re-check, resolve through the shared resolver, write through the shared write. */
    private async visit(
        id: string,
        dryRun: boolean,
        summary: AppWorkIsolationBackfillSummary,
    ): Promise<void> {
        const work = await this.works.findById(id);
        // Re-checked on the row as it is NOW: the listener may have written it since the page was
        // read, and a Work is never overwritten by a backfill that was meant only to fill a gap.
        if (!work || !isAppWorkKind(work.kind) || (work.taskIsolationBaseBranch ?? '').trim()) {
            summary.skipped += 1;
            return;
        }

        const resolved = await this.isolation.resolveSourceBranch(work);
        if (!resolved.branch || !resolved.source) {
            summary.unresolved += 1;
            listed(summary.unresolvedWorkIds, id);
            this.logger.warn(
                `APW-08 T50: App Work ${id} has no resolvable source branch (${resolved.reason}); left alone.`,
            );
            return;
        }

        const patch = this.isolation.isolationPatch(work, resolved.branch);
        if (dryRun) {
            summary.updated += 1;
            summary.bySource[resolved.source] += 1;
            return;
        }
        if (await this.isolation.apply(work, patch)) {
            summary.updated += 1;
            summary.bySource[resolved.source] += 1;
        } else {
            // The scoped write matched no row: the Work changed owner or kind since it was read.
            summary.skipped += 1;
        }
    }
}

/** `limit` as an integer 1..{@link APP_WORK_ISOLATION_BACKFILL_PAGE_MAX}, else the default page. */
function pageSize(value: unknown): number {
    const size = typeof value === 'number' ? Math.floor(value) : Number.NaN;
    if (!Number.isFinite(size) || size < 1) return APP_WORK_ISOLATION_BACKFILL_PAGE;
    return Math.min(size, APP_WORK_ISOLATION_BACKFILL_PAGE_MAX);
}

function listed(ids: string[], id: string): void {
    if (ids.length < LISTED_IDS_MAX) ids.push(id);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
