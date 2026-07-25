/**
 * GitHub PR review loop (Wave 7, features g+h) — shared value types.
 *
 * Zero runtime behavior beyond constants: the service
 * (`pr-review.service.ts`) owns the flow, the API-side webhook bridge
 * and the `review_pull_request` chat tool both speak these shapes.
 */

/** Hard byte cap on the assembled diff text spliced into the prompt. */
export const PR_REVIEW_DIFF_MAX_BYTES = 48_000;

/** Maximum per-file comments a structured review may carry (v1 contract). */
export const PR_REVIEW_MAX_COMMENTS = 12;

/** Cap on the mention-instruction text forwarded into the prompt. */
export const PR_REVIEW_INSTRUCTION_MAX_CHARS = 4_000;

/** Cap on the PR body excerpt included in the prompt. */
export const PR_REVIEW_PR_BODY_MAX_CHARS = 2_000;

/** One review request — from the webhook bridge, chat tool, or API. */
export interface PrReviewRequest {
    /** Platform user the review runs AS (facade auth + ingest owner). */
    userId: string;
    /** Repository owner login. */
    owner: string;
    /** Repository name. */
    repo: string;
    /** Pull request number. */
    prNumber: number;
    /**
     * Optional reviewer instruction — the mention loop passes the
     * `@ever-works` comment text here. UNTRUSTED external text: the
     * prompt marks it as data, and it is length-capped.
     */
    instruction?: string;
    /** Pre-resolved Work id (skips repo→Work matching when provided). */
    workId?: string;
    /** Git provider plugin id (default `github`). */
    providerId?: string;
}

/** One structured per-file review note. */
export interface PrReviewFileComment {
    path: string;
    comment: string;
}

/** Parsed structured review (post-cap). */
export interface PrStructuredReview {
    summary: string;
    comments: PrReviewFileComment[];
}

/** Outcome of a review run. */
export interface PrReviewResult {
    /**
     * - `posted`  — review generated AND the summary comment landed on
     *               the PR.
     * - `failed`  — the loop could not complete (PR missing, AI error,
     *               comment post rejected). `error` says why; partial
     *               fields (summary) are still populated when available.
     */
    status: 'posted' | 'failed';
    owner: string;
    repo: string;
    prNumber: number;
    /** Matched Work id, when repo→Work resolution succeeded. */
    workId?: string;
    summary: string;
    comments: PrReviewFileComment[];
    /** Provider id of the posted summary comment, when posted. */
    commentId?: number;
    /** Web URL of the reviewed pull request. */
    prUrl?: string;
    /** Which context blocks made it into the prompt (observability). */
    context: {
        work: boolean;
        kb: boolean;
        memory: boolean;
    };
    error?: string;
}
