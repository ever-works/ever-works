import { notFound } from 'next/navigation';
import { emailAddressesAPI } from '@/lib/api/email-addresses';
import { MessageDetail } from '@/components/agents/MessageDetail';

/**
 * EW-680 / T31 — Per-Agent inbox message detail page.
 */
export default async function AgentInboxMessagePage({
    params,
}: {
    params: Promise<{ id: string; messageId: string }>;
}) {
    const { id, messageId } = await params;
    const message = await emailAddressesAPI.getMessage(messageId).catch(() => notFound());
    return <MessageDetail agentId={id} message={message} />;
}
