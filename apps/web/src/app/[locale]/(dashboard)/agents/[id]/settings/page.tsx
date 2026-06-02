import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentSettingsClient } from '@/components/agents/AgentSettingsClient';

export default async function AgentSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    return <AgentSettingsClient agent={agent} />;
}
