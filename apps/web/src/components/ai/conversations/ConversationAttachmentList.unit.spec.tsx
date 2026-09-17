import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessageView } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import {
    ConversationAttachmentList,
    composerAttachmentsToConversation,
    conversationAttachmentHref,
    outboxRowAttachments,
} from './ConversationAttachmentList';

const SHA = 'a'.repeat(64);
const URL_PDF = `/api/uploads/u1/${SHA}.pdf`;

function serverMessage(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
    return {
        id: 'm-1',
        conversationId: 'c-1',
        role: 'user',
        content: 'pricing.pdf',
        authorType: 'user',
        authorId: 'u-1',
        mentions: null,
        attachments: null,
        status: 'sent',
        failureCode: null,
        clientMessageId: null,
        replyToMessageId: null,
        createdAt: '2026-09-14T09:00:00.000Z',
        ...overrides,
    };
}

/**
 * A file sent into a Conversation stays visible under its message and can be
 * reopened — while the message is on its way, after it failed, and once the
 * server has stored it — and only a same-origin uploads URL ever becomes a link.
 */
describe('ConversationAttachmentList', () => {
    afterEach(cleanup);

    it('opens a file by name, in a new tab', () => {
        render(
            <ConversationAttachmentList
                attachments={[{ uploadId: SHA, filename: 'pricing.pdf', url: URL_PDF }]}
            />,
        );
        const link = screen.getByRole('link', { name: 'openAttachment:{"name":"pricing.pdf"}' });
        expect(link.getAttribute('href')).toBe(URL_PDF);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(screen.getByText('pricing.pdf')).toBeTruthy();
    });

    it('still shows a file it cannot open, and names an unnamed one', () => {
        render(
            <ConversationAttachmentList
                attachments={[
                    { uploadId: SHA },
                    { uploadId: SHA, filename: 'notes.txt', url: null },
                    { uploadId: SHA, filename: 'evil', url: 'javascript:alert(1)' },
                ]}
            />,
        );
        expect(screen.queryAllByRole('link')).toHaveLength(0);
        expect(screen.getByText('attachmentFallbackName')).toBeTruthy();
        expect(screen.getByText('notes.txt')).toBeTruthy();
        expect(screen.getByText('evil')).toBeTruthy();
    });

    it('renders nothing for a message without files', () => {
        const { container } = render(<ConversationAttachmentList attachments={[]} />);
        expect(container.innerHTML).toBe('');
    });

    it('links only the owner-gated uploads route on this origin', () => {
        expect(conversationAttachmentHref(URL_PDF)).toBe(URL_PDF);
        expect(conversationAttachmentHref(`${URL_PDF}?workId=w-1`)).toBe(`${URL_PDF}?workId=w-1`);
        expect(conversationAttachmentHref(`https://elsewhere.test${URL_PDF}`)).toBeNull();
        expect(conversationAttachmentHref(`//elsewhere.test${URL_PDF}`)).toBeNull();
        expect(conversationAttachmentHref('javascript:alert(1)')).toBeNull();
        expect(conversationAttachmentHref('/api/uploads/u1/../../settings')).toBeNull();
        expect(conversationAttachmentHref('/api/uploads/../x')).toBeNull();
        expect(conversationAttachmentHref('/api/uploads/%2e%2e/x')).toBeNull();
        expect(conversationAttachmentHref('/\\elsewhere.test/api/uploads/u1/a.pdf')).toBeNull();
        expect(conversationAttachmentHref('/dashboard')).toBeNull();
        expect(conversationAttachmentHref(null)).toBeNull();
        expect(conversationAttachmentHref(undefined)).toBeNull();
    });

    it('keeps the composer’s name and URL with each upload it attaches, and skips non-uploads', () => {
        expect(
            composerAttachmentsToConversation([
                { name: 'pricing.pdf', url: URL_PDF, mimeType: 'application/pdf', kind: 'upload' },
                { name: 'ever-works/app', url: 'https://github.test/app', kind: 'github-repo' },
                { name: 'elsewhere.pdf', url: `https://elsewhere.test${URL_PDF}` },
            ]),
        ).toEqual([
            { uploadId: SHA, filename: 'pricing.pdf', mimeType: 'application/pdf', url: URL_PDF },
        ]);
    });

    it('reads a row’s files from the local send or from the stored message', () => {
        const attachments = [{ uploadId: SHA, filename: 'pricing.pdf', url: URL_PDF }];
        expect(
            outboxRowAttachments({
                source: 'local',
                entry: {
                    clientMessageId: 'cm_1',
                    body: 'pricing.pdf',
                    attachments,
                    status: 'failed',
                    failureCode: 'network',
                    createdAt: '2026-09-14T09:00:00.000Z',
                },
            }),
        ).toEqual(attachments);
        expect(
            outboxRowAttachments({
                source: 'server',
                message: serverMessage({ attachments }),
                retrying: false,
            }),
        ).toEqual(attachments);
        expect(
            outboxRowAttachments({ source: 'server', message: serverMessage(), retrying: false }),
        ).toEqual([]);
    });
});
