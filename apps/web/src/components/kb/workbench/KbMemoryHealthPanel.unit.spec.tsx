import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { KbMemoryHealth } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { KbMemoryHealthPanel } from './KbMemoryHealthPanel';

function health(overrides: Partial<KbMemoryHealth> = {}): KbMemoryHealth {
    return {
        windowDays: 30,
        computedAt: '2026-07-26T12:00:00.000Z',
        recallHitRate: 0.42,
        retrievalEvents: 120,
        documentsRetrieved: 50,
        documentsCited: 21,
        citationSignal: true,
        uncitedDocs: [{ documentId: 'd1', title: 'Legacy runbook', retrievals: 9 }],
        staleDecisionRate: 0.25,
        decisionsAccepted: 8,
        decisionsStale: 2,
        staleAfterDays: 90,
        proposedBacklog: 3,
        proposedOldestAgeDays: 41,
        proposedAverageAgeDays: 12,
        gapTopics: [
            { query: 'how do we deploy', occurrences: 4, lastSeenAt: '2026-07-25T00:00:00.000Z' },
        ],
        zeroResultRetrievals: 6,
        ...overrides,
    };
}

/**
 * Memory health panel.
 *
 * The load-bearing assertion in this file is the `null` one: an
 * unmeasurable rate must render as an explanation, never as `0%`. A
 * dashboard that reports a confident zero for something it cannot
 * measure is worse than one that reports nothing, because a reader acts
 * on it.
 */
describe('KbMemoryHealthPanel', () => {
    it('renders the three headline metrics as percentages / counts', () => {
        render(<KbMemoryHealthPanel initialHealth={health()} />);

        expect(screen.getByTestId('kb-memory-health-recall-value').textContent).toBe('42%');
        expect(screen.getByTestId('kb-memory-health-stale-value').textContent).toBe('25%');
        expect(screen.getByTestId('kb-memory-health-backlog-value').textContent).toBe('3');
    });

    it('renders "not measurable" — never 0% — when there is no citation signal', () => {
        render(
            <KbMemoryHealthPanel
                initialHealth={health({ recallHitRate: null, citationSignal: false })}
            />,
        );

        const metric = screen.getByTestId('kb-memory-health-recall');
        expect(metric).toHaveAttribute('data-unmeasured', 'true');
        expect(screen.getByTestId('kb-memory-health-recall-value').textContent).not.toContain('0%');
        expect(screen.getByTestId('kb-memory-health-recall-detail').textContent).toContain(
            'recall.noSignal',
        );
    });

    it('renders "not measurable" for the stale rate when the org has no accepted decisions', () => {
        render(<KbMemoryHealthPanel initialHealth={health({ staleDecisionRate: null })} />);

        expect(screen.getByTestId('kb-memory-health-stale')).toHaveAttribute(
            'data-unmeasured',
            'true',
        );
    });

    it('keeps the backlog metric measurable at zero — a real count, not an absence', () => {
        render(
            <KbMemoryHealthPanel
                initialHealth={health({
                    proposedBacklog: 0,
                    proposedOldestAgeDays: null,
                    proposedAverageAgeDays: null,
                })}
            />,
        );

        expect(screen.getByTestId('kb-memory-health-backlog')).toHaveAttribute(
            'data-unmeasured',
            'false',
        );
        expect(screen.getByTestId('kb-memory-health-backlog-value').textContent).toBe('0');
        expect(screen.getByTestId('kb-memory-health-backlog-detail').textContent).toContain(
            'backlog.none',
        );
    });

    it('lists the gap topics that feed the next consolidation pass', () => {
        render(<KbMemoryHealthPanel initialHealth={health()} />);

        const gaps = screen.getByTestId('kb-memory-health-gaps');
        expect(gaps.textContent).toContain('how do we deploy');
    });

    it('shows an explicit empty state rather than an empty list for gaps and uncited docs', () => {
        render(<KbMemoryHealthPanel initialHealth={health({ gapTopics: [], uncitedDocs: [] })} />);

        expect(screen.getByTestId('kb-memory-health-gaps-empty')).toBeTruthy();
        expect(screen.getByTestId('kb-memory-health-uncited-empty')).toBeTruthy();
    });

    it('surfaces the rolling window so a number is never read out of context', () => {
        render(<KbMemoryHealthPanel initialHealth={health({ windowDays: 7 })} />);

        expect(screen.getByTestId('kb-memory-health-window').textContent).toContain('7');
    });
});
