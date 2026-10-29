import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InboxEmailHeader, InboxIntegrationSource } from './InboxIntegrationSource';
import type { InboxItem } from '@/lib/api/inbox.shared';

/**
 * Integration inbox push — an item another product (Ever Gauzy first) filed
 * into this Inbox shows WHERE it came from (the badge), a link back to it
 * there (https only), and for an email its header block. Everything the
 * integration sent is text; only a safe https URL ever becomes a link.
 */

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${ns}.${key}(${JSON.stringify(values)})` : `${ns}.${key}`,
    useLocale: () => 'en',
}));

vi.mock('@/lib/hooks/use-mounted', () => ({ useMounted: () => true }));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
    return {
        id: 'i1',
        kind: 'notice',
        title: 'Timesheet approved',
        body: 'Your timesheet for week 43 was approved.',
        options: null,
        sourceType: 'integration',
        sourceMeta: null,
        agentId: null,
        agentRunId: null,
        taskId: null,
        workId: null,
        escalationId: null,
        proposalId: null,
        status: 'open',
        unread: true,
        answeredAt: null,
        answerText: null,
        answerOptionId: null,
        createdAt: '2026-10-28T10:00:00.000Z',
        updatedAt: '2026-10-28T10:00:00.000Z',
        origin: 'integration',
        sourceLabel: 'Ever Gauzy',
        sourceUrl: 'https://app.gauzy.co/#/pages/inbox/1',
        email: null,
        occurredAt: null,
        ...overrides,
    };
}

describe('InboxIntegrationSource', () => {
    it('renders nothing for a platform item (or an older API that sends no origin)', () => {
        const platform = item({ origin: 'platform', sourceType: 'agent-run', sourceLabel: null });
        expect(render(<InboxIntegrationSource item={platform} />).container.firstChild).toBeNull();
        const older = item({ origin: undefined, sourceType: 'system' });
        expect(
            render(<InboxIntegrationSource item={older} compact />).container.firstChild,
        ).toBeNull();
    });

    it('shows the integration name as the badge, on the row and in the detail', () => {
        render(<InboxIntegrationSource item={item()} compact />);
        expect(screen.getByTestId('inbox-integration-source-badge').textContent).toBe('Ever Gauzy');
        expect(screen.queryByTestId('inbox-integration-source-link')).toBeNull();
    });

    it('falls back to a neutral label when the integration sent none', () => {
        render(<InboxIntegrationSource item={item({ sourceLabel: '  ' })} compact />);
        expect(screen.getByTestId('inbox-integration-source-badge').textContent).toBe(
            'dashboard.inbox.integrationSource.fallbackLabel',
        );
    });

    it('links back to the item over https, in a new tab without an opener', () => {
        render(<InboxIntegrationSource item={item()} />);
        const link = screen.getByTestId('inbox-integration-source-link');
        expect(link.getAttribute('href')).toBe('https://app.gauzy.co/#/pages/inbox/1');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.textContent).toContain('"source":"Ever Gauzy"');
    });

    it('never renders an unsafe sourceUrl as a link', () => {
        for (const sourceUrl of [
            'javascript:alert(document.cookie)',
            'data:text/html,<script>alert(1)</script>',
            'http://app.gauzy.co/inbox/1',
            'https://user:pass@app.gauzy.co/',
            '/relative',
            null,
        ]) {
            const { unmount } = render(<InboxIntegrationSource item={item({ sourceUrl })} />);
            expect([sourceUrl, screen.queryByTestId('inbox-integration-source-link')]).toEqual([
                sourceUrl,
                null,
            ]);
            // The badge still says where it came from.
            expect(screen.getByTestId('inbox-integration-source-badge')).toBeTruthy();
            unmount();
        }
    });

    it('renders a label carrying markup as text', () => {
        render(
            <InboxIntegrationSource item={item({ sourceLabel: '<img src=x onerror=alert(1)>' })} />,
        );
        const badge = screen.getByTestId('inbox-integration-source-badge');
        expect(badge.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(badge.querySelector('img')).toBeNull();
    });

    it('shows when it happened in the integration, when it said so', () => {
        render(<InboxIntegrationSource item={item({ occurredAt: '2026-10-27T09:00:00.000Z' })} />);
        expect(screen.getByTestId('inbox-integration-source-occurred')).toBeTruthy();
    });
});

describe('InboxEmailHeader', () => {
    const email = {
        from: 'Billing <billing@example.com>',
        to: 'ada@example.com',
        subject: 'Invoice #42',
        receivedAt: '2026-10-28T09:00:00.000Z',
    };

    it('shows from, to, subject and received for a kind email item', () => {
        render(<InboxEmailHeader item={item({ kind: 'email', email })} />);
        expect(screen.getByTestId('inbox-email-header-from').textContent).toBe(
            'Billing <billing@example.com>',
        );
        expect(screen.getByTestId('inbox-email-header-to').textContent).toBe('ada@example.com');
        expect(screen.getByTestId('inbox-email-header-subject').textContent).toBe('Invoice #42');
        expect(screen.getByTestId('inbox-email-header-received')).toBeTruthy();
    });

    it('leaves out an empty To, and shows an unparseable date as the text it is', () => {
        render(
            <InboxEmailHeader
                item={item({
                    kind: 'email',
                    email: { ...email, to: null, receivedAt: 'yesterday' },
                })}
            />,
        );
        expect(screen.queryByTestId('inbox-email-header-to')).toBeNull();
        expect(screen.getByTestId('inbox-email-header-received').textContent).toBe('yesterday');
    });

    it('renders nothing for another kind, or without the header block', () => {
        expect(
            render(<InboxEmailHeader item={item({ kind: 'notice', email })} />).container
                .firstChild,
        ).toBeNull();
        expect(
            render(<InboxEmailHeader item={item({ kind: 'email', email: null })} />).container
                .firstChild,
        ).toBeNull();
    });

    it('renders a subject carrying markup as text', () => {
        render(
            <InboxEmailHeader
                item={item({ kind: 'email', email: { ...email, subject: '<b>urgent</b>' } })}
            />,
        );
        const subject = screen.getByTestId('inbox-email-header-subject');
        expect(subject.textContent).toBe('<b>urgent</b>');
        expect(subject.querySelector('b')).toBeNull();
    });
});
