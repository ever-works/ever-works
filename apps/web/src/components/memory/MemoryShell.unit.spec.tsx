// MemoryShell — placement contract for the Meetings block.
//
// Navigation consolidation folded the Meetings catalog into the Memory
// page as a block anchored at `#meetings`. It has to sit directly after
// the Agent-memory panel (the two memory *sources* read together) and
// before the consolidation surface and the document list — and the page
// must still render when the meetings fetch failed or returned nothing.

import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

// The sibling panels each own a network lifecycle of their own; this
// spec is about DOM order, so they are stubbed down to markers.
vi.mock('./MemoryReviewPanel', () => ({
    MemoryReviewPanel: () => <div data-testid="memory-review-panel" />,
}));
vi.mock('./MemoryFilesPanel', () => ({
    MemoryFilesPanel: () => <div data-testid="memory-files-panel" />,
}));
vi.mock('./MemoryUploadsPanel', () => ({
    MemoryUploadsPanel: () => <div data-testid="memory-uploads-panel" />,
}));
vi.mock('./AgentMemoryPanel', () => ({
    AgentMemoryPanel: () => <div data-testid="agent-memory-panel" />,
}));
vi.mock('./MemoryConsolidationSettings', () => ({
    MemoryConsolidationSettings: () => <div data-testid="memory-consolidation-settings" />,
}));
vi.mock('./MeetingCard', () => ({}));
vi.mock('../meetings/MeetingCard', () => ({
    MeetingCard: () => <div data-testid="meeting-card" />,
}));

import { MemoryShell } from './MemoryShell';
import type { MemoryMeetingsData } from './MemoryMeetingsPanel';
import type { MemoryResponse } from '@/lib/api/memory-types';
import type { Meeting } from '@/lib/api/meetings';

const initial: MemoryResponse = {
    documents: [],
    counts: { documents: 0, indexed: 0 },
    facets: { types: [], works: [], sources: [], statuses: [] },
} as unknown as MemoryResponse;

const meeting = {
    id: 'meet-1',
    title: 'Weekly sync',
    source: 'manual',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: null,
    hasTranscript: false,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
} as unknown as Meeting;

function meetingsData(overrides: Partial<MemoryMeetingsData> = {}): MemoryMeetingsData {
    return {
        meetings: [meeting],
        works: [],
        loadError: null,
        filters: {},
        pagination: {
            offset: 0,
            hasPrevious: false,
            hasNext: false,
            previousHref: '/memory#meetings',
            nextHref: '/memory#meetings',
        },
        ...overrides,
    };
}

describe('MemoryShell — Meetings block', () => {
    it('renders the block directly after the Agent memory panel', () => {
        render(<MemoryShell initial={initial} meetings={meetingsData()} />);

        const agentPanel = screen.getByTestId('agent-memory-panel');
        const meetingsShell = screen.getByTestId('meetings-shell');
        expect(meetingsShell.getAttribute('id')).toBe('meetings');
        // DOCUMENT_POSITION_FOLLOWING === 4: the block comes after.
        expect(agentPanel.compareDocumentPosition(meetingsShell) & 4).toBeTruthy();
        expect(agentPanel.nextElementSibling).toBe(meetingsShell);

        // …and before the document search box the page ends with.
        const search = screen.getByTestId('memory-search');
        expect(meetingsShell.compareDocumentPosition(search) & 4).toBeTruthy();
    });

    it('omits the block entirely when the page passes no meetings data', () => {
        render(<MemoryShell initial={initial} />);
        expect(screen.queryByTestId('meetings-shell')).toBeNull();
        expect(screen.getByTestId('agent-memory-panel')).not.toBeNull();
    });

    it('still renders the page when the meetings fetch failed', () => {
        render(
            <MemoryShell
                initial={initial}
                meetings={meetingsData({ meetings: [], loadError: 'upstream 503' })}
            />,
        );
        expect(screen.getByTestId('memory-shell')).not.toBeNull();
        expect(screen.getByTestId('meetings-load-error')).not.toBeNull();
        expect(screen.queryByTestId('meetings-grid')).toBeNull();
    });

    it('shows the meetings empty state when there are none', () => {
        render(<MemoryShell initial={initial} meetings={meetingsData({ meetings: [] })} />);
        expect(screen.getByTestId('memory-shell')).not.toBeNull();
        expect(screen.getByTestId('meetings-empty')).not.toBeNull();
    });
});

/**
 * EW-786 — the client half of the Memory BFF scope contract.
 *
 * `/api/memory` and `/api/memory/consolidate` now mint `X-Scope-Slug` from
 * the per-tab `x-ever-workspace` selector and answer 400 without it, so both
 * of this shell's calls have to go through `browserApiFetch`. With a raw
 * `fetch()` the search/filter refetch and the consolidation pass both ran in
 * personal scope, where the API returns an empty feed / a zeroed report with
 * HTTP 200 — silently wrong rather than visibly broken.
 */
describe('MemoryShell BFF transport', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            documents: [],
                            counts: { documents: 0, indexed: 0 },
                            facets: { types: [], works: [], statuses: [], sources: [] },
                            scanned: 0,
                            promoted: 0,
                            synthesized: 0,
                            superseded: 0,
                            dryRun: true,
                            notes: [],
                            details: {
                                promotedIds: [],
                                supersededPairs: [],
                                synthesizedIds: [],
                            },
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    ),
            ),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['/org/ever/memory', 'org:ever'],
        ['/memory', 'personal'],
    ])('refetches the feed from %s with the workspace selector', async (pathname, selector) => {
        window.history.replaceState({}, '', pathname);
        render(<MemoryShell initial={initial} />);

        fireEvent.change(screen.getByTestId('memory-search'), { target: { value: 'cortex' } });

        // The refetch is debounced by 300ms; waitFor's 1s budget covers it.
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toContain('/api/memory?');
        expect(new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe(selector);
    });

    it('posts the consolidation dry-run with the workspace selector', async () => {
        window.history.replaceState({}, '', '/org/ever/memory');
        render(<MemoryShell initial={initial} />);

        fireEvent.click(screen.getByTestId('memory-consolidate-button'));

        await waitFor(() => expect(fetch).toHaveBeenCalled());
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('/api/memory/consolidate');
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });
});
