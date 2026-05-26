import type { Metadata } from 'next';
import { tasksAPI, type Task } from '@/lib/api/tasks';
import { TasksScopedSection } from '@/components/tasks/TasksScopedSection';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Tasks feature — Phase 14.5 partial. Tasks tab under
 * /ideas/[id]/tasks. Filters the global list by `ideaId`.
 *
 * The spec calls for a per-card expansion drawer on the Idea side
 * for v1 instead of full pages — but the route is reserved so
 * deep-links from notifications / chat mentions resolve cleanly.
 * The drawer surface lands once the shared expansion-drawer
 * primitive is extracted from the Idea card.
 */
export default async function IdeaTasksTabPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const result = await tasksAPI
        .list({ ideaId: id, limit: 100 })
        .catch(() => ({ data: [] as Task[], meta: { total: 0, limit: 100, offset: 0 } }));
    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <TasksScopedSection tasks={result.data} scopeLabel="Idea" />
        </div>
    );
}
