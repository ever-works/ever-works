import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChangelogEntryDto } from '@ever-works/contracts/api';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));

import { ChangelogEntryCard } from './ChangelogEntryCard';

function entry(overrides: Partial<ChangelogEntryDto> = {}): ChangelogEntryDto {
    return {
        slug: 'approve-agent-merges-in-inbox',
        title: "Approve an agent's merge from your Inbox",
        body: 'Nothing merges without your approval.',
        category: 'decisions',
        kind: 'new',
        publishedAt: '2026-09-06T12:00:00.000Z',
        pinned: false,
        cta: null,
        isRead: false,
        ...overrides,
    };
}

/**
 * What's new (AW-14) — one entry card. Content is untrusted-by-construction
 * plain text; read state must never move or resize the card; and a
 * call-to-action is only ever offered for an in-product path.
 */
describe('ChangelogEntryCard', () => {
    it('FR-5: renders markup in the body literally, with line breaks preserved', () => {
        render(
            <ChangelogEntryCard
                entry={entry({ body: '<b>x</b>\n\nSecond paragraph' })}
                isRead={false}
            />,
        );

        const body = screen.getByText(/<b>x<\/b>/);
        expect(body.querySelector('b')).toBeNull();
        expect(body).toHaveClass('whitespace-pre-line');
    });

    it('FR-53: an unread card carries both a dot and the text "Unread"', () => {
        render(<ChangelogEntryCard entry={entry()} isRead={false} />);

        expect(screen.getByTestId('whats-new-unread-dot')).not.toHaveClass('invisible');
        expect(screen.getByText('unread')).toHaveClass('sr-only');
    });

    it('FR-20: a read card keeps the same box — the dot keeps its space, only the title weight changes', () => {
        const { rerender } = render(<ChangelogEntryCard entry={entry()} isRead={false} />);
        const unreadCard = screen.getByTestId('whats-new-entry');
        const unreadClasses = unreadCard.className;
        expect(screen.getByRole('heading')).toHaveClass('font-semibold');

        rerender(<ChangelogEntryCard entry={entry()} isRead />);

        const readCard = screen.getByTestId('whats-new-entry');
        expect(readCard).toBe(unreadCard);
        expect(readCard.className).toBe(unreadClasses);
        expect(screen.getByTestId('whats-new-unread-dot')).toHaveClass('invisible');
        expect(screen.queryByText('unread')).not.toBeInTheDocument();
        expect(screen.getByRole('heading')).toHaveClass('font-normal');
    });

    it('S-22: announces kind and category before the title', () => {
        render(<ChangelogEntryCard entry={entry()} isRead={false} />);
        const card = screen.getByTestId('whats-new-entry');
        const text = card.textContent ?? '';

        expect(text.indexOf('kinds.new')).toBeGreaterThanOrEqual(0);
        expect(text.indexOf('kinds.new')).toBeLessThan(text.indexOf("Approve an agent's merge"));
        expect(text.indexOf('filters.decisions')).toBeLessThan(
            text.indexOf("Approve an agent's merge"),
        );
    });

    it('marks the pinned entry', () => {
        render(<ChangelogEntryCard entry={entry({ pinned: true })} isRead={false} />);
        expect(screen.getByText('pinned')).toBeInTheDocument();
    });

    it('FR-42: renders the call-to-action for an in-product path and follows it once', () => {
        const onFollowCta = vi.fn();
        const withCta = entry({ cta: { label: 'Open Inbox', href: '/inbox' } });
        render(<ChangelogEntryCard entry={withCta} isRead={false} onFollowCta={onFollowCta} />);

        fireEvent.click(screen.getByRole('button', { name: /Open Inbox/ }));

        expect(onFollowCta).toHaveBeenCalledTimes(1);
        expect(onFollowCta).toHaveBeenCalledWith(withCta);
    });

    it('FR-52: Enter on the focused card follows its call-to-action', () => {
        const onFollowCta = vi.fn();
        render(
            <ChangelogEntryCard
                entry={entry({ cta: { label: 'Open Inbox', href: '/inbox' } })}
                isRead={false}
                onFollowCta={onFollowCta}
            />,
        );

        fireEvent.keyDown(screen.getByTestId('whats-new-entry'), { key: 'Enter' });

        expect(onFollowCta).toHaveBeenCalledTimes(1);
    });

    it.each([
        '//evil.example',
        '/\\evil',
        'https://evil.example',
        'javascript:alert(1)',
        'mailto:a@b.c',
        '',
        '   ',
        '/a\\b',
        '/\t/evil.example',
    ])(
        'FR-40: renders no button for the unsafe target %j, and the rest of the card still renders',
        (href) => {
            const onFollowCta = vi.fn();
            render(
                <ChangelogEntryCard
                    entry={entry({ cta: { label: 'Go', href } })}
                    isRead={false}
                    onFollowCta={onFollowCta}
                />,
            );

            expect(screen.queryByTestId('whats-new-entry-cta')).not.toBeInTheDocument();
            expect(screen.getByRole('heading')).toHaveTextContent("Approve an agent's merge");
            expect(screen.getByText('Nothing merges without your approval.')).toBeInTheDocument();

            fireEvent.keyDown(screen.getByTestId('whats-new-entry'), { key: 'Enter' });
            expect(onFollowCta).not.toHaveBeenCalled();
        },
    );
});
