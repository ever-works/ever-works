import type { PrStructuredReview } from './pr-review.types';

/**
 * Hidden first line of every review comment the platform posts, so the
 * webhook bridge can recognise its own output and never answer it.
 *
 * The review is posted with the Work owner's GitHub USER token, so GitHub
 * reports its author as the owner (`type: 'User'`, `OWNER`): neither the
 * author nor the visible heading tells it apart from the owner's own
 * comments. Without this, every review that contained `@ever-works` (the
 * footer used to, and the text often quotes `@ever-works/*` packages)
 * started the next paid review: one a minute on #2774 (2026-10-18).
 *
 * 🛑 Never change the value: comments already on GitHub carry it.
 */
export const PR_REVIEW_COMMENT_MARKER = '<!-- ever-works-ai-review -->';

/** True when `text` is a review comment the platform itself posted. */
export function isPrReviewComment(text: string): boolean {
    return text.includes(PR_REVIEW_COMMENT_MARKER);
}

/**
 * The single summary comment the reviewer posts on a pull request (v1).
 *
 * A pure function in a file of its own, so the receiving side (the GitHub
 * webhook bridge in apps/api) can render exactly what the reviewer posts
 * without loading the reviewer's module graph.
 */
export function renderPrReviewComment(input: {
    review: PrStructuredReview;
    owner: string;
    repo: string;
    prNumber: number;
    work: { name: string } | null;
    instruction?: string;
}): string {
    const { review, owner, repo, prNumber, work } = input;
    const lines: string[] = [
        PR_REVIEW_COMMENT_MARKER,
        `### Ever Works AI review — \`${owner}/${repo}#${prNumber}\``,
        '',
        review.summary,
    ];
    if (review.comments.length > 0) {
        lines.push('', '**File notes:**');
        for (const comment of review.comments) {
            lines.push(`- \`${comment.path}\` — ${comment.comment}`);
        }
    }
    const footer: string[] = [];
    if (input.instruction) {
        // No `@ever-works` here: that handle is what asks for a review.
        footer.push('replying to a review request');
    }
    if (work) {
        footer.push(`Work: ${work.name}`);
    }
    if (footer.length > 0) {
        lines.push('', `<sub>${footer.join(' · ')}</sub>`);
    }
    return lines.join('\n');
}
