import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { PlaybookSummary } from '@ever-works/contracts';
import messages from '../../../messages/en.json';

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { PlaybookCard, playbookIcon } from './PlaybookCard';

function summary(extra: Partial<PlaybookSummary> = {}): PlaybookSummary {
    return {
        slug: 'market-watch-brief',
        title: 'Market watch brief',
        outcome: 'One living document per source.',
        summary: 'Summary.',
        category: 'research',
        version: '1.0.0',
        icon: 'telescope',
        triggerKind: 'schedule',
        triggerDescription: 'Tuesdays and Fridays at 08:00',
        costBand: 'medium',
        estimatedTokensPerRun: { min: 15000, max: 60000 },
        tags: [],
        stepTitles: ['Read each source'],
        requiredCapabilities: ['search'],
        readiness: 'needs_connection',
        missingRequired: ['search'],
        ...extra,
    };
}

function renderCard(playbook: PlaybookSummary) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <PlaybookCard playbook={playbook} />
        </NextIntlClientProvider>,
    );
}

describe('PlaybookCard', () => {
    it('is one link to the playbook with a "<title>, <category>, <readiness>" name', () => {
        renderCard(summary());
        const link = screen.getByRole('link', {
            name: 'Market watch brief, Research, Needs 1 connection',
        });
        expect(link).toHaveAttribute('href', '/catalog/playbooks/market-watch-brief');
        expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it.each<[PlaybookSummary['readiness'], string[], string]>([
        ['ready', [], 'Ready'],
        ['needs_connection', ['search', 'email-outbound'], 'Needs 2 connections'],
        ['adopted', [], 'Already set up'],
        ['blocked', [], 'Not available'],
    ])('renders %s readiness as text, not colour alone', (readiness, missingRequired, label) => {
        renderCard(summary({ readiness, missingRequired }));
        const chip = screen.getByTestId('readiness-chip');
        expect(chip).toHaveTextContent(label);
        expect(chip).toHaveAttribute('data-state', readiness);
    });

    it('shows the outcome, the cadence and the cost band with its explanation', () => {
        renderCard(summary({ costBand: 'high' }));
        expect(screen.getByText('One living document per source.')).toBeInTheDocument();
        expect(screen.getByText('Tuesdays and Fridays at 08:00')).toBeInTheDocument();
        const cost = screen.getByText('~60k+ tokens');
        expect(cost).toHaveAttribute('title', messages.dashboard.catalogPage.cost.tooltip);
    });

    it('falls back to the category icon for an unknown icon key', () => {
        expect(playbookIcon('no-such-icon', 'inbox')).toBe(playbookIcon('inbox', 'research'));
    });
});
