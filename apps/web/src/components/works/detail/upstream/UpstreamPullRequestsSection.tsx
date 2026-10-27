'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import {
    UPSTREAM_PULL_REQUEST_STATES,
    UPSTREAM_REFUSAL_CODES,
    type UpstreamPullRequestView,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/**
 * Only an `https:` link is rendered as a link. The URL is the provider's own answer, stored by
 * the platform, but it is rendered into an `href`, so anything else (`javascript:`, a relative
 * path) is shown as plain text.
 */
export function safeUpstreamUrl(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

/** The tone of each state chip: final-good, in flight, final-problem. */
const STATE_TONE: Record<string, string> = {
    preparing: 'bg-info/10 text-info',
    needs_signature: 'bg-warning/10 text-warning',
    awaiting_approval: 'bg-warning/10 text-warning',
    opening: 'bg-info/10 text-info',
    open: 'bg-success/10 text-success',
    merged: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
    closed: 'bg-text-muted/10 text-text-muted',
    refused: 'bg-danger/10 text-danger',
    failed: 'bg-danger/10 text-danger',
    expired: 'bg-text-muted/10 text-text-muted',
    withdrawn: 'bg-text-muted/10 text-text-muted',
};

/**
 * APW-09 — the **Upstream pull requests** section of the Upstream tab (R-8: APW-02 owns the
 * tab, this epic appends its section in the slot below the card).
 *
 * Read-only in this slice: every member's records for the App Work, newest first, each with
 * its state, its number and link, whether it is a draft, whether it was opened directly
 * (`origin: 'direct'`) and, for a refused or failed record, the refusal copy. The page reads
 * the list on the server (`GET /api/works/:id/upstream-pull-requests`) and passes it in;
 * `rows === null` means the read failed, which renders a one-line notice rather than an empty
 * list that would look like "none".
 *
 * Dates are formatted in UTC (the zone is named by `timeStyle: 'long'`) so the server render
 * and the browser agree.
 */
export function UpstreamPullRequestsSection({
    rows,
    relation,
    upstream,
}: {
    rows: UpstreamPullRequestView[] | null;
    relation: string;
    upstream: string | null;
}) {
    const t = useTranslations('dashboard.workDetail.upstream.pullRequests');
    const refusals = useTranslations('dashboard.workDetail.upstream.refusals');
    const format = useFormatter();
    const upstreamName = upstream ?? t('theUpstream');

    return (
        <section
            aria-labelledby="upstream-pull-requests-heading"
            className="space-y-3"
            data-testid="upstream-pull-requests-section"
        >
            <div>
                <h2
                    id="upstream-pull-requests-heading"
                    className="text-lg font-semibold text-text dark:text-text-dark"
                >
                    {t('title')}
                </h2>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('description')}
                </p>
            </div>

            {relation === 'private-copy' ? (
                <p
                    className="rounded-md border border-border p-3 text-sm text-text-secondary dark:border-border-dark dark:text-text-secondary-dark"
                    data-testid="upstream-pull-requests-private-copy"
                >
                    {t('privateCopy', { upstream: upstreamName })}
                </p>
            ) : null}

            {rows === null ? (
                <p
                    className="text-sm text-danger"
                    role="alert"
                    data-testid="upstream-pull-requests-error"
                >
                    {t('loadFailed')}
                </p>
            ) : rows.length === 0 ? (
                <p
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="upstream-pull-requests-empty"
                >
                    {t('empty')}
                </p>
            ) : (
                <ul className="divide-y divide-border rounded-md border border-border dark:divide-border-dark dark:border-border-dark">
                    {rows.map((row) => {
                        const state = (UPSTREAM_PULL_REQUEST_STATES as readonly string[]).includes(
                            row.state,
                        )
                            ? row.state
                            : null;
                        const refusal =
                            row.refusalCode &&
                            (UPSTREAM_REFUSAL_CODES as readonly string[]).includes(row.refusalCode)
                                ? refusals(row.refusalCode as Parameters<typeof refusals>[0], {
                                      upstream: `${row.upstream.owner}/${row.upstream.repo}`,
                                      fork: `${row.head.owner}/${row.head.repo}`,
                                      count: 1,
                                      time: '',
                                      path: '',
                                      lines: 0,
                                      limit: 0,
                                      command: '',
                                  })
                                : null;
                        const when = row.openedAt ?? row.createdAt;
                        return (
                            <li
                                key={row.id}
                                className="flex flex-col gap-1 p-3 text-sm"
                                data-testid="upstream-pull-request-row"
                                data-state={row.state}
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span
                                        className={cn(
                                            'rounded-full px-2 py-0.5 text-xs font-medium',
                                            STATE_TONE[row.state] ??
                                                'bg-surface-secondary text-text-secondary',
                                        )}
                                    >
                                        {state
                                            ? t(`states.${state}` as Parameters<typeof t>[0])
                                            : row.state}
                                    </span>
                                    {safeUpstreamUrl(row.url) && row.number !== null ? (
                                        <a
                                            href={safeUpstreamUrl(row.url) ?? undefined}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                                        >
                                            {row.upstream.owner}/{row.upstream.repo}#{row.number}
                                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                            <span className="sr-only">{t('opensInNewTab')}</span>
                                        </a>
                                    ) : (
                                        <span className="font-medium text-text dark:text-text-dark">
                                            {row.upstream.owner}/{row.upstream.repo}
                                        </span>
                                    )}
                                    {row.draft ? (
                                        <span className="rounded border border-border px-1.5 text-xs text-text-muted dark:border-border-dark">
                                            {t('draft')}
                                        </span>
                                    ) : null}
                                    {row.origin === 'direct' ? (
                                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('openedDirectly')}
                                        </span>
                                    ) : null}
                                </div>
                                {row.title ? (
                                    <p className="text-text dark:text-text-dark">{row.title}</p>
                                ) : null}
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('head', { head: `${row.head.owner}:${row.head.branch}` })}
                                    {' · '}
                                    {format.dateTime(new Date(when), {
                                        dateStyle: 'medium',
                                        timeStyle: 'long',
                                        timeZone: 'UTC',
                                    })}
                                </p>
                                {refusal ? (
                                    <p
                                        className="text-xs text-danger"
                                        data-testid="upstream-pull-request-refusal"
                                    >
                                        {refusal}
                                    </p>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
