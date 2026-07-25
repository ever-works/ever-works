import { agentsAPI } from '@/lib/api/agents';
import { AgentTerminalClient } from '@/components/terminal/AgentTerminalClient';

/**
 * Streaming-terminal M7 — Agent detail → Terminal tab.
 *
 * Server-fetches the recent runs once for the picker (the layout above
 * already 404-guarded the agent); everything live happens client-side
 * in the pane. Deep links select a run via `?run=<id>`.
 */
export default async function AgentTerminalPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ run?: string }>;
}) {
    const { id } = await params;
    const { run } = await searchParams;
    const runs = await agentsAPI
        .listRuns(id, { limit: 20 })
        .then((r) => r.data)
        .catch(() => []);

    return <AgentTerminalClient agentId={id} runs={runs} initialRunId={run ?? null} />;
}
