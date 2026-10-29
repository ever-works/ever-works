import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    isAppWorkKind,
    normalizeWorkRepoDeclaredCommandPolicy,
    type AppSpec,
    type WorkChecksPolicy,
    type WorkRepoDeclaredCommandPolicy,
} from '@ever-works/contracts';

import { AppSpecService, isUsableAppSpecStatus } from '../app-spec/app-spec.service';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import type { Work } from '../entities/work.entity';
import { GitFacadeService } from '../facades/git.facade';
import { resolveTaskRepository, taskRepositoryRole } from '../tasks-domain/task-repository';
import { APP_WORK_GIT_PROVIDER_ID } from './app-upstream-state.service';

/**
 * APW-08 T11 / T50 — the ONE place that decides what an App Work's Task columns should say, and
 * the one place that writes them.
 *
 * Two callers, one rule:
 *
 * - **T11's `app.spec.applied` listener** (`app-spec-applied.listener.ts`) — keeps the Work in
 *   step every time the effective App spec changes.
 * - **T50's backfill runner** (`app-work-isolation-backfill.runner.ts`) — visits the App Works
 *   created before that listener existed, which it will never be woken for (it fires only on an
 *   effective-hash change).
 *
 * Both resolve the branch through {@link AppWorkIsolationService.resolveSourceBranch} and write
 * through {@link AppWorkIsolationService.apply}. T50 says the backfill resolves the branch
 * "exactly as T11's listener does" and writes "through the same ownership-scoped update"; the only
 * honest way to keep that promise is for neither caller to own a copy of either half.
 *
 * ## Which branch (APW08-G07)
 *
 * `spec.source.branch` is OPTIONAL in APW-03's schema (`schema.md:117`) and defaults to the Work
 * Repository's default branch, and APW-03 never writes a default back into the file
 * (`schema.md:20`). Reading `source.branch` alone therefore leaves `taskIsolationBaseBranch` null
 * on every App Work whose spec omits it — `isDeliveryTracked` is never true and FR-30 is silently
 * off. So the branch is resolved in this order (plan §2.4, T11):
 *
 * 1. the applied spec's `source.branch` (at the event's commit, when there is one);
 * 2. APW-03's `WorkAppSpecState.trackedBranch` — the branch whose head is evaluated, itself
 *    defaulted from the Work Repository's default at create and moved when a valid head
 *    declares another;
 * 3. the Work Repository's default branch, read through `GitFacadeService.getRepository`.
 *
 * Step 3 reads the **Work Repository** — the `website` role, which is what
 * `resolveTaskRepository` answers for an App Work — and NEVER `data`: an App Work has no data
 * repository (`work-capabilities.ts`: `app` is `data: false`), and `getDataRepo()` falls back to
 * a `${slug}-data` name that does not exist. A resolution that would read `data` refuses instead.
 *
 * ## Which columns (plan §2.6, APW08-G02)
 *
 * - `taskIsolation = 'worktree'`, `taskIsolationBaseBranch = <the branch>`,
 *   `taskIsolationTargetRepo = 'website'` — {@link AppWorkIsolationService.isolationPatch}. The
 *   target is `taskRepositoryRole(work.kind)`, the rule every Task path already acts on
 *   (`task-repository.ts`), so the column can never name a different repository than the one the
 *   Tasks actually use. For `app` that is `'website'`.
 * - `checksPolicy = 'required'` when the spec declares a required check, and
 *   `repoDeclaredCommands = { mode: 'allowlist', allow: <the existing list> }` —
 *   {@link AppWorkIsolationService.checksPatch}. Without them `readFleetRepoDeclaredCommands`
 *   reads nothing and the planner skips the read, so a run grades green having verified nothing.
 *
 * Every write is a DIFF: a column that already says the right thing is left out, and an empty
 * patch writes nothing. That is what makes both callers idempotent — a second identical event, or
 * a second backfill run, writes nothing.
 *
 * 🛑 `app` only. {@link AppWorkIsolationService.apply} refuses any other kind before it reaches
 * the database, and the database write is itself `WHERE kind = 'app'`
 * (`WorkRepository.updateAppWorkColumns`). Every other kind keeps exactly the columns it has.
 */

/** Where {@link AppWorkIsolationService.resolveSourceBranch} found the branch. */
export type AppWorkSourceBranchSource = 'spec' | 'tracked' | 'repository';

/** What {@link AppWorkIsolationService.resolveSourceBranch} answers. Never throws. */
export interface AppWorkSourceBranchResolution {
    /** The branch Tasks cut from and target, or `null` when no source could answer. */
    readonly branch: string | null;
    /** Which source answered, or `null` with {@link branch}. */
    readonly source: AppWorkSourceBranchSource | null;
    /**
     * The usable App spec step 1 read (at the commit, when one was given), or `null` when the spec
     * could not be read or is not usable. The listener reads the checks from it, so the checks and
     * the branch always come from the same read.
     */
    readonly spec: AppSpec | null;
    /**
     * Why {@link branch} is `null`: `not_app` · `repository_unresolved` (no Work Repository
     * coordinates, or a resolution that would have read `data`) · `repository_unreadable` (the
     * provider could not be read, or reported no default branch) · `no_git` (no git facade in
     * this graph). `null` whenever a branch was found.
     */
    readonly reason: string | null;
}

/** The longest base branch the `taskIsolationBaseBranch` column holds (`varchar(128)`). */
export const APP_WORK_BASE_BRANCH_MAX = 128;

/**
 * The columns this service keeps in step. Named so a caller (and a spec) can say which ones a
 * write touched without guessing at `Partial<Work>`'s keys.
 */
export type AppWorkIsolationColumn =
    | 'taskIsolation'
    | 'taskIsolationBaseBranch'
    | 'taskIsolationTargetRepo'
    | 'checksPolicy'
    | 'repoDeclaredCommands';

/** A diff of the columns above — only the ones that must change. */
export type AppWorkIsolationPatch = Partial<
    Pick<Work, 'taskIsolation' | 'taskIsolationBaseBranch' | 'taskIsolationTargetRepo'>
> & {
    checksPolicy?: WorkChecksPolicy;
    repoDeclaredCommands?: WorkRepoDeclaredCommandPolicy;
};

/**
 * The checks policies an owner can have chosen and this service must leave alone. `'warn'` is the
 * owner's own answer ("run them, do not block"), and plan §2.6 says it survives; `'required'` is
 * already what the switch would write. Only `'off'` — the column default every Work starts with —
 * and an unrecognised value are switched on.
 */
const CHECKS_POLICIES_KEPT: ReadonlySet<string> = new Set(['warn', 'required']);

@Injectable()
export class AppWorkIsolationService {
    private readonly logger = new Logger(AppWorkIsolationService.name);

    constructor(
        /** The Work row and its ownership-scoped write — required: there is nothing to sync without it. */
        private readonly works: WorkRepository,
        /** APW-03 — step 1 (the applied spec). `@Optional()`: absent, step 1 answers nothing. */
        @Optional() private readonly specs?: AppSpecService,
        /** APW-03 — step 2 (the tracked branch). `@Optional()`: absent, step 2 answers nothing. */
        @Optional() private readonly specStates?: WorkAppSpecStateRepository,
        /** Step 3 (the Work Repository's default branch). `@Optional()`: absent, step 3 answers `no_git`. */
        @Optional() private readonly git?: GitFacadeService,
    ) {}

    /**
     * The branch an App Work's Tasks cut from and target — spec → tracked → Work Repository
     * default (see the file docstring). Never throws: each source that fails is skipped and the
     * next one is asked, and the answer names why when none could.
     *
     * @param opts.commitSha the commit to read the spec at (the listener passes the event's
     *        `commitSha`). Absent, the stored effective spec answers.
     */
    async resolveSourceBranch(
        work: Work,
        opts: { commitSha?: string | null } = {},
    ): Promise<AppWorkSourceBranchResolution> {
        if (!work || !isAppWorkKind(work.kind)) {
            return { branch: null, source: null, spec: null, reason: 'not_app' };
        }

        // 1. The applied spec's `source.branch`.
        const spec = await this.readUsableSpec(work.id, opts.commitSha ?? null);
        const fromSpec = usableBranch(spec?.source?.branch);
        if (fromSpec) {
            return { branch: fromSpec, source: 'spec', spec, reason: null };
        }

        // 2. APW-03's tracked branch.
        const tracked = await this.readTrackedBranch(work.id);
        if (tracked) {
            return { branch: tracked, source: 'tracked', spec, reason: null };
        }

        // 3. The Work Repository's default branch — the `website` role, never `data`.
        const fromRepository = await this.readRepositoryDefault(work);
        if (fromRepository.branch) {
            return { branch: fromRepository.branch, source: 'repository', spec, reason: null };
        }
        return { branch: null, source: null, spec, reason: fromRepository.reason };
    }

    /**
     * The isolation half of the diff: `taskIsolation`, `taskIsolationTargetRepo` and — when a
     * branch was resolved — `taskIsolationBaseBranch`. A column that already says the right thing
     * is left out; an unresolved branch leaves the base column alone (never cleared).
     */
    isolationPatch(work: Work, branch: string | null): AppWorkIsolationPatch {
        const patch: AppWorkIsolationPatch = {};
        if (work.taskIsolation !== 'worktree') {
            patch.taskIsolation = 'worktree';
        }
        // The SAME rule `resolveTaskRepository` acts on — `'website'` for `app` — so the column can
        // never point a reader at a repository the Tasks do not use.
        const targetRepo = taskRepositoryRole(work.kind);
        if (work.taskIsolationTargetRepo !== targetRepo) {
            patch.taskIsolationTargetRepo = targetRepo;
        }
        const next = usableBranch(branch);
        if (next && (work.taskIsolationBaseBranch ?? '').trim() !== next) {
            patch.taskIsolationBaseBranch = next;
        }
        return patch;
    }

    /**
     * The checks half of the diff (APW08-G02, ACC-08-41). `spec` must be the usable spec the
     * branch was read from; with none, nothing is switched (a spec that could not be read is not
     * a reason to change the owner's columns).
     *
     * - `checksPolicy = 'required'` when the spec declares at least one required check — a check
     *   is required unless it says `required: false` (`AppSpecCheck.required`: "`true` when
     *   absent") — and the Work's policy is not already one an owner chose (`'warn'` survives).
     * - `repoDeclaredCommands = { mode: 'allowlist', allow }`, where `allow` is the list the
     *   column already holds (normalized, `[]` by default) — kept even when the stored mode was
     *   `'off'`, so an owner who switched it off and back loses nothing. A wider list is never
     *   narrowed and nothing is ever added to it: each check still has to be admitted (FR-14).
     */
    checksPatch(work: Work, spec: AppSpec | null): AppWorkIsolationPatch {
        if (!spec) return {};
        const patch: AppWorkIsolationPatch = {};

        const checks = Array.isArray(spec.checks) ? spec.checks : [];
        const required = checks.filter((check) => !!check && check.required !== false);
        if (required.length > 0 && !CHECKS_POLICIES_KEPT.has(String(work.checksPolicy ?? ''))) {
            patch.checksPolicy = 'required';
        }

        const raw = work.repoDeclaredCommands as { allow?: unknown } | null | undefined;
        const next: WorkRepoDeclaredCommandPolicy = {
            mode: 'allowlist',
            allow: normalizeWorkRepoDeclaredCommandPolicy({ mode: 'allowlist', allow: raw?.allow })
                .allow,
        };
        const current = normalizeWorkRepoDeclaredCommandPolicy(raw);
        if (current.mode !== next.mode || !sameList(current.allow, next.allow)) {
            patch.repoDeclaredCommands = next;
        }
        return patch;
    }

    /**
     * THE write, ownership-scoped (`WorkRepository.updateAppWorkColumns`: `id`, `userId`,
     * `kind = 'app'`). Refuses any other kind before it reaches the database, and writes nothing
     * for an empty patch. Returns whether a row was written. Throws what the database throws —
     * each caller decides what a failed write means for it.
     */
    async apply(work: Work, patch: AppWorkIsolationPatch): Promise<boolean> {
        if (!work || !isAppWorkKind(work.kind)) return false;
        if (!patch || Object.keys(patch).length === 0) return false;
        if (!work.userId) {
            this.logger.warn(
                `App Work ${work.id} has no owner on its row, so its Task columns were not written.`,
            );
            return false;
        }
        return this.works.updateAppWorkColumns(work.id, work.userId, patch as Partial<Work>);
    }

    /** The column names a patch touches, in a stable order — for an outcome and a log line. */
    static columnsOf(patch: AppWorkIsolationPatch): AppWorkIsolationColumn[] {
        return (Object.keys(patch) as AppWorkIsolationColumn[]).sort();
    }

    // ── The three sources ─────────────────────────────────────────────

    /** Step 1: the spec at `commitSha` (or the stored effective one), when it is usable. */
    private async readUsableSpec(
        workId: string,
        commitSha: string | null,
    ): Promise<AppSpec | null> {
        if (!this.specs?.getEffectiveSpec) return null;
        try {
            const read = await this.specs.getEffectiveSpec(workId, commitSha || undefined);
            if (!read || !isUsableAppSpecStatus(read.status) || !read.spec) return null;
            return read.spec;
        } catch (error) {
            this.logger.warn(
                `App Work ${workId}: the App spec could not be read for its source branch (${errorText(error)}).`,
            );
            return null;
        }
    }

    /** Step 2: APW-03's tracked branch, when it is one the base column can hold. */
    private async readTrackedBranch(workId: string): Promise<string | null> {
        if (!this.specStates?.findByWorkId) return null;
        try {
            const state = await this.specStates.findByWorkId(workId);
            return usableBranch(state?.trackedBranch);
        } catch (error) {
            this.logger.warn(
                `App Work ${workId}: the App spec state could not be read for its tracked branch (${errorText(error)}).`,
            );
            return null;
        }
    }

    /** Step 3: the Work Repository's default branch — the `website` role, never `data`. */
    private async readRepositoryDefault(
        work: Work,
    ): Promise<{ branch: string | null; reason: string }> {
        const target = resolveTaskRepository(work);
        if (!target || target.role !== 'website' || !target.owner || !target.repo) {
            // An App Work's Task repository is its Work Repository. Anything else — no
            // coordinates, or a resolution that would read `data` — is refused, never read.
            return { branch: null, reason: 'repository_unresolved' };
        }
        if (!this.git?.getRepository) {
            return { branch: null, reason: 'no_git' };
        }
        const providerId = work.gitProvider || APP_WORK_GIT_PROVIDER_ID;
        try {
            const repository = await this.git.getRepository(target.owner, target.repo, {
                userId: work.userId,
                providerId,
                workId: work.id,
            });
            const branch = usableBranch(repository?.defaultBranch);
            return branch
                ? { branch, reason: '' }
                : { branch: null, reason: 'repository_unreadable' };
        } catch (error) {
            this.logger.warn(
                `App Work ${work.id}: the Work Repository ${target.owner}/${target.repo} could not be read for its default branch (${errorText(error)}).`,
            );
            return { branch: null, reason: 'repository_unreadable' };
        }
    }
}

/**
 * A branch name the base column can hold and a pull request can target, or `null`.
 *
 * Trimmed; at most {@link APP_WORK_BASE_BRANCH_MAX} characters (the column is `varchar(128)`, the
 * tracked branch `varchar(255)`); no whitespace, no control character and none of the characters
 * git refuses in a ref (`~ ^ : ? * [ \`). Anything else is treated as "this source did not
 * answer", so the next source is asked — a value the column cannot hold must not fail the write
 * of every other column with it.
 */
function usableBranch(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const branch = value.trim();
    if (!branch || branch.length > APP_WORK_BASE_BRANCH_MAX) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(branch)) return null;
    return branch;
}

/** Two string lists with the same entries in the same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
