import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { KbSourceBadge } from './KbSourceBadge';

/**
 * Memory facets — the badge is derived at render time, so these tests
 * are the only thing standing between a connector-written memory and
 * being silently presented as "agent learning".
 */
describe('KbSourceBadge', () => {
    it('renders the human badge for a user-authored document', () => {
        render(<KbSourceBadge document={{ source: 'user', path: 'output/n.md', tags: [] }} />);
        expect(screen.getByTestId('kb-source-badge')).toHaveAttribute('data-badge', 'human');
    });

    it('renders the agent badge for an agent-written document', () => {
        render(<KbSourceBadge document={{ source: 'agent', path: 'output/n.md', tags: [] }} />);
        expect(screen.getByTestId('kb-source-badge')).toHaveAttribute('data-badge', 'agent');
    });

    it('renders the synthesized badge for a consolidation merge', () => {
        render(
            <KbSourceBadge
                document={{ source: 'agent', path: 'memory/synthesis-abc.md', tags: ['synthesis'] }}
            />,
        );
        expect(screen.getByTestId('kb-source-badge')).toHaveAttribute('data-badge', 'synthesized');
    });

    it('renders the connector badge and NAMES the connector for ingested memory', () => {
        render(
            <KbSourceBadge
                document={{
                    source: 'agent',
                    path: 'output/n.md',
                    tags: [],
                    metadata: { provenance: { source: 'slack' } },
                }}
            />,
        );
        const badge = screen.getByTestId('kb-source-badge');
        expect(badge).toHaveAttribute('data-badge', 'connector');
        // "Connector" alone tells the reader nothing actionable.
        expect(badge).toHaveAttribute('data-connector', 'slack');
        expect(badge.textContent).toContain('slack');
    });

    it('hides the label but keeps the accessible name in compact mode', () => {
        render(
            <KbSourceBadge document={{ source: 'agent', path: 'output/n.md', tags: [] }} compact />,
        );
        const badge = screen.getByTestId('kb-source-badge');
        expect(badge.textContent).toBe('');
        expect(badge.getAttribute('aria-label')).toContain('badgeAria.agent');
    });

    it('honours a custom test id so list rows stay individually addressable', () => {
        render(
            <KbSourceBadge
                document={{ source: 'user', path: 'output/n.md', tags: [] }}
                testId="kb-workbench-row-1-source"
            />,
        );
        expect(screen.getByTestId('kb-workbench-row-1-source')).toBeTruthy();
    });
});
