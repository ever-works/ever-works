'use client';

import type { EmailMessageListItem } from '@/lib/api/email-addresses';

interface Props {
    agentId: string;
    initialMessages: EmailMessageListItem[];
}

/**
 * EW-650 / EW-680 — Per-Agent Inbox panel UI shell.
 *
 * v0: paginated list view rendered server-side from the initial fetch.
 * SSE live-stream + message detail drawer + composer land in follow-up
 * ticks.
 */
export function AgentInboxPanel({ agentId, initialMessages }: Props) {
    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">Inbox</h1>
                    <p className="text-sm text-muted-foreground">
                        Inbound + outbound email for this agent. {initialMessages.length} message
                        {initialMessages.length === 1 ? '' : 's'}.
                    </p>
                </div>
                <a
                    href={`/agents/${agentId}/inbox/compose`}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                    Compose
                </a>
            </header>

            {initialMessages.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        No messages yet. Assign an inbound email address to this agent under
                        Settings → Integrations → Emails to start receiving mail.
                    </p>
                </div>
            ) : (
                <table className="w-full text-sm">
                    <thead className="border-b text-left text-muted-foreground">
                        <tr>
                            <th className="py-2">Direction</th>
                            <th className="py-2">From</th>
                            <th className="py-2">Subject</th>
                            <th className="py-2">When</th>
                            <th className="py-2">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {initialMessages.map((m) => {
                            const when = m.receivedAt ?? m.sentAt ?? m.createdAt;
                            return (
                                <tr key={m.id} className="border-b">
                                    <td className="py-2">
                                        <span
                                            className={
                                                m.direction === 'inbound'
                                                    ? 'text-green-700'
                                                    : 'text-blue-700'
                                            }
                                        >
                                            {m.direction === 'inbound' ? '↓ in' : '↑ out'}
                                        </span>
                                    </td>
                                    <td className="py-2">{m.from}</td>
                                    <td className="py-2 font-medium">{m.subject}</td>
                                    <td className="py-2 text-xs text-muted-foreground">
                                        {new Date(when).toLocaleString()}
                                    </td>
                                    <td className="py-2">{m.deliveryStatus ?? '—'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
