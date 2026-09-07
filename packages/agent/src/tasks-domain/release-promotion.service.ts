import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { GitPullRequest, GitPullRequestStatus } from '@ever-works/plugin';
import {
    PROMOTION_GATE_OVERRIDE_LABEL,
    PROMOTION_GATE_WORKFLOW_FILE,
    isPromotionGateDecided,
    isPromotionGateDecisionOverdue,
    isPromotionGateOverridden,
    isPromotionGatePass,
    isPromotionTask,
    normalizeCommitSha,
    promotionGateVerdictFromRun,
    promotionTaskLabels,
    resolvePromotionBranches,
    sanitizeReleaseLadder,
    type PromotionGateVerdict,
    type PromotionRung,
} from '@ever-works/contracts';
import { Task, TaskPriority, TaskStatus } from '../entities/task.entity';
import type { Work } from '../entities/work.entity';
import type { ReleasePromotion } from '../entities/release-promotion.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { ReleasePromotionRepository } from '../database/repositories/release-promotion.repository';
import { TaskChatMessageRepository } from '../database/repositories/task-side.repositories';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import type {
    PromotionMergeGuard,
    PromotionMergeSubject,
    PromotionMergeVerdict,
} from '../policy/promotion-merge-guard.port';
import { ReleaseVerificationService } from './release-verification.service';
import { TasksService } from './tasks.service';

/** Why a promotion could not be opened. All of them leave nothing behind. */
export type PromotionOpenRefusal =
    | 'no-git-provider'
    | 'work-not-found'
    | 'ladder-not-configured'
    | 'head-branch-missing'
    | 'base-branch-missing'
    | 'head-sha-unknown'
    | 'branches-not-as-claimed'
    | 'pull-request-failed'
    /**
     * The pull request is OPEN on the provider but the platform could not
     * record it (database write failed mid-open). The lane is freed and
     * the existing pull request is ADOPTED by the next attempt rather than
     * duplicated.
     */
    | 'promotion-not-recorded';

export type PromotionOpenResult =
    | { outcome: 'opened'; promotion: ReleasePromotion; task: Task }
    /** A promotion for this lane is already live. NOT an error. */
    | { outcome: 'already-open'; promotion: ReleasePromotion }
    | { outcome: 'refused'; code: PromotionOpenRefusal; reason: string };

export interface OpenPromotionInput {
    /** Owner. Everything else is resolved from platform state. */
    userId: string;
    workId: string;
    /** WHICH rung — the only thing the caller chooses. */
    rung: PromotionRung;
    /**
     * Agent the promotion Task is attributed to. Validated as owned by
     * `userId` by `TasksService.create`, which is the same ownership rule
     * `AgentApprovalsService.createProposal` enforces — so the Inbox
     * approval this Task will later raise is decidable by its owner.
     */
    agentId: string;
}

/** What one refresh did, for the sweep summary and for tests. */
export type PromotionRefreshOutcome =
    | { action: 'not-a-promotion' }
    | { action: 'closed'; state: 'merged' | 'closed' }
    | { action: 'refused'; code: string }
    | { action: 'observed'; verdict: PromotionGateVerdict; headSha: string };

/**
 * What the ONE Inbox notice per (commit, reading) is keyed by.
 *
 * Every undecided reading collapses to `'stuck'` so a `pending →
 * unreadable → pending` flap is one notice rather than three, while every
 * decided verdict keeps its own identity and therefore gets its own
 * notice. Keyed on the commit alone — as it was — the first post-grace
 * `pending` consumed the slot and the FAILURE that followed was never
 * filed.
 */
function noticeToken(verdict: PromotionGateVerdict, overridden: boolean): string {
    if (!isPromotionGateDecided(verdict)) return 'stuck';
    // A pass that was WAIVED is a different thing to tell a human than a
    // pass that was green, so it gets its own slot: a red gate that is
    // then overridden into `success` must file a second notice, not be
    // swallowed as "we already told them about `success` for this commit".
    // Fits `varchar(16)`.
    return overridden ? `${verdict}-waived` : verdict;
}

/**
 * Is this reading worth telling the human about?
 *
 * A decided verdict always is. `pending` / `absent` / `unreadable` are
 * only worth reporting once they have STAYED that way past the grace
 * window: a workflow run does not exist the instant a pull request opens,
 * and filing "the gate never ran" ten seconds in would be both noisy and
 * wrong. The window itself is `isPromotionGateDecisionOverdue`, in
 * contracts beside the constant, so the value has one meaning and one
 * test — including its fail-closed behaviour on an unusable clock.
 */
function shouldFileNotice(
    promotion: ReleasePromotion,
    verdict: PromotionGateVerdict,
    now: Date,
): boolean {
    if (isPromotionGateDecided(verdict)) return true;
    return isPromotionGateDecisionOverdue(promotion.headRecordedAt ?? null, now);
}

/**
 * What a green gate on THIS rung actually gated on.
 *
 * `promotion-gate.yml` has two jobs and only one of them runs on both
 * rungs: `e2e-result` carries `if: …head.ref == 'stage'`, so on a
 * `develop -> stage` promotion it never runs and the workflow concludes
 * `success` off `node-contract` alone. That is by design — `e2e.yml` runs
 * on push to `develop`, so there is no end-to-end result for a
 * `develop -> stage` head to consult — but "PASSED" then means something
 * materially narrower than it does on the second rung, and the person
 * deciding sees the Inbox item, not the runbook.
 */
function gateScopeNote(rung: PromotionRung): string {
    return rung === 'stage-to-main'
        ? 'Legs evaluated on this rung: the node wire contract AND stage’s own end-to-end result.'
        : 'Legs evaluated on this rung: the node wire contract ONLY. The end-to-end leg does not run on a ' +
              'pull request into `stage` (e2e.yml runs on push to `develop`), so NO end-to-end result was ' +
              'consulted here. The first one for this batch appears on `stage` and is what the next rung gates on.';
}

/** The sentence an overridden E2E leg has to put in front of a human. */
function overrideNote(): string {
    return (
        `WAIVED, NOT GREEN: the \`${PROMOTION_GATE_OVERRIDE_LABEL}\` label is on this pull request, so ` +
        'the gate’s end-to-end leg exited 0 despite being red, unreadable or unfinished. Somebody with ' +
        'repository write decided the failing specs were unrelated. The run conclusion cannot tell you ' +
        'that on its own — this line is the only place it is said.'
    );
}

/**
 * Release promotion lane (self-build slice AI, EW-808) — `develop → stage
 * → main`, made POSSIBLE and LEGIBLE, and deliberately not automatic.
 *
 * ## What a promotion Task does
 *
 *   1. Opens ONE pull request, from the branch the Work's ladder says to
 *      the branch the Work's ladder says. Nothing about which branches is
 *      taken from the caller.
 *   2. Waits on `promotion-gate.yml` for the pull request's head commit
 *      and records what it said, stamped with the commit it was about.
 *   3. Reports each of those into the Task, and files ONE Inbox item so a
 *      human can see the gate result.
 *
 * ## What it will NEVER do on its own
 *
 *   - **Merge.** This service contains no merge call. A promotion pull
 *     request is landed by the SAME machinery as every other agent merge:
 *     `TaskMergeGateService` raises a `merge_pull_request` Inbox approval
 *     (slice AE), a human with a real platform identity decides it, and
 *     `GitFacadeService.mergePullRequest` re-verifies the approval against
 *     the live head before the provider is touched. This service's only
 *     contribution to that path is {@link assessPromotionForMerge}, which
 *     can only say NO.
 *   - **Cascade.** Nothing here opens `stage → main` when `develop →
 *     stage` merges. {@link onPullRequestStatusRefreshed} frees the lane
 *     and stops. The second promotion is a separate, separately-approved
 *     human act — because the stage e2e gate has been unreliable for weeks
 *     and a bad promotion is a multi-hour outage on a build lane measured
 *     at 215–243 minutes. `PROMOTION_RUNGS` has no successor function for
 *     the same reason.
 *
 * ## Why the gate is read here and not by the merge gate
 *
 * Because a promotion has to be legible even when it can never merge. The
 * refresh runs on EVERY PR-status sweep, whatever CI says, so an operator
 * watching a red promotion sees the gate's actual verdict instead of
 * silence. {@link assessPromotionForMerge} is then a pure read of what
 * this recorded moments earlier, on the same live head.
 *
 * BEST-EFFORT BY CONTRACT, like the merge gate beside it: the caller is a
 * status refresh whose job is to keep a cache honest, and a promotion
 * refresh that threw would turn a provider hiccup into a failed sweep for
 * every Task behind it.
 */
@Injectable()
export class ReleasePromotionService implements PromotionMergeGuard {
    private readonly logger = new Logger(ReleasePromotionService.name);

    constructor(
        private readonly works: WorkRepository,
        private readonly tasks: TaskRepository,
        private readonly promotions: ReleasePromotionRepository,
        private readonly tasksService: TasksService,
        private readonly chat: TaskChatMessageRepository,
        // Everything below is @Optional() and APPENDED LAST per the
        // positional-spec arity rule. Any future dependency goes after
        // these, also @Optional(), and the spec helpers get the same
        // treatment — this convention has bitten five times.
        @Optional() private readonly gitFacade?: GitFacadeService,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
        // Post-deploy verification (slice AJ, EW-809). APPENDED LAST and
        // @Optional() per the positional-arity rule — every spec that
        // builds this service with seven arguments keeps compiling, and a
        // deployment without it behaves byte-for-byte as it did before:
        // the promotion still merges and the lane still closes, nothing
        // checks the deployment, and nothing pretends it did.
        @Optional() private readonly verification?: ReleaseVerificationService,
    ) {}

    // ── Opening a promotion ───────────────────────────────────────────

    /**
     * Open one rung's pull request and file the Task that reports it.
     *
     * Ordering is load-bearing: the lane is CLAIMED before anything is
     * created, so a race loses in the database rather than on the
     * provider. A caller that loses gets `already-open` and the winner's
     * row — never a second pull request.
     */
    async openPromotion(input: OpenPromotionInput): Promise<PromotionOpenResult> {
        if (!this.gitFacade) {
            return {
                outcome: 'refused',
                code: 'no-git-provider',
                reason: 'No git provider is wired in this deployment.',
            };
        }

        const work = await this.works.findById(input.workId);
        if (!work || work.userId !== input.userId) {
            // Same wording for "does not exist" and "is not yours": the
            // difference would tell a caller which Works exist.
            return {
                outcome: 'refused',
                code: 'work-not-found',
                reason: `Work ${input.workId} not found.`,
            };
        }

        // THE branch resolution. Platform state only — a caller that could
        // name its own branches could open `their-branch -> main` and call
        // it a release.
        const ladder = sanitizeReleaseLadder(work.releaseLadder);
        const branches = resolvePromotionBranches(ladder, input.rung);
        if (!branches) {
            return {
                outcome: 'refused',
                code: 'ladder-not-configured',
                reason:
                    `Work ${work.slug ?? work.id} has no usable release ladder. ` +
                    'Set integration / staging / production branches on the Work before promoting.',
            };
        }

        const target = this.resolveRepo(work, input.userId);

        // Read the tip of the branch being promoted BEFORE anything is
        // created, so the promotion has a commit to name from the start
        // and so a missing branch refuses before a Task exists.
        let branchHeads: Map<string, string>;
        try {
            const listed = await this.gitFacade.listBranches(
                target.owner,
                target.repo,
                target.gitOptions,
            );
            branchHeads = new Map(listed.map((branch) => [branch.name, branch.commit]));
        } catch (error) {
            return {
                outcome: 'refused',
                code: 'head-sha-unknown',
                reason: `Could not read branches for ${target.owner}/${target.repo}: ${describe(error)}`,
            };
        }

        if (!branchHeads.has(branches.head)) {
            return {
                outcome: 'refused',
                code: 'head-branch-missing',
                reason: `Branch ${branches.head} does not exist in ${target.owner}/${target.repo}.`,
            };
        }
        if (!branchHeads.has(branches.base)) {
            return {
                outcome: 'refused',
                code: 'base-branch-missing',
                reason: `Branch ${branches.base} does not exist in ${target.owner}/${target.repo}.`,
            };
        }

        const headSha = normalizeCommitSha(branchHeads.get(branches.head));
        if (!headSha) {
            return {
                outcome: 'refused',
                code: 'head-sha-unknown',
                reason: `Could not resolve the head commit of ${branches.head}.`,
            };
        }

        // Claim the lane. From here on exactly one caller proceeds.
        const claim = await this.promotions.claimLane({
            userId: input.userId,
            workId: work.id,
            rung: input.rung,
            headBranch: branches.head,
            baseBranch: branches.base,
            gateWorkflow: PROMOTION_GATE_WORKFLOW_FILE,
            tenantId: work.tenantId ?? null,
            organizationId: work.organizationId ?? null,
        });
        if (!claim.claimed) {
            return { outcome: 'already-open', promotion: claim.promotion };
        }
        const promotion = claim.promotion;

        // Filed IN_REVIEW, not TODO. A promotion Task has an open pull
        // request from the moment it exists, so `in_review` is where it
        // belongs on the board — and it keeps the Task out of
        // `TaskGraphFanoutService`, which starts unblocked TODO Tasks and
        // would otherwise dispatch an agent run against a Task whose whole
        // job is to sit and wait for a human.
        let task: Task;
        try {
            task = await this.tasksService.create(input.userId, {
                title: `Release: promote ${branches.head} → ${branches.base}`,
                description: promotionTaskDescription(work, branches.head, branches.base),
                status: TaskStatus.IN_REVIEW,
                priority: TaskPriority.P1,
                labels: promotionTaskLabels(input.rung),
                workId: work.id,
                agentId: input.agentId,
                createdByType: 'user',
                createdById: input.userId,
            });
            await this.promotions.attachTask(promotion.id, task.id);
        } catch (error) {
            // Either write failing leaves the lane HELD by a row nothing
            // can ever free — no pull request means the PR-status sweep
            // never looks at it — so the lane is released here rather than
            // left to the abandon window.
            await this.promotions.closeLane(promotion.id, 'refused', 'task-create-failed');
            return {
                outcome: 'refused',
                code: 'pull-request-failed',
                reason: `Could not file the promotion Task: ${describe(error)}`,
            };
        }
        promotion.taskId = task.id;

        // ADOPT before opening. The founder performs this promotion by hand
        // today, so an open `head -> base` pull request is the NORMAL state
        // of the world on the day this lane is first used — and the provider
        // answers a second request for the same pair with a 422, which used
        // to leave the Task filed above stranded in `in_review` with the
        // promotion labels and no pull request at all, once per retry. Same
        // call `openPullRequestForBranch` already makes for Task branches.
        let pr: GitPullRequest | null = await this.findOpenPullRequest(
            target,
            branches.head,
            branches.base,
        );
        const adopted = pr !== null;
        if (!pr) {
            try {
                pr = await this.gitFacade.createPullRequest(
                    {
                        owner: target.owner,
                        repo: target.repo,
                        title: `release: ${branches.head} -> ${branches.base}`,
                        head: branches.head,
                        base: branches.base,
                        body: promotionPullRequestBody(task, branches.head, branches.base),
                    },
                    target.gitOptions,
                );
            } catch (error) {
                await this.abandon(
                    promotion.id,
                    task,
                    input.agentId,
                    'pull-request-failed',
                    `Promotion refused — could not open the pull request: ${describe(error)}`,
                );
                return {
                    outcome: 'refused',
                    code: 'pull-request-failed',
                    reason: `Could not open ${branches.head} → ${branches.base}: ${describe(error)}`,
                };
            }
        }

        // PROMOTING THE WRONG THING. The provider is the authority on what
        // it just created — or on what it already had open; if the pull
        // request is not between the branches we asked for, the promotion
        // is abandoned rather than adopted. Nothing merges it, because a
        // refused promotion's guard says no.
        if (!refMatches(pr.head, branches.head) || !refMatches(pr.base, branches.base)) {
            await this.abandon(
                promotion.id,
                task,
                input.agentId,
                'branches-not-as-claimed',
                `Promotion refused — the provider opened ${pr.head} → ${pr.base}, not ` +
                    `${branches.head} → ${branches.base}. Pull request ${pr.url} is NOT managed by this promotion; ` +
                    'close it by hand.',
            );
            return {
                outcome: 'refused',
                code: 'branches-not-as-claimed',
                reason: `Provider opened ${pr.head} → ${pr.base}, expected ${branches.head} → ${branches.base}.`,
            };
        }

        // THE head this promotion reports, read back from the PULL REQUEST
        // rather than taken from the branch listing above.
        //
        // That listing is a branch's tip at the instant it was read, and
        // `createPullRequest` is a whole round trip later; two merges to
        // `develop` seconds apart — the exact interleaving this lane exists
        // to survive — put a newer commit on the branch in between.
        // Publishing the older one would name a commit that is not what
        // gets promoted, and would then spend a spurious "head moved"
        // report plus a fresh 20-minute grace window on the next sweep.
        // `GitPullRequest` carries no head SHA and the status read does,
        // which is the only reason this is a second call.
        const confirmed = await this.readPullRequestHead(target, pr.number);
        const reportedHead = confirmed ?? headSha;

        const now = new Date();
        try {
            await this.promotions.recordPullRequest(promotion.id, {
                prNumber: pr.number,
                prUrl: pr.url ?? null,
                headSha: reportedHead,
                headRecordedAt: now,
            });
            Object.assign(promotion, {
                prNumber: pr.number,
                prUrl: pr.url ?? null,
                headSha: reportedHead,
                headRecordedAt: now,
            });

            // Bind the pull request to the Task. This is what puts the
            // promotion into `findDuePrStatusSync`, and therefore into the
            // slice-AE merge path — the ONLY way it can ever be merged.
            //
            // `branchRef` is deliberately NOT written, and that is a safety
            // property rather than an omission. It is the slot the platform
            // treats as a DISPOSABLE task branch: `discardBranch`
            // (`DELETE /api/tasks/:id/branch`) and the nightly
            // `findBranchCleanupCandidates` sweep both call
            // `gitFacade.deleteBranch(owner, repo, task.branchRef)`, and
            // `runWorkspace` provisions an agent run onto it. Writing
            // `develop` or `stage` there would aim the branch reaper at the
            // integration branch and let an agent run push to it with no
            // pull request at all. A promotion owns no branch of its own —
            // it moves two that already exist — so the slot stays NULL,
            // which keeps the Task out of the cleanup query
            // (`branchRef IS NOT NULL`) while `findDuePrStatusSync`, which
            // selects on `prNumber`, still picks it up.
            await this.tasks.updateById(task.id, {
                prNumber: pr.number,
                prUrl: pr.url ?? null,
            });
            Object.assign(task, { prNumber: pr.number, prUrl: pr.url ?? null });
        } catch (error) {
            // A real pull request is open and the platform cannot watch it.
            // Free the lane so a human can retry — the retry ADOPTS this
            // pull request rather than opening a second one — and say so on
            // the Task before it is cancelled.
            await this.abandon(
                promotion.id,
                task,
                input.agentId,
                'promotion-not-recorded',
                `Promotion refused — pull request ${pr.url ?? `#${pr.number}`} is open but could not be ` +
                    `recorded: ${describe(error)}. Re-running the promotion adopts it rather than opening another.`,
            );
            return {
                outcome: 'refused',
                code: 'promotion-not-recorded',
                reason: `Opened ${branches.head} → ${branches.base} but could not record it: ${describe(error)}`,
            };
        }

        await this.report(
            task,
            input.agentId,
            (adopted
                ? `Promotion adopted the pull request already open for ${branches.head} → ${branches.base}`
                : `Promotion opened — ${branches.head} → ${branches.base}`) +
                ` at ${reportedHead.slice(0, 12)} (${pr.url ?? `#${pr.number}`}).\n` +
                (confirmed
                    ? ''
                    : 'The pull request head could not be read back, so that is the branch tip as it was ' +
                      'when the promotion started; the next status refresh corrects it.\n') +
                `Waiting on ${PROMOTION_GATE_WORKFLOW_FILE}. This Task will NOT merge the pull request: ` +
                'landing it needs a human approval in the Inbox, the same as any other agent merge.',
        );

        return { outcome: 'opened', promotion, task };
    }

    /**
     * The pull request already open for `head -> base`, if there is one.
     *
     * A READ, never a create. The founder opens this promotion by hand
     * today, so an open `develop -> stage` is the normal state of the world
     * the first time this lane runs; asking the provider for a second one
     * answers 422 (`A pull request already exists for …`), and the lane
     * would otherwise leave a promotion-labelled Task with no pull request
     * behind it once per retry. Same move `openPullRequestForBranch`
     * already makes for Task branches.
     *
     * A failed listing answers `null`: "we could not tell" is not "there is
     * none", but the create path that follows fails loudly and is itself
     * handled, so this degrades to the pre-adoption behaviour rather than
     * to a wrong adoption.
     */
    private async findOpenPullRequest(
        target: { owner: string; repo: string; gitOptions: GitFacadeOptions },
        head: string,
        base: string,
    ): Promise<GitPullRequest | null> {
        if (!this.gitFacade) return null;
        try {
            const open = await this.gitFacade.listPullRequests(
                target.owner,
                target.repo,
                { state: 'open', perPage: 100 },
                target.gitOptions,
            );
            return (
                open.find(
                    (candidate) =>
                        refMatches(candidate.head, head) && refMatches(candidate.base, base),
                ) ?? null
            );
        } catch (error) {
            this.logger.warn(
                `Promotion: could not list open pull requests for ${target.owner}/${target.repo}: ${describe(error)}`,
            );
            return null;
        }
    }

    /**
     * The pull request's OWN head commit, straight from the provider.
     *
     * `null` on any failure — the caller falls back to the branch tip and
     * says in the Task that it did, rather than publishing a commit it
     * could not confirm without saying so.
     */
    private async readPullRequestHead(
        target: { owner: string; repo: string; gitOptions: GitFacadeOptions },
        prNumber: number,
    ): Promise<string | null> {
        if (!this.gitFacade) return null;
        try {
            const live = await this.gitFacade.getPullRequestStatus(
                target.owner,
                target.repo,
                prNumber,
                target.gitOptions,
            );
            return normalizeCommitSha(live?.headSha) ?? null;
        } catch (error) {
            this.logger.warn(
                `Promotion: could not read the head of ${target.owner}/${target.repo}#${prNumber}: ${describe(error)}`,
            );
            return null;
        }
    }

    /**
     * Give the lane back and leave nothing usable behind.
     *
     * Every failure after the Task exists goes through here, because two
     * things have to happen together and either alone is a mess. The lane
     * must be FREED, or the UNIQUE `(workId, rung, laneKey)` index refuses
     * every later promotion for that rung — there is no abandon endpoint
     * and the PR-status sweep never looks at a Task with no pull request,
     * so nothing else would ever free it. And the Task must not be left
     * sitting in `in_review` wearing the promotion labels with no pull
     * request behind it: the merge guard refuses such a Task, but a human
     * reading the board cannot tell it from a real promotion, and each
     * retry would add another.
     */
    private async abandon(
        promotionId: string,
        task: Task,
        agentId: string | null,
        code: string,
        narrative: string,
    ): Promise<void> {
        await this.promotions.closeLane(promotionId, 'refused', code);
        await this.report(task, agentId, narrative);
        try {
            await this.tasks.updateById(task.id, { status: TaskStatus.CANCELLED });
            Object.assign(task, { status: TaskStatus.CANCELLED });
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotionId}: could not cancel the orphaned Task ${task.id}: ${describe(error)}`,
            );
        }
    }

    // ── Watching a promotion ──────────────────────────────────────────

    /**
     * Called by `TaskPrStatusService` after every successful provider
     * read, BEFORE the merge gate, with the live status.
     *
     * Never throws: the caller's job is to keep a PR-status cache honest.
     */
    async onPullRequestStatusRefreshed(
        task: Task,
        status: GitPullRequestStatus,
    ): Promise<PromotionRefreshOutcome> {
        try {
            return await this.refresh(task, status);
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: promotion refresh failed (PR status still recorded): ${describe(error)}`,
            );
            return { action: 'not-a-promotion' };
        }
    }

    private async refresh(
        task: Task,
        status: GitPullRequestStatus,
    ): Promise<PromotionRefreshOutcome> {
        // THE identity, and it is the ROW — not the Task's labels.
        //
        // This used to bail on `!isPromotionTask(task.labels)` before the
        // row was ever looked up, which made a free-form field the gate's
        // on/off switch: `UpdateTaskDto.labels` is applied verbatim by
        // `TasksService.update`, so `PATCH /api/tasks/<promotion>` with
        // `{"labels":[]}` froze a live `develop -> stage` lane — it stopped
        // being refreshed, and the merge guard (which bailed on the same
        // check) stopped consulting the gate at all. `release_promotions`
        // is the authority and it is keyed by `taskId`, so it is asked
        // FIRST. Labels survive only where there is no row to ask: as the
        // fail-closed hint in {@link assessPromotionForMerge}.
        const promotion = await this.promotions.findOpenByTaskId(task.id);
        if (!promotion) return { action: 'not-a-promotion' };

        // PROMOTING THE WRONG THING, third time: is this status even about
        // the promotion's pull request?
        //
        // `status` is the provider read `TaskPrStatusService` did for
        // `task.prNumber`, and that is a MUTABLE binding — an agent run on
        // this Task opens its own pull request and overwrites it
        // (`task-workspace.service.ts` `recordRemotePush`). Everything
        // below stamps a head, a gate verdict and a merged/closed decision
        // from this object, so a rebound Task would have the promotion
        // recording `promotion-gate.yml`'s answer about somebody else's
        // pull request. The lane refuses instead: nothing merges through a
        // refused promotion, the lane is freed, and a human can open a new
        // one. A provider that does not echo the number is not punished for
        // it — the guard still compares numbers at merge time.
        if (
            typeof status.number === 'number' &&
            typeof promotion.prNumber === 'number' &&
            status.number !== promotion.prNumber
        ) {
            await this.promotions.closeLane(promotion.id, 'refused', 'pull-request-rebound');
            await this.report(
                task,
                task.agentId ?? null,
                `Promotion refused — this Task now reports pull request #${status.number}, not the ` +
                    `#${promotion.prNumber} the ${promotion.headBranch} → ${promotion.baseBranch} promotion ` +
                    'opened. Nothing will merge through this lane; open a new promotion if the release is ' +
                    'still wanted.',
            );
            return { action: 'refused', code: 'pull-request-rebound' };
        }

        // A landed or abandoned promotion frees its lane and STOPS. There
        // is deliberately nothing here that opens the next rung: `stage →
        // main` is a separate, separately-approved human act.
        if (status.state === 'merged' || status.state === 'closed') {
            await this.promotions.closeLane(
                promotion.id,
                status.state === 'merged' ? 'merged' : 'closed',
            );
            await this.report(
                task,
                task.agentId ?? null,
                status.state === 'merged'
                    ? `Promotion merged — ${promotion.headBranch} → ${promotion.baseBranch} has landed. ` +
                          'The next rung is a separate promotion and is not opened automatically.'
                    : `Promotion closed without merging — ${promotion.headBranch} → ${promotion.baseBranch}.`,
            );
            // THE ONLY MOMENT the platform learns a promotion landed, and
            // therefore the only place a post-deploy verification can start
            // (slice AJ, EW-809). `closeLane` above has already freed the
            // lane, so `findOpenByTaskId` will not match this row again and
            // this block runs exactly once per promotion — but the
            // verification claims itself with `WHERE verifyState IS NULL`
            // anyway, because "runs exactly once" is a property of the
            // current call graph and not a guarantee.
            //
            // A CLOSED promotion gets nothing: nothing was deployed, so
            // there is nothing to check. Only `merged`.
            //
            // Deliberately AFTER the close and the report, and deliberately
            // unable to throw: this method is best-effort by contract, and a
            // verification that failed to start must not cost the caller the
            // record that the promotion merged.
            if (status.state === 'merged' && this.verification) {
                // Wrapped HERE as well as inside the verification service.
                // The callee promises not to throw, but that promise is a
                // property of another file that other slices edit; the
                // guarantee this method owes its caller — that a merged
                // promotion is recorded as merged — must not depend on it.
                try {
                    await this.verification.onPromotionMerged(promotion, task);
                } catch (error) {
                    this.logger.warn(
                        `Promotion ${promotion.id}: post-deploy verification did not start ` +
                            `(the merge is still recorded): ${describe(error)}`,
                    );
                }
            }
            return { action: 'closed', state: status.state === 'merged' ? 'merged' : 'closed' };
        }

        const work = await this.works.findById(promotion.workId);
        if (!work) {
            return { action: 'observed', verdict: 'unreadable', headSha: promotion.headSha ?? '' };
        }
        const target = this.resolveRepo(work, promotion.userId);

        // PROMOTING THE WRONG THING, from the other side: re-assert on
        // every refresh that the pull request is still between the branches
        // this promotion claims. The rolled-up status does not carry the
        // refs, so the pull request itself is read — the PROMOTION's, never
        // the Task's current one, so the branches that get checked and the
        // head that gets recorded are the same pull request's.
        const prNumber = promotion.prNumber ?? null;
        if (!prNumber) {
            return { action: 'observed', verdict: 'unreadable', headSha: promotion.headSha ?? '' };
        }
        let live;
        try {
            live = this.gitFacade
                ? await this.gitFacade.getPullRequest(
                      target.owner,
                      target.repo,
                      prNumber,
                      target.gitOptions,
                  )
                : null;
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: pull-request read failed: ${describe(error)}`,
            );
            live = null;
        }
        if (!live) {
            // Cannot confirm the branches. Fail closed: record the gate as
            // unreadable for the live head so the guard refuses, and say so.
            const unknownHead = normalizeCommitSha(status.headSha) ?? promotion.headSha ?? '';
            await this.observe(task, promotion, unknownHead, 'unreadable', null, false);
            return { action: 'observed', verdict: 'unreadable', headSha: unknownHead };
        }
        if (
            !refMatches(live.head, promotion.headBranch) ||
            !refMatches(live.base, promotion.baseBranch)
        ) {
            await this.promotions.closeLane(promotion.id, 'refused', 'branches-moved');
            await this.report(
                task,
                task.agentId ?? null,
                `Promotion refused — pull request #${prNumber} is now ${live.head} → ${live.base}, ` +
                    `not the ${promotion.headBranch} → ${promotion.baseBranch} it was opened as. ` +
                    'Nothing will merge it through this lane.',
            );
            return { action: 'refused', code: 'branches-moved' };
        }

        const headSha = normalizeCommitSha(status.headSha);
        if (!headSha) {
            await this.observe(task, promotion, promotion.headSha ?? '', 'unreadable', null, false);
            return { action: 'observed', verdict: 'unreadable', headSha: promotion.headSha ?? '' };
        }

        if (promotion.headSha !== headSha) {
            // The branch advanced under the promotion. Adopt the new head
            // and DROP the old verdict — a verdict is about a commit. Any
            // human approval dies with it for free: the slice-AE subject
            // key contains the head SHA.
            const movedAt = new Date();
            await this.promotions.recordHeadMoved(promotion.id, headSha, movedAt);
            Object.assign(promotion, {
                headSha,
                headRecordedAt: movedAt,
                gateVerdict: null,
                gateVerdictSha: null,
                gateRunUrl: null,
                // The waiver went with the verdict: a label applied to the
                // old commit's run says nothing about this one. Mirrors
                // what `recordHeadMoved` wrote.
                gateOverridden: false,
            });
            await this.report(
                task,
                task.agentId ?? null,
                `Promotion head moved to ${headSha.slice(0, 12)} — the previous gate verdict and any ` +
                    'approval for the old commit no longer apply.',
            );
        }

        const reading = await this.readGate(promotion, target, headSha, prNumber);

        // Was the gate's E2E leg WAIVED rather than green? Read off the
        // pull request we just re-verified, because the run cannot say:
        // `promotion-gate.yml` exits 0 on the `override-e2e-gate` label in
        // all four of its failure branches, and GitHub folds that back into
        // a plain `success` conclusion. Without this the person deciding a
        // production release is told "the gate passed" when what happened
        // is that somebody with repository write applied a label.
        //
        // It does NOT change the verdict — the override is a deliberate,
        // documented escape hatch and refusing it would only get the lane
        // routed around — it changes what the human is told.
        const overridden = isPromotionGateOverridden(live.labels);

        await this.observe(task, promotion, headSha, reading.verdict, reading.url, overridden);
        return { action: 'observed', verdict: reading.verdict, headSha };
    }

    /**
     * Read the gate for one commit.
     *
     * A THROW is `unreadable`, not `absent`: a token without `actions:read`
     * and a workflow that never ran are different problems and send the
     * operator to different places. A missing capability is `unreadable`
     * for the same reason.
     *
     * A run that names pull requests NOT including this promotion's is
     * `absent`. A workflow run is keyed by COMMIT, and one commit can head
     * more than one pull request — `stage` can be the head of both a
     * `stage -> main` promotion and somebody's comparison branch — so a run
     * adopted off the commit alone need not be this promotion's, and the
     * two differ in exactly the way that matters: the override label is
     * per pull request. A provider that does not report the association
     * (`undefined`) is taken at its word, because inventing a mismatch
     * would make every gate unreadable on such a provider.
     */
    private async readGate(
        promotion: ReleasePromotion,
        target: { owner: string; repo: string; gitOptions: GitFacadeOptions },
        headSha: string,
        prNumber: number,
    ): Promise<{ verdict: PromotionGateVerdict; url: string | null }> {
        if (!this.gitFacade) return { verdict: 'unreadable', url: null };
        try {
            const run = await this.gitFacade.getWorkflowRunForCommit(
                target.owner,
                target.repo,
                promotion.gateWorkflow || PROMOTION_GATE_WORKFLOW_FILE,
                headSha,
                target.gitOptions,
            );
            if (run && Array.isArray(run.pullRequestNumbers) && run.pullRequestNumbers.length > 0) {
                if (!run.pullRequestNumbers.includes(prNumber)) {
                    this.logger.log(
                        `Promotion ${promotion.id}: ${promotion.gateWorkflow} run ${run.id} for ${headSha} ` +
                            `is for pull request(s) ${run.pullRequestNumbers.join(', ')}, not #${prNumber}.`,
                    );
                    return { verdict: 'absent', url: null };
                }
            }
            return { verdict: promotionGateVerdictFromRun(run), url: run?.url ?? null };
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: ${promotion.gateWorkflow} lookup failed for ${headSha}: ${describe(error)}`,
            );
            return { verdict: 'unreadable', url: null };
        }
    }

    /** Record a verdict, report a CHANGE into the Task, file the one Inbox item. */
    private async observe(
        task: Task,
        promotion: ReleasePromotion,
        headSha: string,
        verdict: PromotionGateVerdict,
        url: string | null,
        overridden: boolean,
    ): Promise<void> {
        const checkedAt = new Date();
        // `changed` comes from the DATABASE's own answer, not from a
        // read-then-write on the in-memory row. The two-minute cron sweep
        // and an on-demand `?refresh=true` run in different processes; two
        // callers holding the same stale row would both compute "this is
        // new" and both narrate it, and the Task thread is this promotion's
        // audit trail.
        const { changed } = await this.promotions.recordGateVerdict(promotion.id, {
            gateVerdict: verdict,
            gateVerdictSha: headSha,
            gateCheckedAt: checkedAt,
            gateRunUrl: url,
            gateOverridden: overridden,
        });
        Object.assign(promotion, {
            gateVerdict: verdict,
            gateVerdictSha: headSha,
            gateCheckedAt: checkedAt,
            gateRunUrl: url,
            gateOverridden: overridden,
        });

        if (changed) {
            // Only on a change: the sweep runs every two minutes, and a
            // `pending` gate re-reported 300 times is not a report.
            await this.report(
                task,
                task.agentId ?? null,
                gateNarrative(promotion, verdict, headSha, url, overridden),
            );
        }

        if (!shouldFileNotice(promotion, verdict, checkedAt)) return;
        // Exactly once per (head commit, reading), claimed with a
        // compare-and-set so the cron worker and an on-demand refresh
        // cannot both file it.
        const token = noticeToken(verdict, overridden);
        if (!(await this.promotions.claimInboxNotice(promotion.id, headSha, token))) return;
        Object.assign(promotion, { inboxFiledForSha: headSha, inboxFiledVerdict: token });
        await this.fileNotice(task, promotion, verdict, headSha, url, overridden);
    }

    private async fileNotice(
        task: Task,
        promotion: ReleasePromotion,
        verdict: PromotionGateVerdict,
        headSha: string,
        url: string | null,
        overridden: boolean,
    ): Promise<void> {
        if (!this.inbox) return;
        const lane = `${promotion.headBranch} → ${promotion.baseBranch}`;
        const at = `(@ ${headSha.slice(0, 12)})`;
        // A pass that was WAIVED is not reported as a plain pass. This is
        // the one artefact the founder reads before deciding, and the run
        // conclusion cannot carry the difference.
        const title = !isPromotionGatePass(verdict)
            ? `Promotion gate ${verdict.toUpperCase()} for ${lane} ${at}`
            : overridden
              ? `Promotion gate PASSED — E2E WAIVED, not green — for ${lane} ${at}`
              : `Promotion gate PASSED for ${lane} ${at}`;
        const next = isPromotionGatePass(verdict)
            ? 'A separate "Merge pull request" approval will appear in this Inbox on the next status refresh. ' +
              'Nothing merges until you approve it.'
            : 'This promotion will NOT be offered for merge while the gate says anything other than success. ' +
              'Read the run, fix or re-run it, or close the promotion.';
        try {
            await this.inbox.notice(promotion.userId, {
                title: title.slice(0, 300),
                body: [
                    `${lane} — pull request ${promotion.prUrl ?? `#${promotion.prNumber ?? '?'}`}.`,
                    `${promotion.gateWorkflow} for ${headSha}: ${verdict}.`,
                    // WHAT was actually evaluated on this rung, and whether
                    // any of it was waived. Both belong in front of the
                    // person deciding, because "PASSED" alone means
                    // different things on the two rungs and can mean a
                    // label rather than a green run.
                    gateScopeNote(promotion.rung),
                    ...(overridden ? [overrideNote()] : []),
                    url ? `Gate run: ${url}` : 'No gate run to link.',
                    next,
                ]
                    .join('\n')
                    .slice(0, 8000),
                taskId: task.id,
                workId: promotion.workId,
                agentId: task.agentId ?? null,
                organizationId: promotion.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(`Promotion ${promotion.id}: inbox notice failed: ${describe(error)}`);
        }
    }

    // ── The extra refusal (PromotionMergeGuard) ───────────────────────

    /**
     * The ONLY thing this service contributes to the merge path, and it
     * can only ever say NO.
     *
     * A pure read of what {@link onPullRequestStatusRefreshed} recorded
     * moments earlier in the same sweep, on the same live head. It does
     * not re-read the provider: the read that matters already happened,
     * and doing it twice would let the two answers disagree.
     */
    async assessPromotionForMerge(subject: PromotionMergeSubject): Promise<PromotionMergeVerdict> {
        // THE ROW FIRST, and the labels only where there is no row.
        //
        // This used to short-circuit on `isPromotionTask(subject.labels)`
        // one line ABOVE the lookup, which made a free-form, owner-writable
        // field (`PATCH /api/tasks/:id` → `TasksService.update` applies
        // `input.labels` verbatim) the gate's on/off switch: clearing the
        // labels on a live `develop -> stage` pull request returned
        // `{ promotion: false }`, and the release then dropped into the
        // ordinary agent-merge path with the promotion gate never consulted
        // — under a policy with `requireHumanApproval: false`, an entirely
        // ungated merge into `stage` or `main`. The authority is
        // `release_promotions`, keyed by `taskId`, and it is asked first.
        const promotion = await this.promotions.findByTaskId(subject.taskId);
        if (!promotion) {
            // No row. The labels are the FAIL-CLOSED half and nothing more:
            // a Task that claims to be a promotion with nothing backing it
            // is refused, and a Task that claims nothing is left to the
            // ordinary path exactly as before this slice existed.
            return isPromotionTask(subject.labels)
                ? {
                      promotion: true,
                      allowed: false,
                      code: 'promotion-row-missing',
                      reason: 'This Task is labelled a promotion but no promotion record resolves for it.',
                  }
                : { promotion: false };
        }
        if (promotion.state !== 'open') {
            return {
                promotion: true,
                allowed: false,
                promotionId: promotion.id,
                code: 'promotion-not-open',
                reason: `The promotion is ${promotion.state}.`,
            };
        }

        // Is the pull request about to be merged the one this promotion
        // opened? `tasks.prNumber` is mutable — an agent run on the
        // promotion Task overwrites it with its own pull request — and a
        // verdict recorded for one pull request must never authorise the
        // merge of another.
        if (typeof promotion.prNumber !== 'number' || promotion.prNumber !== subject.prNumber) {
            return {
                promotion: true,
                allowed: false,
                promotionId: promotion.id,
                code: 'promotion-pull-request-mismatch',
                reason:
                    `This promotion is for pull request ` +
                    `${promotion.prNumber === null || promotion.prNumber === undefined ? '(none recorded)' : `#${promotion.prNumber}`}` +
                    `, not #${subject.prNumber}.`,
            };
        }

        const headSha = normalizeCommitSha(subject.headSha);
        if (!headSha || promotion.gateVerdictSha !== headSha) {
            return {
                promotion: true,
                allowed: false,
                promotionId: promotion.id,
                code: 'promotion-gate-stale',
                reason:
                    `${promotion.gateWorkflow} has no verdict for ${subject.headSha}` +
                    (promotion.gateVerdictSha
                        ? ` (the recorded one is for ${promotion.gateVerdictSha})`
                        : '') +
                    '.',
            };
        }
        if (!isPromotionGatePass(promotion.gateVerdict)) {
            return {
                promotion: true,
                allowed: false,
                promotionId: promotion.id,
                code: 'promotion-gate-not-success',
                reason: `${promotion.gateWorkflow} for ${headSha}: ${promotion.gateVerdict ?? 'not read'}.`,
            };
        }
        // The promotion's OWN coordinates travel with the allowance. The
        // merge path's default answer to "what is this pull request's
        // base?" is the Work's `taskIsolationBaseBranch` — right for every
        // Task pull request, wrong for every promotion — and it is what
        // both the protected-branch rule and the human's Inbox line are
        // computed from.
        return {
            promotion: true,
            allowed: true,
            promotionId: promotion.id,
            headBranch: promotion.headBranch,
            baseBranch: promotion.baseBranch,
            prNumber: promotion.prNumber,
        };
    }

    // ── Reads for the operator surface ────────────────────────────────

    async listForWork(workId: string, userId: string, limit?: number): Promise<ReleasePromotion[]> {
        return this.promotions.listForWork(workId, userId, limit);
    }

    // ── Internals ─────────────────────────────────────────────────────

    /**
     * Owner, repository and credentials — ALL from the Work, never from a
     * caller. Same resolution `TaskPrStatusService` uses, so a promotion
     * pull request and a Task pull request cannot end up on different
     * repositories for the same Work.
     */
    private resolveRepo(
        work: Work,
        userId: string,
    ): { owner: string; repo: string; gitOptions: GitFacadeOptions } {
        return {
            owner: work.getRepoOwner(),
            repo: work.getDataRepo(),
            gitOptions: { userId, providerId: work.gitProvider, workId: work.id },
        };
    }

    /** One line of narrative on the Task's own thread. Best-effort. */
    private async report(task: Task, agentId: string | null, body: string): Promise<void> {
        if (!agentId) return;
        try {
            await this.chat.create({
                taskId: task.id,
                authorType: 'agent',
                authorId: agentId,
                body,
                tenantId: task.tenantId ?? null,
                organizationId: task.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(`Task ${task.id}: promotion report failed: ${describe(error)}`);
        }
    }
}

/** Do two refs name the same branch? Providers echo `owner:branch` heads. */
function refMatches(actual: string | null | undefined, expected: string): boolean {
    if (typeof actual !== 'string') return false;
    const trimmed = actual.trim();
    if (trimmed === expected) return true;
    // GitHub reports a cross-fork head as `owner:branch`. A promotion is
    // same-repository by construction, so a qualified head only matches
    // when the branch half does — and a fork head can never match, which
    // is the correct refusal.
    const colon = trimmed.indexOf(':');
    return colon > 0 && trimmed.slice(colon + 1) === expected;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function gateNarrative(
    promotion: ReleasePromotion,
    verdict: PromotionGateVerdict,
    headSha: string,
    url: string | null,
    overridden: boolean,
): string {
    const where = url ? ` (${url})` : '';
    const head = headSha ? headSha.slice(0, 12) : 'an unknown commit';
    switch (verdict) {
        case 'success':
            return (
                `${promotion.gateWorkflow} ${overridden ? 'PASSED WITH THE E2E LEG WAIVED' : 'PASSED'} ` +
                `for ${head}${where}.\n` +
                `${gateScopeNote(promotion.rung)}\n` +
                (overridden ? `${overrideNote()}\n` : '') +
                'A merge approval will be raised in the Inbox; nothing merges until a human approves it.'
            );
        case 'failure':
            return `${promotion.gateWorkflow} FAILED for ${head}${where}. This promotion will not be offered for merge.`;
        case 'pending':
            return `${promotion.gateWorkflow} is still running for ${head}${where}.`;
        case 'cancelled':
            return (
                `${promotion.gateWorkflow} was CANCELLED for ${head}${where}. ` +
                'A cancelled gate is the absence of a verdict, not a pass.'
            );
        case 'skipped':
            return (
                `${promotion.gateWorkflow} did not evaluate for ${head}${where} (skipped / neutral / stale). ` +
                'Branch protection renders this green; this lane does not.'
            );
        case 'absent':
            return (
                `${promotion.gateWorkflow} has no run for ${head}. ` +
                'A gate that never ran is not a pass.'
            );
        case 'unreadable':
        default:
            return (
                `${promotion.gateWorkflow} could not be read for ${head}. ` +
                'That is a broken gate, not a verdict, and it is not a pass.'
            );
    }
}

function promotionTaskDescription(work: Work, head: string, base: string): string {
    // Deliberately names NO commit. The description is written before the
    // pull request exists, and the branch tip read a round trip earlier is
    // not necessarily what the pull request ends up heading — two merges to
    // `develop` seconds apart is the case this lane is built for. The
    // confirmed head is reported into the Task thread instead, where it can
    // be re-stated when it moves.
    return [
        `Promote \`${head}\` → \`${base}\` in ${work.getRepoOwner()}/${work.getDataRepo()}.`,
        '',
        'This Task opens the pull request and reports what ' +
            `\`${PROMOTION_GATE_WORKFLOW_FILE}\` says about it. It does not merge it.`,
        'The commit being promoted is whatever the pull request heads; the Task thread records it,',
        'and a gate verdict is only ever valid for the commit it was read for.',
        '',
        'Landing the pull request needs a human approval in the Inbox, verified against the head commit',
        'at merge time — the same path as every other agent merge.',
        '',
        'The next rung is NOT opened automatically when this one lands.',
    ].join('\n');
}

function promotionPullRequestBody(task: Task, head: string, base: string): string {
    return [
        `Release promotion \`${head}\` → \`${base}\`.`,
        '',
        `Opened by Ever Works for Task ${task.slug ?? task.id}.`,
        '',
        `Gated on \`${PROMOTION_GATE_WORKFLOW_FILE}\`. The platform will not merge this pull request`,
        'without a recorded human approval for its exact head commit.',
    ].join('\n');
}
