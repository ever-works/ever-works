import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentActivityClient } from '@/components/agents/AgentActivityClient';

type Params = Promise<{ id: string; locale: string }>;
type Search = Promise<{ run?: string }>;

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-4.
 *
 * Per-Agent activity feed. Server-fetches the most recent runs via
 * `agentsAPI.listRuns()` (paginated by the FU-2 endpoint added on the
 * api-side controller) and renders the compact list with event-type
 * chips + cancel affordance for queued/running rows.
 *
 * `?run=<id>` focuses one run — the deep link the "View logs" affordance
 * on a failed Task run uses. Read here rather than with `useSearchParams`
 * in the client so the page keeps its server-rendered shell instead of
 * bailing out to CSR.
 */
export default async function AgentActivityPage({
    params,
    searchParams,
}: {
    params: Params;
    searchParams?: Search;
}) {
    const { id } = await params;
    const { run: focusRunId } = (await searchParams) ?? {};
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    // Lifecycle events (paused / resumed / …) are few per Agent — one
    // 100-row page covers the interleaved timeline across run pages.
    const [initial, initialEvents] = await Promise.all([
        agentsAPI
            .listRuns(id, { limit: 25, offset: 0 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 25, offset: 0 } })),
        agentsAPI
            .listEvents(id, { limit: 100, offset: 0 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 100, offset: 0 } })),
    ]);

    return (
        <AgentActivityClient
            agentId={id}
            initial={initial}
            initialEvents={initialEvents.data}
            focusRunId={focusRunId ?? null}
        />
    );
}
