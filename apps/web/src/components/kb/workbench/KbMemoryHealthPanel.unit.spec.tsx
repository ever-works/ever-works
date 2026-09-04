import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { KbMemoryHealth } from '@ever-works/contracts';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

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

/**
 * EW-786 — the client half of the health-panel fix.
 *
 * `GET /api/memory/health` now translates the per-tab `x-ever-workspace`
 * selector into the API's `x-scope-slug` and answers 400 without it, so this
 * panel has to reach it through `browserApiFetch`. A raw `fetch()` sent no
 * selector at all: the API resolved no Organization, returned `emptyHealth()`
 * — measurable zeroes, not `null`s — and the panel rendered "0% recall, 0
 * backlog" over an Organization with real retrieval history. That is the one
 * failure the tests above exist to prevent, arriving by a route they cannot
 * see — every one of them injects `initialHealth` and so never touches the
 * transport. It is pinned here instead: the selector must be derived from the
 * visible URL on the request the panel actually makes.
 */
describe('KbMemoryHealthPanel workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    function selectorOf(index: number): string | null {
        const init = fetchMock.mock.calls[index][1] as RequestInit | undefined;
        return new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER);
    }

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify(health()), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['/org/ever/works/w1/kb/review', 'org:ever'],
        ['/works/w1/kb/review', 'personal'],
    ])(
        'loads health from %s with the selector derived from the visible URL',
        async (pathname, selector) => {
            window.history.replaceState({}, '', pathname);

            render(<KbMemoryHealthPanel />);

            await waitFor(() => expect(screen.getByTestId('kb-memory-health')).toBeTruthy());
            expect(String(fetchMock.mock.calls[0][0])).toBe('/api/memory/health');
            expect(selectorOf(0)).toBe(selector);
        },
    );

    it('keeps the window query and still scopes the request', async () => {
        window.history.replaceState({}, '', '/org/ever/works/w1/kb/review');

        render(<KbMemoryHealthPanel windowDays={7} />);

        await waitFor(() => expect(screen.getByTestId('kb-memory-health')).toBeTruthy());
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/memory/health?windowDays=7');
        expect(selectorOf(0)).toBe('org:ever');
    });
});
