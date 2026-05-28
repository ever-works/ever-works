import { emailAddressesAPI } from '@/lib/api/email-addresses';
import { AgentInboxPanel } from '@/components/agents/AgentInboxPanel';

/**
 * EW-650 / EW-680 — Per-Agent inbox tab page.
 */
export default async function AgentInboxPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    let messages: Awaited<ReturnType<typeof emailAddressesAPI.listMessagesForAgent>> = [];
    try {
        messages = await emailAddressesAPI.listMessagesForAgent(id, 50, 0);
    } catch {
        messages = [];
    }
    return <AgentInboxPanel agentId={id} initialMessages={messages} />;
}
