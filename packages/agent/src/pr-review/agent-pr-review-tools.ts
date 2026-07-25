import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { PrReviewResult } from './pr-review.types';

/**
 * GitHub PR review loop (Wave 7, feature g) — chat tool, per the
 * program DoD rule that every new capability ships with chat tools +
 * keyword slots.
 *
 * Mirrors `ingest/agent-ingest-tools.ts`: a descriptor factory the tool
 * assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into
 * the pr-review subpath).
 *
 * Keyword slots: "review PR", "review pull request", "review this PR",
 * "check the pull request", "PR feedback" style asks route here; the
 * result carries the PR URL so answers link back to the origin.
 */

export interface ReviewPullRequestArgs {
    owner: string;
    repo: string;
    prNumber: number;
    /** Optional focus/instruction forwarded into the review prompt. */
    instruction?: string;
}

/** Minimal service surface the tool needs (structural for tests). */
export interface PrReviewToolService {
    reviewPullRequest(request: {
        userId: string;
        owner: string;
        repo: string;
        prNumber: number;
        instruction?: string;
    }): Promise<PrReviewResult>;
}

export function buildPrReviewTools(args: {
    /** Owner scope — reviews run as this user (facade auth + ingest owner). */
    userId: string;
    prReviewService: PrReviewToolService;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'review_pull_request',
        description:
            'Run an AI review of a pull request on one of the connected repositories: fetches the diff, grounds the review in the matching Work knowledge base and memory, and posts a summary review comment on the PR. Returns the review summary, per-file notes, and the PR URL.',
        parameters: {
            type: 'object',
            properties: {
                owner: { type: 'string', description: 'Repository owner login.' },
                repo: { type: 'string', description: 'Repository name.' },
                prNumber: { type: 'integer', description: 'Pull request number.' },
                instruction: {
                    type: 'string',
                    description:
                        'Optional review focus, e.g. "check the migration for rollback safety".',
                },
            },
            required: ['owner', 'repo', 'prNumber'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ReviewPullRequestArgs;
            const prNumber = Number(a.prNumber);
            if (!a.owner || !a.repo || !Number.isInteger(prNumber) || prNumber <= 0) {
                return { error: 'owner, repo and a positive integer prNumber are required' };
            }
            try {
                const result = await args.prReviewService.reviewPullRequest({
                    userId: args.userId,
                    owner: a.owner,
                    repo: a.repo,
                    prNumber,
                    ...(a.instruction ? { instruction: a.instruction } : {}),
                });
                return result;
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<ReviewPullRequestArgs, PrReviewResult>);

    return out;
}
