import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkKindBadge } from './WorkKindBadge';

// next-intl needs a provider; the badge only reads flat keys under
// `dashboard.workKind`, so echoing the key back is enough to assert which
// label was requested without coupling the test to the English copy.
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

describe('WorkKindBadge', () => {
    it.each([
        ['website', 'website'],
        ['landing-page', 'landing-page'],
        ['blog', 'blog'],
        ['directory', 'directory'],
        ['awesome-repo', 'awesome-repo'],
        ['company', 'company'],
        ['default', 'default'],
    ])('renders the %s kind', (kind, expected) => {
        render(<WorkKindBadge kind={kind} />);
        const badge = screen.getByTestId('work-kind-badge');
        expect(badge).toHaveAttribute('data-work-kind', expected);
        expect(badge).toHaveTextContent(expected);
    });

    it('accepts "landing" as an alias for "landing-page"', () => {
        render(<WorkKindBadge kind="landing" />);
        expect(screen.getByTestId('work-kind-badge')).toHaveAttribute(
            'data-work-kind',
            'landing-page',
        );
    });

    /**
     * `work.kind` is an open string union — the server may ship a kind this
     * build has never heard of. That must degrade to the generic "Work"
     * presentation rather than crashing the card it appears on.
     */
    it.each([
        ['an unknown kind', 'storefront'],
        ['undefined', undefined],
        ['null', null],
        ['an empty string', ''],
    ])('degrades %s to the default presentation', (_label, kind) => {
        render(<WorkKindBadge kind={kind} />);
        expect(screen.getByTestId('work-kind-badge')).toHaveAttribute('data-work-kind', 'default');
    });

    it('renders an inline variant for the header meta row', () => {
        render(<WorkKindBadge kind="blog" variant="inline" />);
        const badge = screen.getByTestId('work-kind-badge');
        expect(badge).toHaveAttribute('data-work-kind', 'blog');
        // The inline variant is not a pill — it must not carry the rounded
        // chip styling that would make it look like a status badge in the
        // middle of the slug / owner / provider row.
        expect(badge.className).not.toContain('rounded-full');
    });

    it('exposes the type in the title so the icon is not the only signal', () => {
        render(<WorkKindBadge kind="directory" />);
        expect(screen.getByTestId('work-kind-badge')).toHaveAttribute('title', 'label: directory');
    });
});
