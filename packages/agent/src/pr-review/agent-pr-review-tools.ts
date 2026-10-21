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
        workId?: string;
    }): Promise<PrReviewResult>;
    /**
     * The requesting user's Work that owns `owner/repo` (THE
     * `matchWorkByRepo` rule, over the user's own Works only), or `null`.
     * `PrReviewService.matchWorkForRepo` — never throws.
     */
    matchWorkForRepo(userId: string, owner: string, repo: string): Promise<{ id: string } | null>;
}

/** The refusal the tool answers for a repository outside the user's Works. */
export function notAWorkRepositoryError(owner: string, repo: string): string {
    return `No Work in your account is connected to '${owner}/${repo}'. review_pull_request only reviews — and comments on — pull requests in repositories that belong to one of your Works.`;
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
            "Run an AI review of a pull request in a repository that belongs to one of the user's Works: fetches the diff, grounds the review in that Work's knowledge base and memory, and posts a summary review comment on the PR. Refuses any other repository (upstream projects included). Returns the review summary, per-file notes, and the PR URL.",
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
                // The review POSTS A COMMENT as the owner, on whatever pull
                // request the owner's token can reach — upstream projects
                // included, and "the platform never comments upstream". So the
                // model-chosen coordinates must name a repository of one of the
                // user's OWN Works (the same owner-scoped match the REST
                // endpoints enforce), checked before anything is fetched,
                // reviewed or posted.
                const work = await args.prReviewService.matchWorkForRepo(
                    args.userId,
                    a.owner,
                    a.repo,
                );
                if (!work) {
                    return { error: notAWorkRepositoryError(a.owner, a.repo) };
                }
                const result = await args.prReviewService.reviewPullRequest({
                    userId: args.userId,
                    owner: a.owner,
                    repo: a.repo,
                    prNumber,
                    ...(a.instruction ? { instruction: a.instruction } : {}),
                    workId: work.id,
                });
                return result;
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<ReviewPullRequestArgs, PrReviewResult>);

    return out;
}
