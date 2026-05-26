import type { Metadata } from 'next';
import { tasksAPI, type Task } from '@/lib/api/tasks';
import { TasksScopedSection } from '@/components/tasks/TasksScopedSection';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Tasks feature — Phase 14.3. Tasks tab under /works/[id]/tasks.
 * Filters the global list by `workId`. Inherits the WorkLayout's
 * tab strip + WorkDetailContext so the work's header/sidebar are
 * shared automatically.
 *
 * The shared work-detail layout already mounts under
 * `/works/[id]/layout.tsx`; this page slots in as a sibling of
 * `items` / `kb` / `generator`. No tab-array registration needed
 * — the layout reads route segments dynamically.
 */
export default async function WorkTasksTabPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const result = await tasksAPI
        .list({ workId: id, limit: 100 })
        .catch(() => ({ data: [] as Task[], meta: { total: 0, limit: 100, offset: 0 } }));
    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <TasksScopedSection tasks={result.data} scopeLabel="Work" />
        </div>
    );
}
