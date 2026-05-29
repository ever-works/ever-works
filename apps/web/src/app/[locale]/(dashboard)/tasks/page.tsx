import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ListChecks, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
            <TasksList tasks={result.data} />
        </div>
    );
}
