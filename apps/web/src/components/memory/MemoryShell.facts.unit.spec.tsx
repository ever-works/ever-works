// MemoryShell — placement contract for the Facts block (AW-07).
//
// The Facts block is additive: it renders only when the page hands the shell
// a facts payload, sits between the header and the review queue, and leaves
// every existing panel exactly where it was — including the Agent memory →
// Meetings adjacency that `MemoryShell.unit.spec.tsx` pins.

import React, { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
vi.mock('./FactsPanel', () => ({
    FactsPanel: ({ onTidyUp }: { onTidyUp?: () => void }) => (
        <div data-testid="memory-facts-panel">
            <button type="button" data-testid="stub-tidy-up" onClick={onTidyUp} />
        </div>
    ),
}));

import { MemoryShell } from './MemoryShell';
import type { MemoryResponse } from '@/lib/api/memory-types';
import type { MemoryFactListDto } from '@/lib/api/memory-facts-types';

const initial = {
    documents: [],
    counts: { documents: 0, indexed: 0 },
    facets: { types: [], works: [], sources: [], statuses: [] },
} as unknown as MemoryResponse;

const facts: MemoryFactListDto = {
    facts: [],
    total: 0,
    counts: { active: 0, proposed: 0, forgotten: 0, pinned: 0 },
    semantic: false,
};

describe('MemoryShell — Facts block', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('omits the Facts block when the page passes no facts payload', () => {
        render(<MemoryShell initial={initial} />);
        expect(screen.queryByTestId('memory-facts-panel')).toBeNull();
        expect(screen.getByTestId('memory-review-panel')).not.toBeNull();
    });

    it('renders the Facts block after the header and before the review queue', () => {
        render(<MemoryShell initial={initial} facts={facts} />);
        const factsPanel = screen.getByTestId('memory-facts-panel');
        const review = screen.getByTestId('memory-review-panel');
        const heading = screen.getByRole('heading', { level: 1 });
        expect(heading.compareDocumentPosition(factsPanel) & 4).toBeTruthy();
        expect(factsPanel.nextElementSibling).toBe(review);
    });

    it('leaves every existing panel on the page', () => {
        render(<MemoryShell initial={initial} facts={facts} />);
        for (const id of [
            'memory-review-panel',
            'memory-files-panel',
            'memory-uploads-panel',
            'agent-memory-panel',
            'memory-consolidation-settings',
            'memory-search',
            'memory-consolidate-button',
        ]) {
            expect(screen.getByTestId(id)).not.toBeNull();
        }
    });

    it('wires Tidy up to the existing consolidation dry-run', () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
        vi.stubGlobal('fetch', fetchMock);
        window.history.replaceState({}, '', '/memory');

        render(<MemoryShell initial={initial} facts={facts} />);
        fireEvent.click(screen.getByTestId('stub-tidy-up'));

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/memory/consolidate',
            expect.objectContaining({ method: 'POST', body: JSON.stringify({ apply: false }) }),
        );
    });
});
