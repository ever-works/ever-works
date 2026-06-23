import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ListChecks, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { tasksAPI, type TaskPriority, type TaskStatus } from '@/lib/api/tasks';
import { TasksFilterSelects } from '@/components/tasks/TasksFilterSelects';
import { TasksList } from '@/components/tasks/TasksList';
import { PageHeader } from '@/components/common/PageHeader';
import { Link } from '@/i18n/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.tasksPage');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 12.6. Real `/tasks` list
 * page. Server-fetches the user's Tasks; client component handles
 * view toggle + filter UI. Kanban + per-target tabs land in Phase 14.
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
}): string {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.priority) params.set('priority', input.priority);
    if (input.search) params.set('search', input.search);
    if (input.label) params.set('label', input.label);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `${ROUTES.DASHBOARD_TASKS}?${qs}` : ROUTES.DASHBOARD_TASKS;
}

export default async function TasksPage({ searchParams }: { searchParams: TasksSearchParams }) {
    const t = await getTranslations('dashboard.tasksPage');
    const params = await searchParams;
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
    };
    const result = await tasksAPI.list(query);
    const nextOffset = result.meta.offset + result.meta.limit;
    const prevOffset = Math.max(0, result.meta.offset - result.meta.limit);
    const baseHrefInput = {
        status: query.status,
        priority: query.priority,
        search: query.search,
        label: query.label,
    };

    return (
        <div className="w-full">
            <PageHeader
                icon={ListChecks}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="task"
                actions={
                    <Button href={ROUTES.DASHBOARD_TASK_NEW} size="sm" className="gap-1.5 shrink-0">
                        <Plus className="w-3.5 h-3.5" />
                        {t('list.newTask')}
                    </Button>
                }
            />
            <form className="mb-4 flex flex-col gap-2 @lg/main:flex-row @lg/main:items-end">
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
            <TasksList tasks={result.data} enableStatusFilter={!query.status} />
            {result.meta.total > result.meta.limit && (
                <nav className="mt-5 flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    <span>
                        {t('list.pagination.showing', {
                            from: result.meta.offset + 1,
                            to: Math.min(
                                result.meta.offset + result.data.length,
                                result.meta.total,
                            ),
                            total: result.meta.total,
                        })}
                    </span>
                    <div className="flex items-center gap-2">
                        {result.meta.offset > 0 && (
                            <Link
                                href={buildTasksHref({ ...baseHrefInput, offset: prevOffset })}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                {t('list.pagination.previous')}
                            </Link>
                        )}
                        {nextOffset < result.meta.total && (
                            <Link
                                href={buildTasksHref({ ...baseHrefInput, offset: nextOffset })}
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
