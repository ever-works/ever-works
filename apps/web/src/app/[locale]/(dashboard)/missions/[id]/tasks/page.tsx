import type { Metadata } from 'next';
import { tasksAPI, type Task } from '@/lib/api/tasks';
import { TasksScopedSection } from '@/components/tasks/TasksScopedSection';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Tasks feature — Phase 14.4 partial. Tasks tab under
 * /missions/[id]/tasks. Filters the global list by `missionId`.
 *
 * The Mission detail page currently lives as a single-column body
 * (`missions/[id]/page.tsx` — Phase 6 PR Q). Phase 14.4 calls for
 * a proper MissionTabs.tsx strip with an Overview tab wrapping the
 * existing single-column body + new Tasks tab. That extraction
 * lands once the shared work-detail layout primitive is reused for
 * Mission scope — for v1 this Tasks page works as a direct route
 * (linkable from the Mission card) and the layout migration is a
 * follow-up sub-tick.
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
