import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { tasksAPI } from '@/lib/api/tasks';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { ApiResponseError } from '@/lib/api/server-api';
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
 *
 * `id` is whatever the URL carried, so it is resolved against the Idea
 * itself BEFORE it is used as a task filter. Previously it went straight
 * into `tasksAPI.list`, which has no internal catch: the API applies
 * `ParseUUIDPipe` to `ideaId`, so a malformed id produced a 400 that
 * escaped this Server Component and made the whole ROUTE answer
 * **HTTP 500** — while `/ideas/[id]`, given the identical id, already
 * answered a clean 404. A bad id in a URL is an ordinary client error;
 * it must render the not-found surface, not a server error.
 */
export default async function IdeaTasksTabPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    // Mirrors `/ideas/[id]`: resolve the Idea, 404 when it does not
    // resolve. `workProposalsAPI.get` already maps 404 (no such Idea)
    // and 403 (not the caller's Idea) to null; it deliberately rethrows
    // everything else so a transient outage is never mistaken for "the
    // Idea vanished". A 400 is neither — it is a malformed id, i.e. a
    // definitively unresolvable Idea — so it joins the not-found path
    // here rather than propagating as a 500.
    const idea = await workProposalsAPI.get(id).catch((error: unknown) => {
        if (error instanceof ApiResponseError && error.statusCode === 400) {
            return null;
        }
        throw error;
    });

    if (!idea) {
        // Logged, not swallowed: an unresolvable id is a 404 the operator
        // should still be able to see in the logs. (`serverFetch` already
        // console.errors every non-404 API response, so the underlying
        // 400/403 is recorded too.)
        console.warn(`[ideas/[id]/tasks] no Idea resolves for id "${id}" — rendering not-found`);
        notFound();
    }

    // `id` is now a known, caller-owned Idea, so this cannot 400/403/404.
    // It stays uncaught on purpose: a rejection here is a real backend
    // failure and must reach the dashboard error boundary (which offers a
    // retry) rather than render as an empty Tasks tab — "the API is down"
    // and "this Idea has no tasks" must never look the same.
    const result = await tasksAPI.list({ ideaId: id, limit: 100, includeRun: true });

    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <TasksScopedSection tasks={result.data} scopeLabel="Idea" scopeId={id} />
        </div>
    );
}
