'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { browserApiFetch } from '@/lib/api/browser-api';
import { ROUTES } from '@/lib/constants';
import {
    retryUpstreamReadinessAction,
    syncUpstreamAction,
    type AppUpstreamActionResult,
} from '@/app/actions/dashboard/works';
import type {
    AppReadinessState,
    AppUpstreamStateResponse,
    AppUpstreamSyncView,
} from '@ever-works/contracts';
import { AppUpstreamWarnings } from './AppUpstreamWarnings';
import { formatUpstreamAge, UpstreamDivergenceBadge } from './UpstreamDivergenceBadge';
import { showUpstreamCardOnOverview } from '@/lib/works/app-upstream-visibility';

/**
 * APW-02 T30 — the Upstream card (plan §5.2, `plan.md:629-640`; spec §6.1,
 * `spec.md:478-517`; Resolution R-8).
 *
 * ## Two variants, one component
 *
 * `variant="tab"` is the Upstream tab at `/works/:id/upstream` — relation,
 * **readiness**, divergence, sync and inherited workflows (FR-59). The
 * `variant="overview"` card is the same card minus the readiness row, on the App
 * Work's Overview, under APW-01's source card and only once readiness is `ready`
 * or `waiting_for_setup_pr` (plan §5.1, `plan.md:624-627`) — the page decides
 * that with {@link showUpstreamCardOnOverview}, and the other readiness states
 * belong to APW-01's card there.
 *
 * ## Who owns the data
 *
 * The page reads `GET /api/works/:id/upstream` on the server and hands the
 * answer in; the card owns what happens next: **Sync now** calls
 * `syncUpstreamAction`, and while a run is live — the row says so, or the click
 * optimistically said so — the card polls the read route through the BFF handler
 * (`apps/web/src/app/api/works/[id]/upstream/route.ts`) every
 * {@link UPSTREAM_POLL_INTERVAL_MS} until at most {@link UPSTREAM_POLL_MAX} polls,
 * stopping on unmount (plan §5.2, `plan.md:636`).
 *
 * ## The refusal codes are rendered, never re-derived
 *
 * A refused **Sync now** is an answer: the action hands back the API's own code
 * (`apps/api/src/app-works/app-upstream.controller.ts:124-132`) and the card
 * maps the two the spec gives copy for — `sync_in_progress` → "A sync is already
 * running.", `sync_limit_reached` → "You've synced 6 times this hour…" — and
 * falls back to `resultFailed` with the code for the rest. It never guesses that
 * a 409 means "busy": `not_ready` and `sync_paused` are 409s too.
 *
 * ## Sync Now is offered only where a sync can start
 *
 * `sync === null` is a `link` App Work: it has no upstream and no sync at all
 * (FR-44, `packages/contracts/src/apps/app-upstream.ts:267-277`), so the button
 * is not rendered rather than rendered to fail with `422 no_upstream`.
 */
export type AppUpstreamCardVariant = 'tab' | 'overview';

/** The card polls the read route every five seconds while a sync runs (plan §5.2). */
export const UPSTREAM_POLL_INTERVAL_MS = 5_000;

/** …and stops after 360 of them — thirty minutes (plan §5.2). */
export const UPSTREAM_POLL_MAX = 360;

/**
 * The readiness row's copy leaf per state (spec §6.1, `spec.md:496`).
 *
 * The leaves are spelled out rather than composed (`readiness.${…}`) because
 * `apps/web` types `t` against the literal key union of `messages/en.json`
 * (`apps/web/global.d.ts`): a template string is not that union, and a composed
 * key would also make a renamed leaf a runtime error instead of a compile error.
 */
export const UPSTREAM_READINESS_COPY_KEYS = {
    preparing: 'readiness.preparing',
    ready: 'readiness.ready',
    waiting_for_setup_pr: 'readiness.waitingForSetupPr',
    timed_out: 'readiness.timedOut',
    failed: 'readiness.failed',
} as const satisfies Record<AppReadinessState, string>;

// `showUpstreamCardOnOverview` now lives in
// `@/lib/works/app-upstream-visibility` — a module with NO `'use client'`
// directive — and is IMPORTED above. It moved because this module IS a client
// module, and `app/[locale]/(dashboard)/works/[id]/page.tsx` (a server
// component) CALLS the predicate in its render body: a server component that
// imports a plain function across a client boundary receives a client
// reference, not the function, so the call threw
// `Attempted to call showUpstreamCardOnOverview() from the server but … it is
// on the client` and Next.js answered `/works/<id>` with its error boundary for
// every Work (measured digest `2265010250`). Same class as the `/new` crash
// C22 fixed.
//
// The name this module used to EXPORT is re-exported below, unchanged and
// pointing at the one definition, so every existing consumer and spec keeps
// working.
export { showUpstreamCardOnOverview };

/**
 * **Try again** is offered for exactly the two states the API can act on and the
 * plan names (FR-59, `plan.md:619-620`): `timed_out` and `failed`.
 *
 * `waiting_for_setup_pr` is deliberately **not** offered even though the service
 * would accept it (`app-upstream-state.service.ts:798-804` refuses only
 * `preparing` and `ready`): the state is a normal resting state, not a stuck one
 * (R-4), and offering a retry there would invite a second setup pull request.
 */
export function upstreamOffersTryAgain(state: AppUpstreamStateResponse): boolean {
    return state.readiness.state === 'timed_out' || state.readiness.state === 'failed';
}

/** The result leaves of spec §6.1, as the literal key union `t` accepts. */
export type UpstreamResultLineKey =
    | 'resultUpToDate'
    | 'resultFastForwarded'
    | 'resultPullRequestOpened'
    | 'resultPullRequestUpdated'
    | 'resultLicenseChanged'
    | 'resultLicenseChangedNoSpdx'
    | 'resultConflict'
    | 'resultFailed';

/** One line of result copy, plus the link that belongs to it (spec §6.1). */
export interface UpstreamResultLine {
    key: UpstreamResultLineKey;
    values?: Record<string, string | number>;
    /** The sync pull request to link, when the line names one. */
    pullRequestUrl?: string;
    /** The conflict Task to link (`openTheTask`), when the line names one. */
    taskId?: string;
}

/**
 * The result line of the card (spec §6.1, `spec.md:508-513`).
 *
 * `lastReason === 'license_worse'` **wins over** the coarse `lastResult`: FR-37
 * turns a fast-forward into a pull request and the member must be told why
 * (ACC-02-12), and the run records `pull_request_opened` in that case.
 *
 * Provisional seam — **the `{spdx}` id**: `AppUpstreamSyncView` carries no
 * licence id (`packages/contracts/src/apps/app-upstream.ts:228-244`; the
 * entity has no such column, `work-upstream-state.entity.ts:89-300`), and the
 * sync run keeps the preview's `spdx` inside that one run
 * (`app-upstream-sync.service.ts:180,828`). The card therefore reads an optional
 * future field if the response ever carries one and otherwise renders
 * `resultLicenseChangedNoSpdx` — the same sentence spec §6.1 fixes, without an
 * id it was never given. When T26/T50 adds the field to the view, the note names
 * the licence with no change here.
 *
 * `paused` and `skipped` render **no** line: spec §6.1 gives copy for neither,
 * and both carry their reason as a §6.2 warning (`rateLimited`,
 * `privateCopyTooLarge`, `historyRewritten`, `upstreamUnavailable`, …).
 */
export function upstreamResultLine(sync: AppUpstreamSyncView | null): UpstreamResultLine | null {
    if (!sync || !sync.lastResult) {
        return null;
    }

    const commitCount = sync.lastCommitCount ?? 0;
    const pullRequestUrl = sync.pullRequest?.url;
    const licenseSpdx = (sync as { licenseSpdx?: string | null }).licenseSpdx ?? null;

    if (sync.lastReason === 'license_worse') {
        return licenseSpdx
            ? { key: 'resultLicenseChanged', values: { spdx: licenseSpdx }, pullRequestUrl }
            : { key: 'resultLicenseChangedNoSpdx', pullRequestUrl };
    }

    switch (sync.lastResult) {
        case 'up_to_date':
            return { key: 'resultUpToDate' };
        case 'fast_forwarded':
            return { key: 'resultFastForwarded', values: { count: commitCount } };
        case 'pull_request_opened':
            return {
                key: 'resultPullRequestOpened',
                values: { count: commitCount },
                pullRequestUrl,
            };
        case 'pull_request_updated':
            return {
                key: 'resultPullRequestUpdated',
                values: { count: commitCount },
                pullRequestUrl,
            };
        case 'conflict':
            return { key: 'resultConflict', taskId: sync.conflictTaskId };
        case 'failed':
            return { key: 'resultFailed', values: { reason: sync.lastReason ?? 'failed' } };
        default:
            return null;
    }
}

/**
 * `{when}` for `Next sync {when}` (spec §6.1, `spec.md:507`).
 *
 * Absolute UTC, because that is how the App spec writes its cron and how the
 * schedule is computed (`plan.md:756-762`), and because a relative time for a
 * future instant would drift under the reader's eyes.
 */
export function formatNextSync(when: string): string {
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) {
        return when;
    }

    const parts = new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
    }).format(at);

    return `${parts} UTC`;
}

/** `{ago}` for `Last synced {ago}` — the same sentence shape as the badge's. */
export function formatLastSynced(when: string, now: number): string {
    return formatUpstreamAge(when, now);
}

export interface AppUpstreamCardProps {
    workId: string;
    variant: AppUpstreamCardVariant;
    /** `GET /api/works/:id/upstream`, read by the page. */
    initialState: AppUpstreamStateResponse;
}

export function AppUpstreamCard({ workId, variant, initialState }: AppUpstreamCardProps) {
    const t = useTranslations('dashboard.workDetail.appUpstream');
    const [state, setState] = useState(initialState);
    const [pending, setPending] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [optimisticRunning, setOptimisticRunning] = useState(false);
    const [failure, setFailure] = useState<AppUpstreamActionResult | null>(null);
    const [showWorkflows, setShowWorkflows] = useState(false);
    const polls = useRef(0);

    // A `revalidatePath` from either action re-renders the page with a fresh
    // answer; the card follows it rather than keeping a stale copy of its own.
    useEffect(() => {
        setState(initialState);
    }, [initialState]);

    const refresh = useCallback(async (): Promise<AppUpstreamStateResponse | null> => {
        try {
            const response = await browserApiFetch(`/api/works/${workId}/upstream`);
            if (!response.ok) {
                return null;
            }
            const next = (await response.json()) as AppUpstreamStateResponse;
            setState(next);
            return next;
        } catch {
            // Best effort: a failed poll leaves the last known state on screen.
            return null;
        }
    }, [workId]);

    const running = optimisticRunning || state.sync?.running === true;

    useEffect(() => {
        if (!running) {
            return;
        }

        polls.current = 0;

        const interval = window.setInterval(async () => {
            if (polls.current >= UPSTREAM_POLL_MAX) {
                window.clearInterval(interval);
                return;
            }

            polls.current += 1;
            const next = await refresh();

            if (next && next.sync?.running !== true) {
                setOptimisticRunning(false);
                window.clearInterval(interval);
            }
        }, UPSTREAM_POLL_INTERVAL_MS);

        return () => window.clearInterval(interval);
    }, [running, refresh]);

    const onSyncNow = async () => {
        setFailure(null);
        setPending(true);

        try {
            const result = await syncUpstreamAction(workId);
            if (result.success) {
                // Optimistic **Syncing…** (plan §5.2): the job is queued, so the
                // button says so before the next poll confirms the run started.
                setOptimisticRunning(true);
            } else {
                setFailure(result);
            }
        } finally {
            setPending(false);
        }
    };

    const onTryAgain = async () => {
        setFailure(null);
        setRetrying(true);

        try {
            const result = await retryUpstreamReadinessAction(workId);
            if (result.success) {
                void refresh();
            } else {
                setFailure(result);
            }
        } finally {
            setRetrying(false);
        }
    };

    const now = Date.now();
    const upstream = state.upstream;
    const sync = state.sync;
    const actions = state.actions;
    const result = upstreamResultLine(sync);
    const retryAt =
        typeof failure?.details?.retryAt === 'string' ? (failure.details.retryAt as string) : null;
    const disabledCount = actions?.disabled.length ?? 0;

    return (
        <section
            data-testid="app-upstream-card"
            className="rounded-lg border overflow-hidden bg-card dark:bg-transparent border-card-border dark:border-border-secondary-dark"
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                    {upstream && (
                        <a
                            href={upstream.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-primary dark:text-gray-100 hover:underline"
                        >
                            {upstream.owner}/{upstream.repo} ↗
                        </a>
                    )}
                </div>

                {sync && (
                    <button
                        type="button"
                        data-testid="app-upstream-sync-now"
                        onClick={onSyncNow}
                        disabled={pending || running}
                        className="px-3 py-1.5 rounded-md text-sm font-medium border border-card-border dark:border-border-secondary-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark disabled:opacity-60"
                    >
                        {pending || running ? t('syncing') : t('syncNow')}
                    </button>
                )}
            </div>

            <div className="px-5 py-4 space-y-2">
                <p
                    data-testid="app-upstream-relation"
                    className="text-sm text-text dark:text-text-dark"
                >
                    {state.relation === 'private-copy'
                        ? t('relationPrivateCopy', { upstream: repositoryLabel(upstream) })
                        : t('relationFork', { upstream: repositoryLabel(upstream) })}
                </p>

                {variant === 'tab' && (
                    <div data-testid="app-upstream-readiness" className="text-sm">
                        <span className="text-text-secondary dark:text-text-secondary-dark">
                            {t(UPSTREAM_READINESS_COPY_KEYS[state.readiness.state])}
                        </span>
                        {state.readiness.state === 'waiting_for_setup_pr' &&
                            state.readiness.setupPullRequestUrl && (
                                <a
                                    href={state.readiness.setupPullRequestUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="ml-2 text-primary dark:text-gray-100 hover:underline"
                                >
                                    #{state.readiness.setupPullRequestNumber ?? ''}
                                </a>
                            )}
                        {upstreamOffersTryAgain(state) && (
                            <button
                                type="button"
                                data-testid="app-upstream-readiness-retry"
                                onClick={onTryAgain}
                                disabled={retrying}
                                className="ml-2 font-medium text-primary dark:text-gray-100 underline hover:no-underline disabled:opacity-60"
                            >
                                {t('readiness.tryAgain')}
                            </button>
                        )}
                    </div>
                )}

                <UpstreamDivergenceBadge divergence={state.divergence} now={now} />

                {sync && (
                    <div className="space-y-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                        <p>
                            {sync.lastFinishedAt
                                ? t('lastSynced', {
                                      ago: formatLastSynced(sync.lastFinishedAt, now),
                                  })
                                : t('notSyncedYet')}
                            {sync.nextRunAt && (
                                <span className="ml-2">
                                    {t('nextSync', { when: formatNextSync(sync.nextRunAt) })}
                                </span>
                            )}
                        </p>

                        {result && (
                            <p data-testid="app-upstream-result">
                                {result.values ? t(result.key, result.values) : t(result.key)}
                                {result.pullRequestUrl && sync.pullRequest && (
                                    <a
                                        href={result.pullRequestUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="ml-2 text-primary dark:text-gray-100 hover:underline"
                                    >
                                        #{sync.pullRequest.number}
                                    </a>
                                )}
                                {result.taskId && (
                                    <a
                                        href={ROUTES.DASHBOARD_TASK(result.taskId)}
                                        className="ml-2 text-primary dark:text-gray-100 hover:underline"
                                    >
                                        {t('openTheTask')}
                                    </a>
                                )}
                            </p>
                        )}

                        {sync.pullRequest && !result?.pullRequestUrl && (
                            <p>
                                <a
                                    href={sync.pullRequest.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-primary dark:text-gray-100 hover:underline"
                                >
                                    {t('openPullRequest')} #{sync.pullRequest.number}
                                </a>
                            </p>
                        )}
                    </div>
                )}

                {failure && (
                    <p
                        data-testid="app-upstream-failure"
                        className="text-sm text-red-600 dark:text-red-400"
                    >
                        {failure.code === 'sync_in_progress'
                            ? t('alreadyRunning')
                            : failure.code === 'sync_limit_reached'
                              ? t('syncLimitReached', {
                                    time: retryAt ? formatNextSync(retryAt) : 'later',
                                })
                              : t('resultFailed', { reason: failure.code ?? 'failed' })}
                    </p>
                )}

                {disabledCount > 0 && (
                    <div className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        <div className="flex items-center gap-2">
                            <span>
                                {t('workflowsDisabled', {
                                    count: disabledCount,
                                })}
                            </span>
                            <button
                                type="button"
                                data-testid="app-upstream-workflows-toggle"
                                onClick={() => setShowWorkflows((value) => !value)}
                                className="font-medium text-primary dark:text-gray-100 underline hover:no-underline"
                            >
                                {showWorkflows ? t('workflowsHide') : t('workflowsShow')}
                            </button>
                        </div>
                        {showWorkflows && (
                            <ul
                                className="mt-1 space-y-0.5 text-xs"
                                data-testid="app-upstream-workflows-list"
                            >
                                {actions?.disabled.map((workflow) => (
                                    <li key={workflow.path} className="font-mono">
                                        {workflow.path}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('workflowsNote')}
                        </p>
                    </div>
                )}

                <AppUpstreamWarnings
                    warnings={state.warnings}
                    dataRepository={state.dataRepository}
                    pullRequest={sync?.pullRequest}
                    onCheckAgain={() => {
                        void refresh();
                    }}
                />
            </div>
        </section>
    );
}

/** `{upstream}` for the relation row: `owner/repo`, or the Work Repository when there is no upstream. */
function repositoryLabel(upstream: AppUpstreamStateResponse['upstream']): string {
    return upstream ? `${upstream.owner}/${upstream.repo}` : '';
}
