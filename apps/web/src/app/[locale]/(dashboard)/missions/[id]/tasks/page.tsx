import type { Metadata } from 'next';
import { tasksAPI, type Task } from '@/lib/api/tasks';
import { TasksScopedSection } from '@/components/tasks/TasksScopedSection';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Tasks feature — Phase 14.4. Tasks tab under
 * /missions/[id]/tasks. Filters the global list by `missionId`.
 *
 * The MissionTabs strip is mounted by `missions/[id]/layout.tsx`
 * (tick 38), so Overview and Tasks both inherit the navigation
 * automatically — this page only needs to render its Tasks content.
 */
export default async function MissionTasksTabPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const result = await tasksAPI
        .list({ missionId: id, limit: 100 })
        .catch(() => ({ data: [] as Task[], meta: { total: 0, limit: 100, offset: 0 } }));
    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <TasksScopedSection tasks={result.data} scopeLabel="Mission" />
        </div>
    );
}
