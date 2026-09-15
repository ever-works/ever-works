'use client';

import { useTranslations } from 'next-intl';
import type { EmailMessageListItem } from '@/lib/api/email-addresses';
import { useAgentInbox } from '@/lib/hooks/use-agent-inbox';
import { useInboxStream } from '@/lib/hooks/use-inbox-stream';
import { isDecidableDraft } from '@/lib/agent-email-policy';
import { AgentEmailDraftActions } from './AgentEmailDraftActions';

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
 *
 * Agent email (AW-05): the list is now live (`useAgentInbox` +
 * `useInboxStream`), every row shows where the message is in its life, and
 * a draft held for approval can be approved or discarded in place.
 *
 * Security: ALL fields on EmailMessageListItem/EmailMessageDetail that
 * originate from inbound email are UNTRUSTED external content controlled by
 * arbitrary senders:
 *   - m.from       — sender address (attacker-controlled)
 *   - m.subject    — email subject  (attacker-controlled)
 *   - m.bodyText   — plain-text body (attacker-controlled)
 *   - m.bodyHtml   — HTML body      (attacker-controlled, HIGH RISK)
 *
 * React JSX text children (used here) are HTML-encoded automatically and are
 * safe. If any future component passes these fields to:
 *   - dangerouslySetInnerHTML
 *   - a markdown / rich-text renderer
 *   - template literals inserted into HTML strings
 * it MUST first sanitize via DOMPurify (or equivalent) to prevent stored XSS.
 * m.bodyHtml in particular must NEVER be rendered raw.
 */
export function AgentInboxPanel({ agentId, initialMessages }: Props) {
    const t = useTranslations('dashboard.agentsPage.email');
    // AW-05 — the live hooks (shared per-Agent store + SSE with a polling
    // fallback). The server-rendered list shows until the first client fetch
    // lands, and stays if that fetch fails, so the page never goes blank.
    const inbox = useAgentInbox(agentId);
    useInboxStream(agentId, inbox.mutate);
    const messages: EmailMessageListItem[] =
        inbox.isLoading || inbox.error ? initialMessages : inbox.messages;
    const waitingDrafts = messages.filter((m) => isDecidableDraft(m.status)).length;

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">Inbox</h1>
                    <p className="text-sm text-muted-foreground">
                        Inbound + outbound email for this agent. {messages.length} message
                        {messages.length === 1 ? '' : 's'}.
                    </p>
                    {waitingDrafts > 0 ? (
                        <p
                            className="text-sm font-medium text-amber-700"
                            data-testid="agent-inbox-waiting-drafts"
                        >
                            {t('drafts.waiting', { count: waitingDrafts })}
                        </p>
                    ) : null}
                </div>
                <a
                    href={`/agents/${agentId}/inbox/compose`}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                    Compose
                </a>
            </header>

            {messages.length === 0 ? (
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
                            <th className="py-2">
                                <span className="sr-only">{t('drafts.approve')}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {messages.map((m) => {
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
                                    {/* Security: m.from is untrusted external content; safe here as a React text child */}
                                    <td className="py-2">{m.from}</td>
                                    <td className="py-2 font-medium">
                                        <a
                                            href={`/agents/${agentId}/inbox/${m.id}`}
                                            className="hover:underline"
                                        >
                                            {/* Security: m.subject is untrusted external content; safe here as a React text child */}
                                            {m.subject}
                                        </a>
                                    </td>
                                    <td className="py-2 text-xs text-muted-foreground">
                                        {new Date(when).toLocaleString()}
                                    </td>
                                    <td className="py-2">
                                        {m.deliveryStatus ?? '—'}
                                        {m.status ? (
                                            <span
                                                className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs"
                                                data-testid={`agent-inbox-status-${m.id}`}
                                            >
                                                {t(`drafts.status.${m.status}`)}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className="py-2">
                                        {isDecidableDraft(m.status) ? (
                                            <AgentEmailDraftActions
                                                agentId={agentId}
                                                messageId={m.id}
                                                onDecided={() => void inbox.mutate()}
                                            />
                                        ) : null}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
