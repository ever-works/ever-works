'use server';

import { revalidatePath } from 'next/cache';
import {
    pullRequestsAPI,
    type PullRequestDiffView,
    type PullRequestReviewResult,
    type WorkRepoPullRequestsView,
} from '@/lib/api/pull-requests';
import {
    ingestedEventsAPI,
    type IngestedEventView,
    type ListIngestedEventsOptions,
} from '@/lib/api/ingested-events';
import type { ActionResult } from '@/app/actions/plugins';

/**
 * Wave 7 feature h + Wave 8 feature j — server actions behind the
 * in-platform PR review view and the per-Work external-activity feed.
 *
 * Every action is a thin wrapper over an endpoint that already exists;
 * nothing new is introduced on the API surface here. Errors are returned
 * as a discriminated union rather than thrown: a Server Action's thrown
 * message is REDACTED in production builds, so branching on
 * `err.message` client-side silently breaks on deploy (standing repo
 * gotcha — see the Server-Action prod-redaction note in the e2e docs).
 */

function toMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

/** Open PRs across every repo the Work declares. */
export async function listWorkPullRequestsAction(
    workId: string,
): Promise<ActionResult<{ repos: WorkRepoPullRequestsView[] }>> {
    try {
        const data = await pullRequestsAPI.list(workId);
        return { success: true, data };
    } catch (error) {
        console.error('[pull-requests] failed to list pull requests:', error);
        return { success: false, error: toMessage(error, 'Failed to load pull requests') };
    }
}

/** One PR's byte-capped diff plus the agent reviews recorded for it. */
export async function getWorkPullRequestDiffAction(args: {
    workId: string;
    owner: string;
    repo: string;
    prNumber: number;
}): Promise<ActionResult<PullRequestDiffView>> {
    try {
        const data = await pullRequestsAPI.getDiff(
            args.workId,
            args.owner,
            args.repo,
            args.prNumber,
        );
        return { success: true, data };
    } catch (error) {
        console.error('[pull-requests] failed to load the pull-request diff:', error);
        return { success: false, error: toMessage(error, 'Failed to load the diff') };
    }
}

/**
 * "Request agent review" — runs the SAME Work-aware reviewer the GitHub
 * webhook bridge does. Revalidates the PR route so the freshly recorded
 * review shows up on the next server render too.
 */
export async function requestWorkPullRequestReviewAction(args: {
    workId: string;
    owner: string;
    repo: string;
    prNumber: number;
}): Promise<ActionResult<PullRequestReviewResult>> {
    try {
        const data = await pullRequestsAPI.requestReview(
            args.workId,
            args.owner,
            args.repo,
            args.prNumber,
        );
        revalidatePath(`/works/${args.workId}/pull-requests`);
        return { success: true, data };
    } catch (error) {
        console.error('[pull-requests] failed to request an agent review:', error);
        return { success: false, error: toMessage(error, 'Failed to request the review') };
    }
}

/**
 * Feature j — ingested external events for one Work, optionally narrowed
 * to a single source. Owner scope is applied by the API, not here.
 */
export async function listWorkIngestedEventsAction(
    workId: string,
    opts: Omit<ListIngestedEventsOptions, 'workId'> = {},
): Promise<ActionResult<{ data: IngestedEventView[] }>> {
    try {
        const data = await ingestedEventsAPI.list({ ...opts, workId });
        return { success: true, data };
    } catch (error) {
        console.error('[pull-requests] failed to list ingested events:', error);
        return { success: false, error: toMessage(error, 'Failed to load external events') };
    }
}
