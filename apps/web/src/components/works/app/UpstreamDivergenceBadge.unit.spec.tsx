import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AppUpstreamDivergenceView } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import {
    formatUpstreamAge,
    UPSTREAM_DIVERGENCE_MESSAGE_KEYS,
    UpstreamDivergenceBadge,
    upstreamDivergenceMessage,
} from './UpstreamDivergenceBadge';

/**
 * APW-02 T30 — the divergence line (spec §6.1, `spec.md:500-505`; ACC-02-13).
 *
 * Rendered with the REAL `next-intl` provider and the REAL English catalogue
 * (`messages/en.json`), the same way `PlaybookCard.unit.spec.tsx` does: the
 * point of these cases is the copy a member reads — the plural forms and the
 * checked time — so a translator mock that echoes key paths would assert
 * nothing about them. The clock is injected, so "Checked 6 minutes ago" is
 * spec §6.1's sentence and not whatever the test machine's clock says.
 */

const NOW = Date.parse('2026-09-17T12:00:00.000Z');

const upstreamMessages = (
    messages as unknown as {
        dashboard: {
            workDetail: {
                appUpstream: Record<string, string> & { warnings: Record<string, string> };
            };
        };
    }
).dashboard.workDetail.appUpstream;

function reading(over: Partial<AppUpstreamDivergenceView> = {}): AppUpstreamDivergenceView {
    return {
        aheadBy: 0,
        behindBy: 12,
        computedAt: '2026-09-17T11:54:00.000Z',
        stale: false,
        ...over,
    };
}

function renderBadge(divergence: AppUpstreamDivergenceView | null) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <UpstreamDivergenceBadge divergence={divergence} now={NOW} />
        </NextIntlClientProvider>,
    );
}

describe('UpstreamDivergenceBadge', () => {
    it.each<[string, AppUpstreamDivergenceView | null, string]>([
        ['behind only', reading({ behindBy: 12 }), '12 commits behind upstream'],
        ['behind only, singular', reading({ behindBy: 1 }), '1 commit behind upstream'],
        ['ahead only', reading({ aheadBy: 3, behindBy: 0 }), '3 commits ahead of upstream'],
        [
            'ahead only, singular',
            reading({ aheadBy: 1, behindBy: 0 }),
            '1 commit ahead of upstream',
        ],
        ['in step', reading({ aheadBy: 0, behindBy: 0 }), 'Up to date with upstream'],
        ['both ways', reading({ aheadBy: 2, behindBy: 4 }), '2 ahead, 4 behind upstream'],
        ['no reading at all', null, 'Divergence unknown'],
    ])('renders the %s message', (_case, divergence, copy) => {
        renderBadge(divergence);

        expect(screen.getByTestId('app-upstream-badge')).toHaveTextContent(copy);
    });

    it('renders five messages, each a leaf of the appUpstream catalogue', () => {
        // The five cases of `spec.md:500-505`, and the five leaves they read.
        expect(Object.values(UPSTREAM_DIVERGENCE_MESSAGE_KEYS)).toEqual([
            'upToDate',
            'behind',
            'ahead',
            'aheadAndBehind',
            'unknown',
        ]);

        for (const key of Object.values(UPSTREAM_DIVERGENCE_MESSAGE_KEYS)) {
            expect(upstreamMessages[key]).toBeTruthy();
            expect(key).not.toContain('.');
        }
    });

    // ACC-02-13: "Divergence counts render with their age". The age is the
    // reason `{ago}` exists, and a reading older than ten minutes renders with
    // its counts and its age — `stale` is not a sixth message.
    it('renders the reading age, and a stale reading keeps its counts', () => {
        renderBadge(reading({ behindBy: 6, stale: true, computedAt: '2026-09-17T11:54:00.000Z' }));

        expect(screen.getByTestId('app-upstream-badge')).toHaveTextContent('Checked 6 minutes ago');
        expect(screen.getByTestId('app-upstream-badge')).toHaveTextContent(
            '6 commits behind upstream',
        );
    });

    it('says "Checked {ago}" from the injected clock, never from the wall clock', () => {
        expect(formatUpstreamAge('2026-09-17T11:59:30.000Z', NOW)).toBe('just now');
        expect(formatUpstreamAge('2026-09-17T11:59:00.000Z', NOW)).toBe('1 minute ago');
        expect(formatUpstreamAge('2026-09-17T11:54:00.000Z', NOW)).toBe('6 minutes ago');
        expect(formatUpstreamAge('2026-09-17T11:00:00.000Z', NOW)).toBe('1 hour ago');
        expect(formatUpstreamAge('2026-09-14T12:00:00.000Z', NOW)).toBe('3 days ago');
    });

    it('does not claim an age when there is no reading', () => {
        renderBadge(null);

        expect(screen.getByTestId('app-upstream-badge')).toHaveTextContent('Divergence unknown');
        expect(screen.getByTestId('app-upstream-badge')).not.toHaveTextContent('Checked');
    });

    it('picks the message from the counts, not from a third value', () => {
        expect(upstreamDivergenceMessage(null)).toEqual({ key: 'unknown' });
        expect(upstreamDivergenceMessage(reading({ aheadBy: 0, behindBy: 0 }))).toEqual({
            key: 'upToDate',
        });
        expect(upstreamDivergenceMessage(reading({ aheadBy: 0, behindBy: 7 }))).toEqual({
            key: 'behind',
            values: { count: 7 },
        });
        expect(upstreamDivergenceMessage(reading({ aheadBy: 7, behindBy: 0 }))).toEqual({
            key: 'ahead',
            values: { count: 7 },
        });
        expect(upstreamDivergenceMessage(reading({ aheadBy: 2, behindBy: 7 }))).toEqual({
            key: 'aheadAndBehind',
            values: { ahead: 2, behind: 7 },
        });
    });

    it('leaves the two plural messages as plural messages in the catalogue', () => {
        expect(upstreamMessages.behind).toContain('{count, plural,');
        expect(upstreamMessages.ahead).toContain('{count, plural,');
        expect(upstreamMessages.checkedAgo).toContain('{ago}');
    });

    it('renders text, never colour alone (spec §6.4)', () => {
        renderBadge(reading({ behindBy: 2 }));

        cleanup();

        const { container } = renderBadge(reading({ aheadBy: 1, behindBy: 0 }));
        expect(container.textContent).toContain('1 commit ahead of upstream');
    });
});
