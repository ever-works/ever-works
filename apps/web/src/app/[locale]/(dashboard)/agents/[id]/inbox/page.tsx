import { emailAddressesAPI } from '@/lib/api/email-addresses';
import { AgentInboxPanel } from '@/components/agents/AgentInboxPanel';
import { AgentEmailSendPolicyPanel } from '@/components/agents/AgentEmailSendPolicyPanel';

/**
 * EW-650 / EW-680 — Per-Agent inbox tab page.
 *
 * Agent email (AW-05) adds the Agent's sending policy (approval mode, send
 * limits, live usage) and its address assignments above the message list.
 * Each read degrades on its own: a failed policy read hides only that panel,
 * never the messages.
 */
export default async function AgentInboxPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const [messages, policy, assignments, addresses] = await Promise.all([
        emailAddressesAPI
            .listMessagesForAgent(id, 50, 0)
            .catch(() => [] as Awaited<ReturnType<typeof emailAddressesAPI.listMessagesForAgent>>),
        emailAddressesAPI.getAgentSendPolicy(id).catch(() => null),
        emailAddressesAPI
            .listAgentAssignments(id)
            .catch(() => [] as Awaited<ReturnType<typeof emailAddressesAPI.listAgentAssignments>>),
        emailAddressesAPI
            .list()
            .catch(() => [] as Awaited<ReturnType<typeof emailAddressesAPI.list>>),
    ]);
    return (
        <div className="space-y-6">
            <AgentInboxPanel agentId={id} initialMessages={messages} />
            <AgentEmailSendPolicyPanel
                agentId={id}
                initialPolicy={policy}
                initialAssignments={assignments}
                addresses={addresses.map((address) => ({
                    id: address.id,
                    address: address.address,
                    direction: address.direction,
                }))}
            />
        </div>
    );
}
