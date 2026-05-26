import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ListChecks, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { tasksAPI, type Task } from '@/lib/api/tasks';
import { TasksList } from '@/components/tasks/TasksList';

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
            <div className="flex items-start justify-between gap-3 mb-6">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                        <ListChecks className="w-4 h-4 text-info" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h1>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
                <Button asChild size="sm" className="gap-1.5 shrink-0">
                    <Link href={ROUTES.DASHBOARD_TASK_NEW}>
                        <Plus className="w-3.5 h-3.5" />
                        New Task
                    </Link>
                </Button>
            </div>
            <TasksList tasks={result.data} />
        </div>
    );
}
