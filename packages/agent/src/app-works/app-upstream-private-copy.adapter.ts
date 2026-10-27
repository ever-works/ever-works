import { Injectable, Logger, Optional } from '@nestjs/common';
import { APP_PRIVATE_COPY_MAX_SIZE_KB, APP_UPSTREAM_SYNC_BRANCH } from '@ever-works/contracts';
import {
    GIT_REPOSITORY_COPY_DIVERGENCE_MAX_COMMITS,
    GitProviderRequestError,
} from '@ever-works/plugin';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitFacadeService } from '../facades/git.facade';
import { APP_WORK_GIT_PROVIDER_ID } from './app-upstream-state.service';
import type {
    AppUpstreamPrivateCopyComparison,
    AppUpstreamPrivateCopyPort,
    AppUpstreamSyncBranchMove,
} from './app-upstream-sync.service';

/**
 * APW-02 T48 (FR-63, ACC-02-27) — the private copy's compare/move capability, bound to
 * `APP_UPSTREAM_PRIVATE_COPY_PORT`.
 *
 * `AppUpstreamSyncService` already consumes this port (`compare` for the §6.3 step 6 reading,
 * `moveSyncBranch` for the pull-request path); until now nothing provided it, so every
 * private-copy sync ended `failed/provider_unsupported`. This adapter is the thin agent-side
 * half: it turns the port's two calls into the git facade's two provider capabilities
 * (`getRepositoryCopyDivergence`, `moveRepositoryCopyBranch`), with the Work owner's credential.
 *
 * ## No git here (Constitution I)
 *
 * Every byte of git work — the clone, the fetch of the upstream branch, the merge-base count,
 * the pinned push — happens inside the provider plugin. This class only reads two rows and calls
 * the facade. A provider without the capability raises `GitOperationNotSupportedError`, which the
 * sync run already maps to `failed/provider_unsupported` (plan §7) — the same answer as before
 * this binding, never a crash.
 *
 * ## Where the coordinates come from
 *
 * `compare` receives every coordinate it needs. `moveSyncBranch` receives only the copy and the
 * sha, so the upstream coordinates and the copy's tracked branch are read from the Work's own
 * `WorkUpstreamState` row — the same row the sync run read a moment before. The move is refused
 * (`not_found`) unless the row is a private copy whose repository is EXACTLY the one named, so
 * this adapter can never push into a repository that is not the Work's own copy.
 *
 * The upstream branch the move fetches is the one the run's `compare` just counted (remembered
 * per Work for the life of the process, bounded), falling back to the row's upstream default
 * branch: `headSha` is a commit of that branch, and the plugin answers `not_fast_forward` when it
 * cannot find it there — never a push of a different commit.
 *
 * ## The size ceiling
 *
 * Both calls pass `APP_PRIVATE_COPY_MAX_SIZE_KB` (FR-45's 500 MB), the size the platform has
 * already authorised for a private copy; the plugin refuses either repository over it before any
 * git work. The sync run checks the upstream's size first and pauses (`too_large_for_private_copy`),
 * so this is the second belt for the copy itself.
 */

/** How many Works' last compared upstream branch are remembered (a worker runs a few at a time). */
const COMPARED_BRANCH_MEMORY = 256;

@Injectable()
export class AppUpstreamPrivateCopyAdapter implements AppUpstreamPrivateCopyPort {
    private readonly logger = new Logger(AppUpstreamPrivateCopyAdapter.name);
    private readonly comparedBranches = new Map<string, string>();

    constructor(
        private readonly git: GitFacadeService,
        @Optional() private readonly rows?: WorkUpstreamStateRepository,
        @Optional() private readonly works?: WorkRepository,
    ) {}

    /** §6.3 step 6 for a private copy — the merge-base counts, capped at 10 000 (FR-46, FR-63). */
    async compare(input: {
        workId: string;
        owner: string;
        repo: string;
        branch: string;
        upstreamOwner: string;
        upstreamRepo: string;
        upstreamBranch: string;
    }): Promise<AppUpstreamPrivateCopyComparison | null> {
        const userId = await this.ownerOf(input.workId);
        if (!userId) {
            // No owner, no credential: the sync run turns `null` into `failed/not_found`.
            return null;
        }

        const reading = await this.git.getRepositoryCopyDivergence(
            {
                sourceOwner: input.upstreamOwner,
                sourceRepo: input.upstreamRepo,
                sourceBranch: input.upstreamBranch,
                targetOwner: input.owner,
                targetRepo: input.repo,
                targetBranch: input.branch,
                maxCommits: GIT_REPOSITORY_COPY_DIVERGENCE_MAX_COMMITS,
                maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
            },
            { userId, providerId: APP_WORK_GIT_PROVIDER_ID, workId: input.workId },
        );

        this.rememberComparedBranch(input.workId, input.upstreamBranch);
        return {
            aheadBy: reading.aheadBy,
            behindBy: reading.behindBy,
            upstreamHeadSha: reading.upstreamHeadSha,
            capped: reading.capped === true,
        };
    }

    /** Point `ever-works/upstream-sync` at `headSha` — fast-forward only, never a force (FR-36, FR-63). */
    async moveSyncBranch(input: {
        workId: string;
        owner: string;
        repo: string;
        headSha: string;
    }): Promise<AppUpstreamSyncBranchMove> {
        const row = this.rows ? await this.rows.findByWorkId(input.workId) : null;
        if (
            !row ||
            row.relation !== 'private-copy' ||
            !row.upstreamOwner ||
            !row.upstreamRepo ||
            !sameRepository(row.dataOwner, row.dataRepo, input.owner, input.repo)
        ) {
            // Never a guessed upstream and never someone else's repository.
            throw new GitProviderRequestError('not_found', 404);
        }

        const userId = await this.ownerOf(input.workId);
        if (!userId) {
            throw new GitProviderRequestError('not_found', 404);
        }

        const sourceBranch =
            this.comparedBranches.get(input.workId) ??
            row.upstreamDefaultBranch ??
            row.dataDefaultBranch;

        const moved = await this.git.moveRepositoryCopyBranch(
            {
                sourceOwner: row.upstreamOwner,
                sourceRepo: row.upstreamRepo,
                sourceBranch,
                targetOwner: row.dataOwner,
                targetRepo: row.dataRepo,
                targetBaseBranch: row.dataDefaultBranch,
                branchName: APP_UPSTREAM_SYNC_BRANCH,
                headSha: input.headSha,
                maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
            },
            { userId, providerId: APP_WORK_GIT_PROVIDER_ID, workId: input.workId },
        );

        if (moved.outcome === 'not_fast_forward') {
            this.logger.warn(
                `App upstream sync: the private copy of work ${input.workId} could not fast-forward ${APP_UPSTREAM_SYNC_BRANCH} to ${input.headSha}; upstream history was rewritten.`,
            );
            return 'not_fast_forward';
        }
        return 'moved';
    }

    /** The Work owner — whose credential every call is made with. */
    private async ownerOf(workId: string): Promise<string | null> {
        if (!this.works || !workId) return null;
        const work = await this.works.findById(workId);
        return work?.userId ?? null;
    }

    private rememberComparedBranch(workId: string, branch: string): void {
        if (!workId || !branch) return;
        this.comparedBranches.delete(workId);
        this.comparedBranches.set(workId, branch);
        if (this.comparedBranches.size > COMPARED_BRANCH_MEMORY) {
            const oldest = this.comparedBranches.keys().next().value;
            if (oldest !== undefined) this.comparedBranches.delete(oldest);
        }
    }
}

/** GitHub owners and repository names compare case-insensitively. */
function sameRepository(
    ownerA: string | null | undefined,
    repoA: string | null | undefined,
    ownerB: string | null | undefined,
    repoB: string | null | undefined,
): boolean {
    if (!ownerA || !repoA || !ownerB || !repoB) return false;
    return (
        ownerA.toLowerCase() === ownerB.toLowerCase() && repoA.toLowerCase() === repoB.toLowerCase()
    );
}
