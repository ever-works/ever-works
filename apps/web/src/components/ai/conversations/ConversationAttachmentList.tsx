'use client';

import { useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';
import type { ConversationAttachmentView } from '@ever-works/contracts';
import { attachmentUploadIds, type ChatAttachmentRef } from '@/lib/ai/attachments';
import type { OutboxRow } from '@/lib/hooks/use-conversation-outbox';
import { cn } from '@/lib/utils/cn';

/**
 * Only a same-origin uploads URL may become a link — the owner-gated serve
 * route (`/api/uploads/<userId>/<file>`, with an optional query). The URL is
 * parsed first, so dot segments and backslashes are judged by where the
 * browser would actually go. Anything else (another origin, `//host`,
 * `javascript:`, a path elsewhere in the app) is shown as a name that does not
 * open.
 */
const UPLOAD_PATH_RE = /^\/api\/uploads\/[^/]+\/[^/]+$/;
const PARSE_BASE = 'https://attachment.invalid';

export function conversationAttachmentHref(url: string | null | undefined): string | null {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
    let parsed: URL;
    try {
        parsed = new URL(url, PARSE_BASE);
    } catch {
        return null;
    }
    if (parsed.origin !== PARSE_BASE || !UPLOAD_PATH_RE.test(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}`;
}

/** The files a row carries: the composer's own details while local, the server's once stored. */
export function outboxRowAttachments(row: OutboxRow): ConversationAttachmentView[] {
    return (row.source === 'local' ? row.entry.attachments : row.message.attachments) ?? [];
}

/**
 * The composer's attachments as a message carries them: the upload id the API
 * stores, plus the name and URL to show until the server's copy arrives.
 * Anything that is not an upload (a repository reference) has no upload id
 * and is not attached.
 */
export function composerAttachmentsToConversation(
    refs: readonly ChatAttachmentRef[],
): ConversationAttachmentView[] {
    const attachments: ConversationAttachmentView[] = [];
    for (const ref of refs) {
        const [uploadId] = attachmentUploadIds([ref]);
        if (!uploadId) continue;
        attachments.push({
            uploadId,
            filename: ref.name,
            mimeType: ref.mimeType ?? null,
            url: ref.url,
        });
    }
    return attachments;
}

export interface ConversationAttachmentListProps {
    attachments: readonly ConversationAttachmentView[];
    /** Aligns the chips with the bubble they belong to. */
    align?: 'start' | 'end';
}

/**
 * The files sent with one Conversation message, under its bubble: each by
 * name, opening in a new tab when it can still be opened. A file whose
 * details are unknown (an older API build, or an upload no longer readable
 * in this workspace) still shows, so a message never looks like it was sent
 * without the file it carried.
 */
export function ConversationAttachmentList({
    attachments,
    align = 'end',
}: ConversationAttachmentListProps) {
    const t = useTranslations('dashboard.aiChat.conversations');
    if (attachments.length === 0) return null;

    return (
        <ul
            data-testid="conversation-attachments"
            aria-label={t('attachments')}
            className={cn(
                'mt-1 flex max-w-[90%] flex-wrap gap-1.5',
                align === 'end' ? 'justify-end self-end' : 'justify-start self-start',
            )}
        >
            {attachments.map((attachment, index) => {
                const name = attachment.filename?.trim() || t('attachmentFallbackName');
                const href = conversationAttachmentHref(attachment.url);
                const chip =
                    'inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text dark:border-white/15 dark:text-text-dark';
                return (
                    <li key={`${attachment.uploadId}-${index}`}>
                        {href ? (
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={t('openAttachment', { name })}
                                aria-label={t('openAttachment', { name })}
                                className={cn(
                                    chip,
                                    'hover:bg-surface-secondary dark:hover:bg-white/5',
                                )}
                            >
                                <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                                <span className="truncate">{name}</span>
                            </a>
                        ) : (
                            <span
                                title={name}
                                className={cn(chip, 'text-text-muted dark:text-text-muted-dark')}
                            >
                                <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                                <span className="truncate">{name}</span>
                            </span>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
