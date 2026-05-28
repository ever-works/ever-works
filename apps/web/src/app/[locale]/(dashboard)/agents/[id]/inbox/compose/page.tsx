import { Composer } from '@/components/agents/Composer';

/**
 * EW-680 / T32 — Per-Agent inbox composer page.
 */
export default async function AgentInboxComposePage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return <Composer agentId={id} />;
}
