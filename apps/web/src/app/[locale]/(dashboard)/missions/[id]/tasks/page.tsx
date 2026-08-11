import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { tasksAPI } from '@/lib/api/tasks';
import { missionsAPI } from '@/lib/api/missions';
import { TasksScopedSection } from '@/components/tasks/TasksScopedSection';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Tasks feature — Phase 14.4. Tasks tab under
 * /missions/[id]/tasks. Filters the global list by `missionId`.
 *
 * The MissionTabs strip is mounted by `missions/[id]/layout.tsx`
 * (tick 38), so Overview and Tasks both inherit the navigation
 * automatically — this page only needs to render its Tasks content.
 *
 * `id` is whatever the URL carried, so it is resolved against the
 * Mission itself BEFORE it is used as a task filter. Previously it went
 * straight into `tasksAPI.list`, which has no internal catch: the API
 * applies `ParseUUIDPipe` to `missionId`, so a malformed id produced a
 * 400 that escaped this Server Component and made the whole ROUTE answer
 * **HTTP 500** — while `/missions/[id]`, given the identical id, already
 * answered a clean 404. The layout fetches nothing, so nothing upstream
 * caught it either. A bad id in a URL is an ordinary client error; it
 * must render the not-found surface, not a server error.
 */
export default async function MissionTasksTabPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    // Mirrors `/missions/[id]`: resolve the Mission, 404 when it does not
    // resolve. `missionsAPI.get` maps every failure to null, so a
    // malformed id (400 from ParseUUIDPipe), an unknown id (404) and
    // another user's id (the endpoint is owner-scoped) all land here —
    // and all three are 404s, which is what the Overview tab of this very
    // same Mission already answers for them.
    const mission = await missionsAPI.get(id);

    if (!mission) {
        // Logged, not swallowed: an unresolvable id is a 404 the operator
        // should still be able to see in the logs. (`serverFetch` already
        // console.errors every non-404 API response, so a transient
        // failure behind this null is recorded too.)
        console.warn(
            `[missions/[id]/tasks] no Mission resolves for id "${id}" — rendering not-found`,
        );
        notFound();
    }

    // `id` is now a known, caller-owned Mission, so this cannot 400/404.
    // It stays uncaught on purpose: a rejection here is a real backend
    // failure and must reach the dashboard error boundary (which offers a
    // retry) rather than render as an empty Tasks tab — "the API is down"
    // and "this Mission has no tasks" must never look the same.
    const result = await tasksAPI.list({ missionId: id, limit: 100, includeRun: true });

    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <TasksScopedSection tasks={result.data} scopeLabel="Mission" scopeId={id} />
        </div>
    );
}
