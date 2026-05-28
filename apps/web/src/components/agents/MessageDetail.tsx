import type { EmailMessageDetail } from '@/lib/api/email-addresses';

interface Props {
    agentId: string;
    message: EmailMessageDetail;
}

/**
 * EW-680 / T31 — Per-message detail view. Server component (read-only).
 * Renders the HTML body in a sandboxed iframe when present, else the
 * plain-text body.
 */
export function MessageDetail({ agentId, message }: Props) {
    const when = message.receivedAt ?? message.sentAt ?? message.createdAt;
    return (
        <div className="space-y-4">
            <a href={`/agents/${agentId}/inbox`} className="text-sm text-muted-foreground">
                ← Back to inbox
            </a>

            <header className="space-y-1 border-b pb-4">
                <h1 className="text-xl font-semibold">{message.subject}</h1>
                <div className="text-sm text-muted-foreground">
                    <span
                        className={
                            message.direction === 'inbound' ? 'text-green-700' : 'text-blue-700'
                        }
                    >
                        {message.direction === 'inbound' ? '↓ inbound' : '↑ outbound'}
                    </span>{' '}
                    · {new Date(when).toLocaleString()} · via {message.pluginId}
                    {message.deliveryStatus ? ` · ${message.deliveryStatus}` : ''}
                </div>
                <div className="text-sm">
                    <div>
                        <span className="text-muted-foreground">From:</span> {message.from}
                    </div>
                    <div>
                        <span className="text-muted-foreground">To:</span>{' '}
                        {message.toAddresses.join(', ')}
                    </div>
                    {message.ccAddresses?.length ? (
                        <div>
                            <span className="text-muted-foreground">Cc:</span>{' '}
                            {message.ccAddresses.join(', ')}
                        </div>
                    ) : null}
                </div>
            </header>

            {message.bodyHtml ? (
                <iframe
                    title="Message body"
                    sandbox=""
                    srcDoc={message.bodyHtml}
                    className="h-[60vh] w-full rounded-md border"
                />
            ) : (
                <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {message.bodyText}
                </pre>
            )}
        </div>
    );
}
