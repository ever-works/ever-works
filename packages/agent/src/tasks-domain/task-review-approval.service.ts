import { Injectable, Logger } from '@nestjs/common';
import { normalizeCommitSha } from '@ever-works/contracts';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { matchWorkByRepo } from '../works/work-repo-match';

/**
 * Merge approval (self-build slice AE, EW-805) — the missing half of the
 * provider review signal.
 *
 * `TaskReviewRejectionService` records `changes_requested` reviews as
 * durable feedback for the next run. Approvals had NO path into the
 * platform at all: `github-pr-review-bridge` handled every
 * `pull_request_review` delivery by looking for a rejection and returning,
 * and its own spec pinned that ("ignores an approval — only a rejection
 * carries feedback for the next run"). That was true of the *feedback
 * loop*, which is what the spec was about, and it left the platform
 * unable to answer "has a person looked at this pull request?" — a
 * question slice AE has to put in front of whoever is about to authorise
 * a merge.
 *
 * WHAT THIS IS NOT: an authorization. A provider login is not a platform
 * identity — this repo has no GitHub-login → user mapping on the review
 * path (`github_app_user_links` is consulted only for installation
 * ownership), so an approval here cannot establish that somebody entitled
 * to approve for the Task's Organization approved it. It is CONTEXT,
 * recorded against the commit it was given for and shown to the human who
 * makes the real decision in the Inbox.
 *
 * Bots are dropped, all of them. The classification happens in the bridge
 * (`classifyReviewer`, which checks the platform's own identity BEFORE the
 * trusted-bot allow-list); this service only ever sees `human`. An
 * allow-listed reviewer bot's approval is deliberately worth nothing here:
 * the loop must never treat its own reviewers as the people who signed off
 * on its work.
 *
 * Best-effort by contract, exactly like the rejection twin: the caller is
 * a webhook that must answer 200 quickly, and "this PR maps to no Task"
 * is an ordinary outcome.
 */
@Injectable()
export class TaskReviewApprovalService {
    private readonly logger = new Logger(TaskReviewApprovalService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly works: WorkRepository,
    ) {}

    /**
     * A HUMAN approved the agent's pull request on the git provider.
     *
     * `headSha` is the review's own `commit_id` — the commit the reviewer
     * actually looked at, not the branch head now. Storing the branch head
     * instead would silently launder an approval of an old diff into an
     * approval of whatever was pushed since.
     *
     * Returns true when a Task row was updated.
     */
    async recordPullRequestApproval(input: {
        userId: string;
        owner: string;
        repo: string;
        prNumber: number;
        /** `review.commit_id` — the commit the human reviewed. */
        headSha?: string | null;
        reviewerLabel?: string | null;
        approvedAt?: Date | null;
    }): Promise<boolean> {
        const headSha = normalizeCommitSha(input.headSha);
        if (!headSha) {
            // An approval we cannot attach to a commit is an approval of
            // nothing in particular. Dropped rather than stored against a
            // head we guessed.
            this.logger.debug(
                `PR approval for ${input.owner}/${input.repo}#${input.prNumber} carried no commit id; ignored.`,
            );
            return false;
        }
        try {
            const candidates = await this.works.findByUser(input.userId);
            const work = matchWorkByRepo(candidates ?? [], input.owner, input.repo);
            if (!work) return false;
            const task = await this.tasks.findByWorkAndPrNumber(work.id, input.prNumber);
            if (!task) return false;

            const updated = await this.tasks.recordPullRequestReviewApproval(
                task.id,
                input.prNumber,
                {
                    headSha,
                    approvedAt: input.approvedAt ?? new Date(),
                    approvedBy: (input.reviewerLabel ?? '').trim().slice(0, 128) || null,
                },
            );
            if (updated) {
                this.logger.log(
                    `Task ${task.id}: human review approval recorded for ${input.owner}/${input.repo}#${input.prNumber} at ${headSha.slice(0, 12)}.`,
                );
            }
            return updated;
        } catch (error) {
            this.logger.warn(
                `PR approval record failed for ${input.owner}/${input.repo}#${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    /**
     * The same human took their approval back — a dismissal, or a
     * `changes_requested` review replacing their own sign-off.
     *
     * This exists because the head-SHA binding does NOT cover it. That
     * binding answers "did the code change under the approval?"; a
     * reviewer changing their mind about the SAME commit leaves the head
     * exactly where it was, so without this the record stays and the
     * merge proposal keeps telling whoever is authorising it that a named
     * person reviewed this diff after that person explicitly said
     * otherwise. It is context rather than authorization, which is why
     * this is a clear and not a refusal — but it is the ONLY signal the
     * Inbox offers about whether a human read the pull request, so it has
     * to be true.
     *
     * Guarded on the recorded approver's login: only the person whose
     * attestation is on the row can retract it.
     *
     * Returns true when a Task row was cleared.
     */
    async clearPullRequestApproval(input: {
        userId: string;
        owner: string;
        repo: string;
        prNumber: number;
        /** Provider login of the reviewer withdrawing. */
        reviewerLabel?: string | null;
    }): Promise<boolean> {
        const reviewer = (input.reviewerLabel ?? '').trim();
        if (!reviewer) {
            // Unattributable: it cannot be matched to the stored approver,
            // and clearing every approval on a nameless delivery would let
            // one malformed webhook erase the record for good.
            return false;
        }
        try {
            const candidates = await this.works.findByUser(input.userId);
            const work = matchWorkByRepo(candidates ?? [], input.owner, input.repo);
            if (!work) return false;
            const task = await this.tasks.findByWorkAndPrNumber(work.id, input.prNumber);
            if (!task) return false;

            const cleared = await this.tasks.clearPullRequestReviewApproval(
                task.id,
                input.prNumber,
                reviewer,
            );
            if (cleared) {
                this.logger.log(
                    `Task ${task.id}: human review approval WITHDRAWN by ${reviewer} for ${input.owner}/${input.repo}#${input.prNumber}.`,
                );
            }
            return cleared;
        } catch (error) {
            this.logger.warn(
                `PR approval withdrawal failed for ${input.owner}/${input.repo}#${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }
}
