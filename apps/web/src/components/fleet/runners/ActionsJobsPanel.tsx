'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ExternalLink, ListChecks } from 'lucide-react';
import {
    FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS,
    type FleetActionsJobView,
} from '@ever-works/contracts';
import {
    cancelFleetActionsRunAction,
    listFleetActionsJobsAction,
} from '@/app/actions/fleet/runners';
import type { FleetOverviewBlockProps } from '../registry';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import { useMachineAction } from '../machine/use-machine-action';
import { useMachineList } from '../machine/use-machine-list';
import { ActionsJobRow } from './ActionsJobRow';
import { WatchedTargetsEditor } from './WatchedTargetsEditor';
import {
    ACTIONS_JOBS_ANCHOR,
    ACTIONS_JOB_PARAM,
    actionsJobKey,
    actionsJobsPanelHasContent,
    cancelRunDialog,
    cancelRunRequest,
    formatClock,
    isHighlightedJob,
    jobCounts,
    parseActionsJobParam,
    watchedTargetsText,
} from './runners.shared';

/**
 * Actions jobs (FL-18 P2, spec §0, §5.4, FR-20 – FR-25, CONTRACTS R-37) — the
 * hub Overview's **Actions jobs** panel (a panel, not a tab or a route):
 *
 * ```
 * Actions jobs                         3 queued · 2 running · 2 of 3 runners busy
 *   ◐ acme/api   test · ubuntu    #4821   build-01-2 · running 4 min
 *   ◷ acme/api   e2e · windows    #4822   queued 6 min
 *                ⚠ no runner can take it — no runner has the label windows   [Cancel workflow run…]
 * checked 09:41 · watching acme/api, acme/web  [Change]
 * ```
 *
 * The queued and in-progress jobs of the watched repositories and
 * organisations that target self-hosted runners, with the API's diagnosis for
 * each queued one (FR-22); re-read every
 * {@link FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS} while visible (FR-25; the last
 * good answer is kept when a later read is refused). Notes: GitHub is
 * rate-limiting (U17), the kill switch (runners keep running; installing and
 * cancelling are paused, U14), and each watched target that could not be read
 * with **Grant access** when GitHub's permission is missing (FR-26). **Change**
 * edits the watched list (`WatchedTargetsEditor`). **Cancel workflow run…** is
 * offered only when the API says the viewer may (`canCancel`), confirmed with
 * the contracts' sentence. A run the `job-unassignable` item points at
 * (`?actionsJob=acme/api%234822`) is highlighted. Renders nothing while
 * runners are switched off (404) or when there is nothing to show.
 */
export default function ActionsJobsPanel(_props: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.runners.jobs');
    const { data, error, loading, refresh } = useMachineList(
        listFleetActionsJobsAction,
        FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS,
    );
    const action = useMachineAction<Record<string, unknown>>();
    const [editing, setEditing] = useState(false);
    const searchParams = useSearchParams();
    const highlight = parseActionsJobParam(searchParams?.get(ACTIONS_JOB_PARAM));
    const section = useRef<HTMLElement | null>(null);
    const scrolled = useRef(false);
    const loaded = data !== null;

    // The palette's "Actions jobs" opens `/fleet#fleet-actions-jobs`, but the panel renders
    // after its first read: bring it into view once, when it does.
    useEffect(() => {
        if (!loaded || scrolled.current || typeof window === 'undefined') return;
        if (window.location.hash !== `#${ACTIONS_JOBS_ANCHOR}`) return;
        scrolled.current = true;
        const element = section.current;
        if (element && typeof element.scrollIntoView === 'function')
            element.scrollIntoView({ block: 'start' });
    }, [loaded]);

    if (!data && error?.code === 'not_found') return null;
    if (!data && loading) {
        return (
            <section
                id={ACTIONS_JOBS_ANCHOR}
                className="rounded-lg border border-border p-4 text-sm dark:border-border-dark"
                data-testid="fleet-actions-jobs"
            >
                <h3 className="font-semibold">{t('title')}</h3>
                <p className="text-text-muted dark:text-text-muted-dark" role="status">
                    {t('loading')}
                </p>
            </section>
        );
    }
    if (data && !actionsJobsPanelHasContent(data)) return null;

    const jobs = data?.jobs ?? [];
    const counts = jobCounts(jobs);
    const checked = formatClock(data?.checkedAt);
    const next = data?.rateLimitedUntil ? formatClock(data.rateLimitedUntil) : null;
    const killSwitch = data?.killSwitch === true;
    const watched = data?.watched ?? [];
    const highlightGone = Boolean(
        data && highlight && !jobs.some((job) => isHighlightedJob(job, highlight)),
    );

    const cancel = (job: FleetActionsJobView) => {
        action.request({
            key: `${job.repository}#${job.runId}`,
            dialog: cancelRunDialog(job),
            actionLabel: t('cancelConfirm'),
            run: (fields) =>
                cancelFleetActionsRunAction(cancelRunRequest(job, fields.confirm === true)),
            onDone: () => {
                toast.success(
                    typeof job.runNumber === 'number'
                        ? t('cancelling', { number: job.runNumber, repository: job.repository })
                        : t('cancellingNoNumber', { repository: job.repository }),
                );
                void refresh();
            },
            onError: (refusal) => toast.error(refusal.hint || t('cancelFailed')),
        });
    };

    const watchingLine = (
        <span
            className="flex flex-wrap items-center gap-x-2"
            data-testid="fleet-actions-jobs-watching"
        >
            <span>
                {watched.length > 0
                    ? t('watching', { targets: watchedTargetsText(watched) })
                    : t('watchingNone')}
            </span>
            {data && !data.watchedSaved && watched.length > 0 ? (
                <span className="text-text-muted dark:text-text-muted-dark">
                    {t('watchingDefault')}
                </span>
            ) : null}
            {data ? (
                <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => setEditing(true)}
                    data-testid="fleet-actions-jobs-change"
                >
                    {t('change')}
                </button>
            ) : null}
        </span>
    );

    return (
        <section
            ref={section}
            id={ACTIONS_JOBS_ANCHOR}
            className="rounded-lg border border-border p-4 text-sm dark:border-border-dark"
            aria-labelledby="fleet-actions-jobs-title"
            data-testid="fleet-actions-jobs"
        >
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 id="fleet-actions-jobs-title" className="flex items-center gap-2 font-semibold">
                    <ListChecks className="h-4 w-4" aria-hidden="true" />
                    {t('title')}
                </h3>
                {data ? (
                    <span
                        className="ml-auto text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-actions-jobs-counts"
                    >
                        {t('counts', counts)}
                        {' · '}
                        {t('busy', { busy: data.busyRunners, total: data.totalRunners })}
                    </span>
                ) : null}
            </div>

            {killSwitch ? (
                <p
                    className="mb-2 rounded-md bg-warning/10 p-2 text-xs text-warning"
                    role="status"
                    data-testid="fleet-actions-jobs-kill-switch"
                >
                    {t('killSwitch')}
                </p>
            ) : null}
            {data && error ? (
                <p className="mb-2 text-xs text-warning" role="status">
                    {t('lastKnown', { reason: error.hint || t('loadFailed') })}
                </p>
            ) : null}
            {(data?.unreadable ?? []).map((entry) => (
                <p
                    key={`${entry.scope}:${entry.target}`}
                    className="mb-2 flex flex-wrap items-center gap-2 text-xs text-warning"
                    role="status"
                    data-testid="fleet-actions-jobs-unreadable"
                >
                    {t('unreadable', { target: entry.target, reason: entry.reason })}
                    {entry.grantUrl ? (
                        <a
                            href={entry.grantUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary underline"
                        >
                            {t('grantAccess')}
                            <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                    ) : null}
                </p>
            ))}
            {highlightGone ? (
                <p className="mb-2 text-xs text-text-muted dark:text-text-muted-dark" role="status">
                    {t('highlightGone')}
                </p>
            ) : null}

            {!data ? (
                <p className="text-danger" role="alert">
                    {error?.hint || t('loadFailed')}
                </p>
            ) : jobs.length === 0 ? (
                <p
                    className="flex flex-wrap items-center gap-x-2"
                    data-testid="fleet-actions-jobs-empty"
                >
                    <span>{t('empty')}</span>
                    <span aria-hidden>·</span>
                    {watchingLine}
                </p>
            ) : (
                <>
                    <ul aria-label={t('listLabel')}>
                        {jobs.map((job) => (
                            <ActionsJobRow
                                key={actionsJobKey(job)}
                                job={job}
                                highlighted={isHighlightedJob(job, highlight)}
                                canCancel={data.canCancel}
                                paused={killSwitch}
                                busy={
                                    action.isPending &&
                                    action.busyKey === `${job.repository}#${job.runId}`
                                }
                                onCancel={cancel}
                            />
                        ))}
                    </ul>
                    <p className="mt-2 text-xs">{watchingLine}</p>
                </>
            )}

            {data ? (
                <p
                    className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-actions-jobs-checked"
                >
                    {checked ? t('checked', { time: checked }) : t('notChecked')}
                    {data.rateLimitedUntil ? (
                        <span
                            className="text-warning"
                            data-testid="fleet-actions-jobs-rate-limited"
                        >
                            {' · '}
                            {next ? t('rateLimited', { time: next }) : t('rateLimitedWait')}
                        </span>
                    ) : null}
                </p>
            ) : null}

            {data ? (
                <WatchedTargetsEditor
                    open={editing}
                    watched={data.watched}
                    saved={data.watchedSaved}
                    available={data.available}
                    onClose={() => setEditing(false)}
                    onSaved={() => void refresh()}
                />
            ) : null}
            <ConfirmActionDialog
                model={action.dialog}
                actionLabel={action.actionLabel}
                pending={action.isPending}
                onConfirm={action.confirm}
                onCancel={action.cancel}
            />
        </section>
    );
}
