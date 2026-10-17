'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Hammer, RefreshCw } from 'lucide-react';
import type { AppBuildSummary } from '@ever-works/contracts';
import { cancelAppBuildAction, listAppBuildsAction } from '@/app/actions/dashboard/app-builds';
import { Button } from '@/components/ui/button';
import {
    appBuildMessageParams,
    appBuildRefusalMessage,
    appBuildsPollInterval,
    appBuildTriggerKey,
    formatAppBuildDuration,
    isAppBuildActive,
    shortDigest,
    shortSha,
    upsertAppBuild,
    type AppBuildsList as AppBuildsListData,
    type AppBuildsListState,
} from '@/lib/works/app-builds.shared';
import { AppBuildStatusChip } from './AppBuildStatusChip';
import { AppBuildBlockedNotice } from './AppBuildBlockedNotice';
import { AppBuildDrawer } from './AppBuildDrawer';
import { useStartAppBuild } from './use-start-app-build';

/**
 * APW-05 T26 — the Builds tab: header with **Start build**, the list, and the
 * drawer (spec §6.1).
 *
 * First paint comes from the server page. While any listed Build is `queued` or
 * `running` the list re-reads every 5 s, every 30 s otherwise, and the timer is
 * torn down on unmount. A failed poll keeps the rows on screen — a flaky read
 * must not blank a list the member is looking at. A list route that answers
 * `404` (the Builds controller is not deployed on this instance yet) renders a
 * calm empty state with no action instead of an error.
 */
export interface AppBuildsListProps {
    workId: string;
    initialState: AppBuildsListState;
    canEdit: boolean;
}

export function AppBuildsList({ workId, initialState, canEdit }: AppBuildsListProps) {
    const t = useTranslations('dashboard.workDetail.builds');
    const [state, setState] = useState<AppBuildsListState>(initialState);
    const [tick, setTick] = useState(0);
    const [openBuild, setOpenBuild] = useState<AppBuildSummary | null>(null);
    const [cancelling, setCancelling] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const mounted = useRef(true);
    const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const refresh = useCallback(async () => {
        try {
            const result = await listAppBuildsAction(workId);
            if (!mounted.current) return;
            if (result.success && result.data) {
                const list: AppBuildsListData = result.data;
                setState({ kind: 'ok', list });
                // Keep the open drawer in step with its row.
                setOpenBuild((current) =>
                    current
                        ? (list.items.find((entry) => entry.id === current.id) ?? current)
                        : null,
                );
            } else if (result.statusCode === 404) {
                setState({ kind: 'unavailable' });
            }
        } catch {
            // A failed poll keeps what is on screen.
        } finally {
            if (mounted.current) setTick((n) => n + 1);
        }
    }, [workId]);

    const items = state.kind === 'ok' ? state.list.items : null;
    const interval = items ? appBuildsPollInterval(items) : null;

    useEffect(() => {
        if (interval === null) return;
        const timer = setTimeout(() => {
            void refresh();
        }, interval);
        return () => clearTimeout(timer);
    }, [interval, tick, refresh]);

    const { start, starting } = useStartAppBuild({
        workId,
        canEdit,
        onStarted: async (build) => {
            if (build) {
                setState((current) =>
                    current.kind === 'ok'
                        ? { kind: 'ok', list: upsertAppBuild(current.list, build) }
                        : current,
                );
            }
            await refresh();
        },
    });

    const cancel = async (build: AppBuildSummary) => {
        if (!canEdit || cancelling) return;
        setCancelling(build.id);
        try {
            const result = await cancelAppBuildAction(workId, build.id);
            if (result.success) {
                toast.success(t('toasts.cancelled'));
                if (result.data?.build) {
                    const updated = result.data.build;
                    setState((current) =>
                        current.kind === 'ok'
                            ? { kind: 'ok', list: upsertAppBuild(current.list, updated) }
                            : current,
                    );
                }
                await refresh();
            } else {
                const refusal = appBuildRefusalMessage(result);
                toast.error(
                    t(
                        refusal.key === 'errors.startFailed' ? 'errors.cancelFailed' : refusal.key,
                        refusal.values,
                    ),
                );
            }
        } finally {
            if (mounted.current) setCancelling(null);
        }
    };

    const onManualRefresh = async () => {
        setRefreshing(true);
        try {
            await refresh();
        } finally {
            if (mounted.current) setRefreshing(false);
        }
    };

    // `↑` / `↓` move between rows; `Enter` opens the drawer (the row is a button).
    const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const rows = rowRefs.current.filter((row): row is HTMLButtonElement => Boolean(row));
        const index = rows.findIndex((row) => row === document.activeElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    };

    const list = state.kind === 'ok' ? state.list : null;
    const subtitle = list?.repository
        ? list.imageRepository
            ? t('subtitle', {
                  repository: list.repository.fullName,
                  imageRepository: list.imageRepository,
              })
            : t('subtitleNoImage', { repository: list.repository.fullName })
        : t('subtitleGeneric');

    return (
        <div className="space-y-4" data-testid="app-builds-list">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {subtitle}
                    </p>
                </div>
                {state.kind !== 'unavailable' && (
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={onManualRefresh}
                            loading={refreshing}
                        >
                            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('refresh')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            onClick={() => start()}
                            disabled={!canEdit || starting}
                            loading={starting}
                            title={canEdit ? undefined : t('viewerDisabled')}
                            data-testid="app-build-start"
                        >
                            <Hammer className="h-3.5 w-3.5" aria-hidden="true" />
                            {starting ? t('starting') : t('startBuild')}
                        </Button>
                    </div>
                )}
            </div>

            {state.kind === 'unavailable' && (
                <p
                    className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary dark:border-border-dark dark:text-text-secondary-dark"
                    data-testid="app-builds-unavailable"
                >
                    {t('empty.unavailable')}
                </p>
            )}

            {state.kind === 'error' && (
                <p
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"
                    data-testid="app-builds-error"
                >
                    {t('errors.loadFailed')}
                </p>
            )}

            {list && list.items.length === 0 && (
                <p
                    className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary dark:border-border-dark dark:text-text-secondary-dark"
                    data-testid="app-builds-empty"
                >
                    {t('empty.noBuilds')}
                </p>
            )}

            {list && list.items.length > 0 && (
                <>
                    <ul
                        aria-label={t('listLabel')}
                        aria-live="polite"
                        onKeyDown={onListKeyDown}
                        className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card dark:divide-border-dark dark:border-border-dark dark:bg-transparent"
                    >
                        {list.items.map((build, index) => (
                            <li
                                key={build.id}
                                className="px-3 py-2"
                                data-testid={`app-build-row-${build.id}`}
                            >
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <button
                                        type="button"
                                        ref={(element) => {
                                            rowRefs.current[index] = element;
                                        }}
                                        onClick={() => setOpenBuild(build)}
                                        aria-label={t('openDetails', { number: build.number })}
                                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                    >
                                        <AppBuildStatusChip status={build.status} />
                                        <span className="font-medium text-text dark:text-text-dark">
                                            #{build.number}
                                        </span>
                                        <span className="text-text-secondary dark:text-text-secondary-dark">
                                            {t(`trigger.${appBuildTriggerKey(build.trigger)}`, {
                                                number: build.pullRequestNumber ?? '',
                                            })}
                                        </span>
                                        <span className="text-text-secondary dark:text-text-secondary-dark">
                                            {build.branch}
                                        </span>
                                        <code className="font-mono text-xs text-text-secondary dark:text-text-secondary-dark">
                                            {shortSha(build.commitSha)}
                                        </code>
                                        {build.durationSeconds !== null && (
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {formatAppBuildDuration(build.durationSeconds)}
                                            </span>
                                        )}
                                        {build.status === 'succeeded' && build.imageDigest && (
                                            <code className="font-mono text-xs text-text-muted dark:text-text-muted-dark">
                                                {shortDigest(build.imageDigest)}
                                            </code>
                                        )}
                                        {build.status === 'failed' && build.failureClass && (
                                            <span className="text-xs text-red-700 dark:text-red-300">
                                                {t(
                                                    `failure.${build.failureClass}.title`,
                                                    appBuildMessageParams(),
                                                )}
                                            </span>
                                        )}
                                        {build.deployable && (
                                            <span
                                                className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
                                                data-testid="app-build-deployable"
                                            >
                                                {t('deployable')}
                                            </span>
                                        )}
                                    </button>
                                    {isAppBuildActive(build.status) && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => void cancel(build)}
                                            disabled={!canEdit || cancelling !== null}
                                            title={canEdit ? undefined : t('viewerDisabled')}
                                        >
                                            {cancelling === build.id
                                                ? t('cancelling')
                                                : t('cancel')}
                                        </Button>
                                    )}
                                </div>
                                {build.status === 'succeeded' &&
                                    !build.deployable &&
                                    build.notDeployableReason && (
                                        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('notDeployableLine', {
                                                reason: t(
                                                    `notDeployable.${build.notDeployableReason}`,
                                                ),
                                            })}
                                        </p>
                                    )}
                                {build.status === 'blocked' && (
                                    <div className="mt-1">
                                        <AppBuildBlockedNotice
                                            workId={workId}
                                            build={build}
                                            canEdit={canEdit}
                                            workflowPullRequestUrl={list.workflow.pullRequestUrl}
                                            repositoryFullName={list.repository?.fullName ?? null}
                                            onRebuild={() => start()}
                                        />
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                    {list.total > list.items.length && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('pagination', {
                                start: (list.page - 1) * list.pageSize + 1,
                                end: (list.page - 1) * list.pageSize + list.items.length,
                                total: list.total,
                            })}
                        </p>
                    )}
                </>
            )}

            <AppBuildDrawer
                workId={workId}
                build={openBuild}
                onClose={() => setOpenBuild(null)}
                canEdit={canEdit}
                workflowPullRequestUrl={list?.workflow.pullRequestUrl ?? null}
                repositoryFullName={list?.repository?.fullName ?? null}
                onRebuild={(commitSha) => start(commitSha)}
            />
        </div>
    );
}
