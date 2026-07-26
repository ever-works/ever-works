'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import {
    getWorkPullRequestDiffAction,
    requestWorkPullRequestReviewAction,
} from '@/app/actions/works/pull-requests';
import type { PullRequestDiffFileView, PullRequestDiffView } from '@/lib/api/pull-requests';

/**
 * Wave 7 feature h — the PR detail view: the diff plus the agent's
 * reviews plus the "Request agent review" action.
 *
 * The diff arrives already byte-capped by the API (per file AND in
 * total) and says so via `truncated`, so this component never has to
 * guess whether it is showing a whole patch. Review history comes from
 * the same response — the platform records each review as a
 * `github.pr.review` envelope on the event-ingest spine, so there is one
 * source of truth and no second write path.
 *
 * "Request agent review" calls the SAME `PrReviewService` the GitHub
 * webhook bridge does, so a manually triggered review is byte-identical
 * to an automatic one; on success the diff is re-fetched so the new
 * review appears in the list.
 */

export interface PullRequestDiffPanelProps {
    readonly workId: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    /** Pre-fetched detail (specs and future server-render paths). */
    readonly initialDiff?: PullRequestDiffView;
}

/** Classify one unified-diff line for colouring. */
function lineTone(line: string): 'add' | 'del' | 'meta' | 'context' {
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index '))
        return 'meta';
    return 'context';
}

const TONE_CLASSES: Record<ReturnType<typeof lineTone>, string> = {
    add: 'bg-success/10 text-success',
    del: 'bg-danger/10 text-danger',
    meta: 'text-text-muted dark:text-text-muted-dark/70',
    context: 'text-text-secondary dark:text-text-secondary-dark',
};

function DiffFile({
    file,
    truncatedLabel,
}: {
    file: PullRequestDiffFileView;
    truncatedLabel: string;
}) {
    const lines = (file.patch ?? '').split('\n');
    return (
        <div
            className="rounded-lg border border-border dark:border-border-dark overflow-hidden"
            data-testid="pr-diff-file"
        >
            <div className="flex flex-wrap items-center gap-2 border-b border-border dark:border-border-dark bg-card/40 dark:bg-card-primary-dark/20 px-3 py-2">
                <span className="font-mono text-xs text-text dark:text-text-dark break-all">
                    {file.filename}
                </span>
                <span className="text-xs text-success">+{file.additions}</span>
                <span className="text-xs text-danger">-{file.deletions}</span>
                {file.truncated ? (
                    <span className="text-xs text-warning" data-testid="pr-diff-file-truncated">
                        {truncatedLabel}
                    </span>
                ) : null}
            </div>
            {file.patch ? (
                <div className="overflow-x-auto">
                    <pre className="min-w-full text-xs leading-5 font-mono">
                        {lines.map((line, index) => (
                            <div
                                key={`${file.filename}-${index}`}
                                className={cn('px-3 whitespace-pre', TONE_CLASSES[lineTone(line)])}
                            >
                                {line === '' ? ' ' : line}
                            </div>
                        ))}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}

export function PullRequestDiffPanel({
    workId,
    owner,
    repo,
    prNumber,
    initialDiff,
}: PullRequestDiffPanelProps) {
    const t = useTranslations('dashboard.workDetail.pullRequests');
    const [diff, setDiff] = useState<PullRequestDiffView | null>(initialDiff ?? null);
    const [loading, setLoading] = useState(initialDiff === undefined);
    const [error, setError] = useState<string | null>(null);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [reviewing, startReview] = useTransition();

    const load = useCallback(async () => {
        setLoading(true);
        const result = await getWorkPullRequestDiffAction({ workId, owner, repo, prNumber });
        if (result.success && result.data) {
            setDiff(result.data);
            setError(null);
        } else {
            setError(result.error ?? t('errors.diff'));
        }
        setLoading(false);
    }, [workId, owner, repo, prNumber, t]);

    useEffect(() => {
        if (initialDiff === undefined) void load();
        // Re-fetch whenever the selected PR changes.
    }, [initialDiff, load]);

    const onRequestReview = useCallback(() => {
        setReviewError(null);
        startReview(async () => {
            const result = await requestWorkPullRequestReviewAction({
                workId,
                owner,
                repo,
                prNumber,
            });
            if (!result.success) {
                setReviewError(result.error ?? t('errors.review'));
                return;
            }
            // A `failed` result is a real outcome, not a transport error —
            // surface its reason instead of pretending the review landed.
            if (result.data?.status === 'failed') {
                setReviewError(result.data.error ?? t('errors.review'));
            }
            await load();
        });
    }, [workId, owner, repo, prNumber, load, t]);

    if (loading) {
        return (
            <div
                className="flex items-center gap-2 p-6 text-sm text-text-secondary dark:text-text-secondary-dark"
                data-testid="pr-diff-loading"
            >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('detail.loading')}
            </div>
        );
    }

    if (error || !diff) {
        return (
            <div
                className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger"
                data-testid="pr-diff-error"
            >
                {error ?? t('errors.diff')}
            </div>
        );
    }

    return (
        <div className="space-y-4" data-testid="pr-diff-panel">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark break-words">
                        #{diff.pullRequest.number} {diff.pullRequest.title}
                    </h3>
                    <p className="mt-0.5 font-mono text-xs text-text-secondary dark:text-text-secondary-dark break-all">
                        {diff.pullRequest.head} → {diff.pullRequest.base}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border dark:border-border-dark px-2.5 py-1.5 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark"
                        data-testid="pr-diff-refresh"
                    >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('detail.refresh')}
                    </button>
                    <button
                        type="button"
                        onClick={onRequestReview}
                        disabled={reviewing}
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                        data-testid="pr-request-review"
                    >
                        {reviewing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {t('detail.requestReview')}
                    </button>
                </div>
            </div>

            {reviewError ? (
                <div
                    className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger"
                    data-testid="pr-review-error"
                >
                    {reviewError}
                </div>
            ) : null}

            <section aria-label={t('detail.reviews')}>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark/70">
                    {t('detail.reviews')}
                </h4>
                {diff.reviews.length === 0 ? (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="pr-reviews-empty"
                    >
                        {t('detail.noReviews')}
                    </p>
                ) : (
                    <ul className="space-y-2" data-testid="pr-reviews-list">
                        {diff.reviews.map((review) => (
                            <li
                                key={review.id}
                                className="rounded-lg border border-border dark:border-border-dark p-3"
                                data-testid="pr-review-item"
                            >
                                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted dark:text-text-muted-dark/70">
                                    <time dateTime={review.occurredAt}>
                                        {new Date(review.occurredAt).toLocaleString()}
                                    </time>
                                    {review.commentCount != null ? (
                                        <span>
                                            {t('detail.fileNotes', { count: review.commentCount })}
                                        </span>
                                    ) : null}
                                    {!review.posted ? (
                                        <span className="text-warning">
                                            {t('detail.notPosted')}
                                        </span>
                                    ) : null}
                                </div>
                                {review.summary ? (
                                    <p className="mt-1 whitespace-pre-wrap text-sm text-text dark:text-text-dark">
                                        {review.summary}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section aria-label={t('detail.diff')}>
                <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark/70">
                        {t('detail.diff')}
                    </h4>
                    {diff.truncated ? (
                        <span className="text-xs text-warning" data-testid="pr-diff-truncated">
                            {t('detail.truncated')}
                        </span>
                    ) : null}
                </div>
                {diff.files.length === 0 ? (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="pr-diff-empty"
                    >
                        {t('detail.noDiff')}
                    </p>
                ) : (
                    <div className="space-y-3">
                        {diff.files.map((file) => (
                            <DiffFile
                                key={file.filename}
                                file={file}
                                truncatedLabel={t('detail.fileTruncated')}
                            />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
