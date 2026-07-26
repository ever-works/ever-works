'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { AlertTriangle, ExternalLink, GitPullRequest, Loader2 } from 'lucide-react';
import { listWorkPullRequestsAction } from '@/app/actions/works/pull-requests';
import type { PullRequestView, WorkRepoPullRequestsView } from '@/lib/api/pull-requests';
import { PullRequestReviewPill, PullRequestStatePill } from './pull-request-pills';
import { PullRequestDiffPanel } from './PullRequestDiffPanel';

/**
 * Wave 7 feature h — the Work "Pull requests" tab.
 *
 * Lists the open PRs of every repository the Work declares (main /
 * website / data) from `GET /api/works/:id/pull-requests`, grouped per
 * repo, with per-repo error degradation preserved from the API (a Work
 * whose website repo was never generated still shows its main repo's
 * PRs). Selecting a PR opens the diff + agent-review panel.
 *
 * The audit's finding this closes: the list endpoint shipped with zero
 * web callers — "no PR route or component anywhere in apps/web/src".
 */

export interface WorkPullRequestsClientProps {
    readonly workId: string;
    /** Server-fetched first page; omitted means fetch on mount. */
    readonly initialRepos?: WorkRepoPullRequestsView[];
    /** Server-side load error, rendered instead of an empty state. */
    readonly initialError?: string | null;
}

interface Selection {
    owner: string;
    repo: string;
    prNumber: number;
}

function sameSelection(a: Selection | null, b: Selection): boolean {
    return a?.owner === b.owner && a?.repo === b.repo && a?.prNumber === b.prNumber;
}

export function WorkPullRequestsClient({
    workId,
    initialRepos,
    initialError = null,
}: WorkPullRequestsClientProps) {
    const t = useTranslations('dashboard.workDetail.pullRequests');
    const [repos, setRepos] = useState<WorkRepoPullRequestsView[]>(initialRepos ?? []);
    const [loading, setLoading] = useState(initialRepos === undefined);
    const [error, setError] = useState<string | null>(initialError);
    const [selected, setSelected] = useState<Selection | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        const result = await listWorkPullRequestsAction(workId);
        if (result.success && result.data) {
            setRepos(result.data.repos ?? []);
            setError(null);
        } else {
            setError(result.error ?? t('errors.list'));
        }
        setLoading(false);
    }, [workId, t]);

    useEffect(() => {
        if (initialRepos === undefined) void load();
    }, [initialRepos, load]);

    const totalOpen = useMemo(
        () => repos.reduce((sum, repo) => sum + repo.pullRequests.length, 0),
        [repos],
    );

    if (loading) {
        return (
            <div
                className="flex items-center gap-2 p-6 text-sm text-text-secondary dark:text-text-secondary-dark"
                data-testid="pull-requests-loading"
            >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('loading')}
            </div>
        );
    }

    if (error) {
        return (
            <div
                className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger"
                data-testid="pull-requests-error"
            >
                {error}
            </div>
        );
    }

    return (
        <div className="space-y-6" data-testid="pull-requests-shell">
            <header className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle', { count: totalOpen })}
                    </p>
                </div>
            </header>

            {repos.length === 0 || totalOpen === 0 ? (
                <div
                    className={cn(
                        'rounded-lg border border-dashed p-12 text-center',
                        'border-border dark:border-border-dark',
                        'bg-card/30 dark:bg-card-primary-dark/20',
                    )}
                    data-testid="pull-requests-empty"
                >
                    <GitPullRequest
                        className="mx-auto h-10 w-10 text-text-muted dark:text-text-muted-dark/60"
                        aria-hidden="true"
                    />
                    <h3 className="mt-4 text-sm font-semibold text-text dark:text-text-dark">
                        {t('empty.title')}
                    </h3>
                    <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('empty.body')}
                    </p>
                </div>
            ) : null}

            {repos.map((repo) => (
                <section
                    key={`${repo.role}:${repo.owner}/${repo.repo}`}
                    aria-label={`${repo.owner}/${repo.repo}`}
                    data-testid="pull-requests-repo"
                >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-text dark:text-text-dark">
                            {repo.owner}/{repo.repo}
                        </span>
                        <span className="rounded-full border border-border dark:border-border-dark px-2 py-0.5 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t(`roles.${repo.role}`)}
                        </span>
                    </div>

                    {repo.error ? (
                        <div
                            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-warning"
                            data-testid="pull-requests-repo-error"
                        >
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{t('repoError', { message: repo.error })}</span>
                        </div>
                    ) : repo.pullRequests.length === 0 ? (
                        <p
                            className="text-sm text-text-secondary dark:text-text-secondary-dark"
                            data-testid="pull-requests-repo-empty"
                        >
                            {t('noOpen')}
                        </p>
                    ) : (
                        <ul className="divide-y divide-border dark:divide-border-dark rounded-lg border border-border dark:border-border-dark">
                            {repo.pullRequests.map((pr: PullRequestView) => {
                                const selection: Selection = {
                                    owner: repo.owner,
                                    repo: repo.repo,
                                    prNumber: pr.number,
                                };
                                const isSelected = sameSelection(selected, selection);
                                return (
                                    <li key={pr.number} data-testid="pull-request-row">
                                        <div className="flex flex-wrap items-center gap-2 p-3">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setSelected(isSelected ? null : selection)
                                                }
                                                className="min-w-0 flex-1 text-left"
                                                aria-expanded={isSelected}
                                                data-testid={`pull-request-open-${pr.number}`}
                                            >
                                                <span className="block truncate text-sm font-medium text-text dark:text-text-dark">
                                                    #{pr.number} {pr.title}
                                                </span>
                                                <span className="mt-0.5 block truncate font-mono text-xs text-text-secondary dark:text-text-secondary-dark">
                                                    {pr.head} → {pr.base}
                                                    {pr.author ? ` · ${pr.author.username}` : ''}
                                                </span>
                                            </button>
                                            <PullRequestStatePill
                                                state={pr.state}
                                                label={t(`states.${pr.state}`)}
                                            />
                                            {/* Review state is the platform's own record; see
                                                pull-request-pills.tsx on why no CI pill ships yet. */}
                                            <PullRequestReviewPill
                                                reviewed={isSelected}
                                                label={
                                                    isSelected
                                                        ? t('pills.viewing')
                                                        : t('pills.review')
                                                }
                                            />
                                            <a
                                                href={pr.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-text-muted hover:text-text dark:text-text-muted-dark/70 dark:hover:text-text-dark"
                                                aria-label={t('openExternal', {
                                                    number: pr.number,
                                                })}
                                                data-testid={`pull-request-external-${pr.number}`}
                                            >
                                                <ExternalLink
                                                    className="h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                            </a>
                                        </div>
                                        {isSelected ? (
                                            <div className="border-t border-border dark:border-border-dark bg-card/30 dark:bg-card-primary-dark/20 p-3">
                                                <PullRequestDiffPanel
                                                    workId={workId}
                                                    owner={repo.owner}
                                                    repo={repo.repo}
                                                    prNumber={pr.number}
                                                />
                                            </div>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            ))}
        </div>
    );
}
