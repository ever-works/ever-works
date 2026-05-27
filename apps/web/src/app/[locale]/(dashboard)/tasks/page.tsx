import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ListChecks, Plus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { tasksAPI, type Task } from '@/lib/api/tasks';
import { TasksList } from '@/components/tasks/TasksList';
import { PageHeader } from '@/components/common/PageHeader';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.tasksPage');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 12.6. Real `/tasks` list
 * page. Server-fetches the user's Tasks; client component handles
 * view toggle + filter UI. Kanban + per-target tabs land in Phase 14.
 */
export default async function TasksPage() {
    const t = await getTranslations('dashboard.tasksPage');
    const result = await tasksAPI
        .list({ limit: 50 })
        .catch(() => ({ data: [] as Task[], meta: { total: 0, limit: 50, offset: 0 } }));

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            <PageHeader
                icon={ListChecks}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="info"
                actions={
                    <Link
                        href={ROUTES.DASHBOARD_TASK_NEW}
                        className={cn(
                            'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors shrink-0 px-3 py-2 text-sm',
                            'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark rounded-sm',
                        )}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('list.newTask')}
                    </Link>
                }
            />
            <TasksList tasks={result.data} />
        </div>
    );
}
