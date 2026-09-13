import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ListChecks, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import {
    tasksAPI,
    type Task,
    type TaskBoardQuery,
    type TaskBoardResult,
    type TaskPriority,
    type TaskStatus,
} from '@/lib/api/tasks';
import { resolveTasksView, TASKS_VIEW_COOKIE, type TasksView } from '@/lib/tasks-view';
import { TasksFilterSelects } from '@/components/tasks/TasksFilterSelects';
import { TasksList } from '@/components/tasks/TasksList';
import { TasksTabsNav } from '@/components/tasks/TasksTabsNav';
import { PageHeader } from '@/components/common/PageHeader';
import { Link } from '@/i18n/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.tasksPage');
    return { title: t('title') };
}

/**
 * `/tasks` — every Task the user owns, as Cards, a Table or the Task board.
 *
 * The view comes from `?view=`, then the browser's remembered choice, then
 * the default (`resolveTasksView`). Each view reads what it needs:
 *
 *  - Cards / Table read one offset-paged page of the list, as they always have.
 *  - The board reads each status column on its own (`tasksAPI.board`), so a
 *    column header is that column's TRUE total under the filters and a column
 *    pages without re-reading the others.
 *
 * The filter form below drives every view; it carries the view through a
 * hidden field, so applying a filter never drops the user out of the board.
 */
const TASK_STATUSES: TaskStatus[] = [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
];

const TASK_PRIORITIES: TaskPriority[] = ['p0', 'p1', 'p2', 'p3', 'p4'];

type TasksSearchParams = Promise<{
    status?: string;
    priority?: string;
    search?: string;
    label?: string;
    offset?: string;
    view?: string;
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function buildTasksHref(input: {
    status?: string;
    priority?: string;
    search?: string;
    label?: string;
    offset?: number;
    view?: TasksView;
}): string {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.priority) params.set('priority', input.priority);
    if (input.search) params.set('search', input.search);
    if (input.label) params.set('label', input.label);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    if (input.view) params.set('view', input.view);
    const qs = params.toString();
    return qs ? `${ROUTES.DASHBOARD_TASKS}?${qs}` : ROUTES.DASHBOARD_TASKS;
}

export default async function TasksPage({ searchParams }: { searchParams: TasksSearchParams }) {
    const t = await getTranslations('dashboard.tasksPage');
    const params = await searchParams;
    const cookieStore = await cookies();
    const view = resolveTasksView({
        url: firstParam(params.view),
        cookie: cookieStore.get(TASKS_VIEW_COOKIE)?.value,
    });
    const status = firstParam(params.status);
    const priority = firstParam(params.priority);
    const search = firstParam(params.search)?.trim();
    const label = firstParam(params.label)?.trim();
    const offset = Math.max(0, parseInt(firstParam(params.offset) ?? '0', 10) || 0);
    const limit = 50;
    const query = {
        status: TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : undefined,
        priority: TASK_PRIORITIES.includes(priority as TaskPriority)
            ? (priority as TaskPriority)
            : undefined,
        search: search || undefined,
        label: label || undefined,
        limit,
        offset,
        // Kanban run cockpit (Wave 2) — embed each row's latest AgentRun so
        // the board chips render on first paint (polling takes over after).
        includeRun: true,
    };
    const baseHrefInput = {
        status: query.status,
        priority: query.priority,
        search: query.search,
        label: query.label,
    };
    const filtersActive = Boolean(query.status || query.priority || query.search || query.label);

    // The board: true per-column totals. It carries sub-tasks and recurring
    // templates, exactly as the board always has, until the board grows the
    // toggles that let a user put them back.
    let boardResult: TaskBoardResult | null = null;
    const boardQuery: TaskBoardQuery = {
        status: query.status ? [query.status] : undefined,
        priority: query.priority,
        search: query.search,
        label: query.label,
        includeSubtasks: true,
        includeTemplates: true,
    };
    // The list views: one offset-paged page, unchanged.
    let listResult: {
        data: Task[];
        meta: { total: number; limit: number; offset: number };
    } | null = null;

    if (view === 'board') {
        try {
            boardResult = await tasksAPI.board(boardQuery);
        } catch {
            // Rendered as the board's error panel, under a still-usable page.
            boardResult = null;
        }
    } else {
        listResult = await tasksAPI.list(query);
    }

    const nextOffset = listResult ? listResult.meta.offset + listResult.meta.limit : 0;
    const prevOffset = listResult ? Math.max(0, listResult.meta.offset - listResult.meta.limit) : 0;

    return (
        <div className="w-full">
            <PageHeader
                icon={ListChecks}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="task"
                actions={
                    <>
                        {/* EW-058: first inbound link to the orphaned
                            /tasks/templates browser (route existed, nothing
                            linked to it). */}
                        <Button
                            href={ROUTES.DASHBOARD_TASK_TEMPLATES}
                            variant="secondary"
                            size="sm"
                            className="gap-1.5 shrink-0"
                        >
                            {t('list.browseTemplates')}
                        </Button>
                        <Button
                            href={ROUTES.DASHBOARD_TASK_NEW}
                            size="sm"
                            className="gap-1.5 shrink-0"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            {t('list.newTask')}
                        </Button>
                    </>
                }
            />
            <TasksTabsNav active="tasks" />
            <form className="mb-4 flex flex-col gap-2 @lg/main:flex-row @lg/main:items-end">
                {/* Applying a filter keeps the view the user is looking at. */}
                <input type="hidden" name="view" value={view} />
                <label className="flex-1 min-w-0">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('list.filter.search')}
                    </span>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted dark:text-text-muted-dark pointer-events-none" />
                        <input
                            name="search"
                            defaultValue={query.search ?? ''}
                            placeholder={t('list.filter.searchPlaceholder')}
                            className="w-full rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark pl-9 pr-4 py-2 h-9 text-xs text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark hover:border-border-secondary dark:hover:border-border-secondary-dark focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20 transition-colors outline-none"
                        />
                    </div>
                </label>
                <TasksFilterSelects
                    key={`${query.status ?? ''}-${query.priority ?? ''}`}
                    defaultStatus={query.status}
                    defaultPriority={query.priority}
                />
                <label className="min-w-36">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('list.filter.label')}
                    </span>
                    <input
                        name="label"
                        defaultValue={query.label ?? ''}
                        placeholder={t('list.filter.labelPlaceholder')}
                        className="w-full rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark px-4 py-2 h-9 text-xs text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark hover:border-border-secondary dark:hover:border-border-secondary-dark focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20 transition-colors outline-none"
                    />
                </label>
                <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                        {t('list.filter.apply')}
                    </Button>
                    <Button href={ROUTES.DASHBOARD_TASKS} size="sm" variant="ghost">
                        {t('list.filter.reset')}
                    </Button>
                </div>
            </form>
            <TasksList
                tasks={listResult?.data ?? []}
                enableStatusFilter={!query.status}
                view={view}
                board={
                    view === 'board'
                        ? {
                              result: boardResult,
                              query: boardQuery,
                              filtersActive,
                              tableHref: buildTasksHref({ ...baseHrefInput, view: 'table' }),
                          }
                        : undefined
                }
            />
            {listResult && listResult.meta.total > listResult.meta.limit && (
                <nav className="mt-5 flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    <span>
                        {t('list.pagination.showing', {
                            from: listResult.meta.offset + 1,
                            to: Math.min(
                                listResult.meta.offset + listResult.data.length,
                                listResult.meta.total,
                            ),
                            total: listResult.meta.total,
                        })}
                    </span>
                    <div className="flex items-center gap-2">
                        {listResult.meta.offset > 0 && (
                            <Link
                                href={buildTasksHref({
                                    ...baseHrefInput,
                                    offset: prevOffset,
                                    view,
                                })}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                {t('list.pagination.previous')}
                            </Link>
                        )}
                        {nextOffset < listResult.meta.total && (
                            <Link
                                href={buildTasksHref({
                                    ...baseHrefInput,
                                    offset: nextOffset,
                                    view,
                                })}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                {t('list.pagination.next')}
                            </Link>
                        )}
                    </div>
                </nav>
            )}
        </div>
    );
}
