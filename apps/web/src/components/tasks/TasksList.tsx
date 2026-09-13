'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type {
    Task,
    TaskBoardQuery,
    TaskBoardResult,
    TaskStatus,
    TaskPriority,
} from '@/lib/api/tasks';
import type { TaskScopeRef } from '@/lib/api/tasks.shared';
import { getTaskBoardColumnAction } from '@/app/actions/tasks';
import { tasksViewCookie, type TasksView } from '@/lib/tasks-view';
import {
    TasksKanbanEmptyNotice,
    TasksKanbanErrorPanel,
    TasksKanbanSkeleton,
    TasksKanbanView,
} from './TasksKanbanView';
import { TaskScopeRowMenu } from './TaskScopeRowMenu';
import { LayoutGrid, Table2, Kanban, type LucideIcon } from 'lucide-react';

const STATUS_TONES: Record<TaskStatus, string> = {
    backlog: 'bg-surface-secondary text-text-secondary',
    todo: 'bg-info/10 text-info',
    in_progress: 'bg-warning/10 text-warning',
    in_review: 'bg-warning/10 text-warning',
    blocked: 'bg-danger/10 text-danger',
    done: 'bg-success/10 text-success',
    cancelled: 'bg-text-muted/10 text-text-muted',
};

const PRIORITY_TONES: Record<TaskPriority, string> = {
    p0: 'bg-danger/20 text-danger',
    p1: 'bg-danger/10 text-danger',
    p2: 'bg-warning/10 text-warning',
    p3: 'bg-surface-secondary text-text-secondary',
    p4: 'bg-text-muted/10 text-text-muted',
};

const STATUS_DOT: Record<TaskStatus, string> = {
    backlog: 'bg-slate-400',
    todo: 'bg-info',
    in_progress: 'bg-warning',
    in_review: 'bg-violet-500',
    blocked: 'bg-danger',
    done: 'bg-success',
    cancelled: 'bg-text-muted',
};

// Labels are message keys under `dashboard.tasksPage`. The board tab keeps
// its long-standing "Kanban" label (`list.kanban`, already translated), so the
// control users know is unchanged.
const VIEW_TABS = [
    { key: 'cards', icon: LayoutGrid, labelKey: 'board.viewCards' },
    { key: 'table', icon: Table2, labelKey: 'board.viewTable' },
    { key: 'board', icon: Kanban, labelKey: 'list.kanban' },
] as const satisfies ReadonlyArray<{ key: TasksView; icon: LucideIcon; labelKey: string }>;

type ViewKey = TasksView;

// Pill names come from the already-translated `status.*` catalogue.
const STATUS_FILTERS: (TaskStatus | 'all')[] = [
    'all',
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
];

/**
 * What the `/tasks` page hands the list when it renders the board from the
 * server's column read.
 */
export interface TasksListBoardData {
    /** The board read, or `null` when it failed (the error panel renders). */
    result: TaskBoardResult | null;
    /** The query that produced it — reused verbatim to page one column. */
    query: TaskBoardQuery;
    /** A filter is active, so an empty board means "no matches", not "no Tasks". */
    filtersActive: boolean;
    /** `/tasks` with the same filters in the Table view — the error panel's way out. */
    tableHref: string;
}

export function TasksList({
    tasks,
    enableStatusFilter = true,
    scope,
    view: serverView,
    board,
}: {
    tasks: Task[];
    enableStatusFilter?: boolean;
    /**
     * Set only when this list IS a scope's tab. Turns on the per-row
     * "remove from this scope" action; omitted on the global /tasks page,
     * where a Task belongs to no list in particular and there would be
     * nothing to remove it from.
     */
    scope?: TaskScopeRef;
    /**
     * The view the server resolved from `?view=` or the remembered choice.
     * When set, the view switcher writes the URL (and remembers the choice)
     * instead of local state, so the page can fetch what the new view needs.
     * Omitted (the scoped lists): the switcher is local state, as before.
     */
    view?: ViewKey;
    /** The server's board read — present when the page resolved the board view. */
    board?: TasksListBoardData;
}) {
    const t = useTranslations('dashboard.tasksPage');
    const urlDriven = serverView !== undefined;
    const [localView, setLocalView] = useState<ViewKey>('cards');
    // URL-driven: the chosen tab presses at once while the page re-renders
    // with the data the new view needs. Remembered against the server view it
    // was chosen from, so it lapses by itself once any new server view lands.
    const [pending, setPending] = useState<{ from: ViewKey | undefined; to: ViewKey } | null>(null);
    const [, startViewTransition] = useTransition();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');

    const pendingView = pending && pending.from === serverView ? pending.to : null;
    const view: ViewKey = urlDriven ? (pendingView ?? serverView) : localView;
    // Between a click and the server render that carries the new view's data.
    const awaitingData = urlDriven && pendingView !== null && pendingView !== serverView;

    const selectView = useCallback(
        (next: ViewKey) => {
            if (!urlDriven) {
                setLocalView(next);
                return;
            }
            try {
                document.cookie = tasksViewCookie(next, {
                    secure: window.location.protocol === 'https:',
                });
            } catch {
                // Cookies unavailable — the URL still carries the view.
            }
            if (next === serverView) {
                setPending(null);
                return;
            }
            setPending({ from: serverView, to: next });
            const params = new URLSearchParams(searchParams?.toString() ?? '');
            params.set('view', next);
            // Offset paging belongs to the list views; the board pages per column.
            params.delete('offset');
            startViewTransition(() => {
                router.replace(`${pathname}?${params.toString()}`, { scroll: false });
            });
        },
        [urlDriven, serverView, searchParams, pathname, router],
    );

    const serverBoard = urlDriven && serverView === 'board' && board !== undefined;
    const boardResult = board?.result ?? null;
    const boardTasks = useMemo(
        () => (boardResult ? boardResult.columns.flatMap((column) => column.cards) : []),
        [boardResult],
    );
    const boardTotals = useMemo(
        () =>
            boardResult
                ? (Object.fromEntries(
                      boardResult.columns.map((column) => [column.key, column.total]),
                  ) as Partial<Record<TaskStatus, number>>)
                : undefined,
        [boardResult],
    );
    const boardFailedStatuses = useMemo(
        () =>
            boardResult
                ? (boardResult.columns
                      .filter((column) => column.failed)
                      .map((column) => column.key) as TaskStatus[])
                : [],
        [boardResult],
    );
    const boardGrandTotal = boardResult
        ? boardResult.columns.reduce((sum, column) => sum + column.total, 0)
        : 0;
    const boardQuery = board?.query;
    const loadBoardColumn = useCallback(
        async (status: TaskStatus, offset: number) => {
            if (!boardQuery) return null;
            const page = await getTaskBoardColumnAction(boardQuery, status, offset);
            return page.ok ? { total: page.column.total, cards: page.column.cards } : null;
        },
        [boardQuery],
    );

    const filtered = useMemo(
        () =>
            !enableStatusFilter || statusFilter === 'all'
                ? tasks
                : tasks.filter((t) => t.status === statusFilter),
        [enableStatusFilter, tasks, statusFilter],
    );

    return (
        <div className="space-y-4">
            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 @sm/main:flex-row @sm/main:items-center @sm/main:justify-between">
                {/* View mode segmented control */}
                <div className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-0.5 self-start">
                    {VIEW_TABS.map(({ key, icon: Icon, labelKey }) => {
                        const label = t(labelKey);
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => selectView(key)}
                                aria-pressed={view === key}
                                title={label}
                                className={cn(
                                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                                    view === key
                                        ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                        : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark',
                                )}
                            >
                                <Icon className="w-3.5 h-3.5 shrink-0" />
                                <span className="hidden @xs/main:inline">{label}</span>
                            </button>
                        );
                    })}
                </div>

                {/* Count badge — the board counts every Task on it (true
                    totals when the server read it), so only the list-level
                    filter ratio is meaningful in cards/table. */}
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark bg-card dark:bg-card-primary-dark self-start @sm/main:self-auto">
                    {view === 'board' && serverBoard
                        ? boardGrandTotal
                        : view === 'board' || !enableStatusFilter
                          ? tasks.length
                          : `${filtered.length} / ${tasks.length}`}
                </span>
            </div>

            {/* ── Status filter pills ──────────────────────────────────────── */}
            {/* Hidden on the board — the columns already group by status, so
                the pills would just empty most columns when one is selected. */}
            {view !== 'board' && enableStatusFilter && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                    {STATUS_FILTERS.map((key) => {
                        const isActive = statusFilter === key;
                        const label = key === 'all' ? t('list.filter.all') : t(`status.${key}`);
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setStatusFilter(key)}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border whitespace-nowrap transition-colors shrink-0',
                                    isActive
                                        ? 'border-border dark:border-border-dark bg-white dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                        : 'border-border/60 dark:border-border-dark/60 text-text-muted dark:text-text-muted-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {key !== 'all' && (
                                    <span
                                        className={cn(
                                            'w-1.5 h-1.5 rounded-full shrink-0',
                                            STATUS_DOT[key as TaskStatus],
                                        )}
                                    />
                                )}
                                {label}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* ── Content ─────────────────────────────────────────────────── */}
            {awaitingData ? (
                view === 'board' ? (
                    <TasksKanbanSkeleton />
                ) : (
                    <div
                        aria-busy="true"
                        className="h-40 rounded-xl border border-border/60 dark:border-border-dark/60 bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 animate-pulse"
                    />
                )
            ) : view === 'board' && serverBoard ? (
                boardResult ? (
                    <div className="space-y-4">
                        {boardGrandTotal === 0 && !board.filtersActive && (
                            <TasksKanbanEmptyNotice />
                        )}
                        <TasksKanbanView
                            tasks={boardTasks}
                            totals={boardTotals}
                            failedStatuses={boardFailedStatuses}
                            terminalWindowDays={boardResult.terminalWindowDays}
                            pageSize={boardResult.columnLimit}
                            loadColumn={loadBoardColumn}
                        />
                    </div>
                ) : (
                    <TasksKanbanErrorPanel tableHref={board.tableHref} />
                )
            ) : view === 'board' ? (
                // A plain list handed to the board — its own columns are the
                // status filter. The list-level `statusFilter` only governs
                // cards/table.
                <TasksKanbanView tasks={tasks} />
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-8 text-center">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {statusFilter === 'all'
                            ? t('empty.title')
                            : `${t('empty.title')} (${statusFilter.replace('_', ' ')})`}
                    </p>
                </div>
            ) : view === 'cards' ? (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {filtered.map((t) => (
                        <TaskCard key={t.id} task={t} scope={scope} />
                    ))}
                </div>
            ) : (
                <TaskTable tasks={filtered} scope={scope} />
            )}
        </div>
    );
}

function TaskCard({ task, scope }: { task: Task; scope?: TaskScopeRef }) {
    const t = useTranslations('dashboard.tasksPage');
    const card = (
        <Link
            href={ROUTES.DASHBOARD_TASK(task.id)}
            className="block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-border transition-colors"
        >
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-text-muted">
                <span>{task.slug}</span>
                <span
                    className={`uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[task.priority]}`}
                >
                    {task.priority}
                </span>
            </div>
            <h3 className="text-sm font-semibold text-text dark:text-text-dark mt-2 truncate">
                {task.title}
            </h3>
            {task.description ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 line-clamp-2">
                    {task.description}
                </p>
            ) : (
                <p className="text-xs text-text-muted/70 dark:text-text-muted-dark/70 mt-1 italic">
                    {t('list.noDescription')}
                </p>
            )}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_TONES[task.status]}`}
                >
                    {task.status.replace('_', ' ')}
                </span>
                {(task.labels ?? []).slice(0, 3).map((label) => (
                    <span
                        key={label}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                    >
                        {label}
                    </span>
                ))}
            </div>
        </Link>
    );

    if (!scope) return card;

    // The overflow menu is a SIBLING of the card link, never a child:
    // a <button> nested inside an <a> is invalid HTML and opening the
    // menu would navigate too. Bottom-right because the top-right corner
    // is already the priority badge.
    return (
        <div className="relative">
            {card}
            <TaskScopeRowMenu
                taskId={task.id}
                taskTitle={task.title}
                scopeKey={scope.key}
                scopeId={scope.id}
                className="absolute bottom-3 right-3"
            />
        </div>
    );
}

function TaskTable({ tasks, scope }: { tasks: Task[]; scope?: TaskScopeRef }) {
    const t = useTranslations('dashboard.tasksPage.scopedSection');
    return (
        <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
            <table className="w-full text-sm">
                <thead className="bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 text-xs text-text-secondary">
                    <tr>
                        <th className="text-left px-4 py-2.5 font-medium">Slug</th>
                        <th className="text-left px-4 py-2.5 font-medium">Title</th>
                        <th className="text-left px-4 py-2.5 font-medium">Status</th>
                        <th className="text-left px-4 py-2.5 font-medium">Priority</th>
                        <th className="text-left px-4 py-2.5 font-medium">Updated</th>
                        {scope && (
                            <th className="px-4 py-2.5 font-medium w-10">
                                <span className="sr-only">{t('rowMenuColumn')}</span>
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/60 dark:divide-border-dark/60">
                    {tasks.map((t) => (
                        <tr
                            key={t.id}
                            className="hover:bg-surface-secondary/30 dark:hover:bg-surface-secondary-dark/20 transition-colors"
                        >
                            <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                                {t.slug}
                            </td>
                            <td className="px-4 py-2.5">
                                <Link
                                    href={ROUTES.DASHBOARD_TASK(t.id)}
                                    className="text-text dark:text-text-dark hover:text-primary transition-colors"
                                >
                                    {t.title}
                                </Link>
                            </td>
                            <td className="px-4 py-2.5">
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded',
                                        STATUS_TONES[t.status],
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'w-1.5 h-1.5 rounded-full shrink-0',
                                            STATUS_DOT[t.status],
                                        )}
                                    />
                                    {t.status.replace('_', ' ')}
                                </span>
                            </td>
                            <td className="px-4 py-2.5">
                                <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[t.priority]}`}
                                >
                                    {t.priority}
                                </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-muted">
                                {new Date(t.updatedAt).toLocaleDateString()}
                            </td>
                            {scope && (
                                <td className="px-4 py-2.5">
                                    <TaskScopeRowMenu
                                        taskId={t.id}
                                        taskTitle={t.title}
                                        scopeKey={scope.key}
                                        scopeId={scope.id}
                                    />
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
