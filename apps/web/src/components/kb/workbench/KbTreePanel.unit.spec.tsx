import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Pass-through stub for the locale-aware Link — same shape as the
// existing KbTreePanel.unit.spec.tsx in works/detail/kb.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    redirect: vi.fn(),
    getPathname: ({ href }: { href: string }) => href,
}));

import { KbTreePanel } from './KbTreePanel';
import type { KbDocumentDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-' + Math.random().toString(36).slice(2, 9),
        workId: 'work-1',
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Brand voice',
        description: null,
        class: 'brand',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'user',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: null,
        updatedById: null,
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        ...overrides,
    };
}

function mockFetchOnce(items: KbDocumentDto[]) {
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ items, total: items.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
}

describe('workbench KbTreePanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders grouped rows once the fetch resolves and the group is expanded', async () => {
        mockFetchOnce([
            doc({ id: 'd1', class: 'brand', title: 'Voice', path: 'brand/voice.md' }),
            doc({ id: 'd2', class: 'brand', title: 'Tone', path: 'brand/tone.md' }),
            doc({ id: 'd3', class: 'legal', title: 'Terms', path: 'legal/terms.md' }),
        ]);

        render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-group-brand')).toBeTruthy();
        });

        // The "brand" group contains the active doc → opened by default;
        // the "legal" group → collapsed by default.
        expect(screen.getByTestId('kb-workbench-row-d1')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-row-d2')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-row-d3')).toBeNull();

        // Active doc row carries aria-current.
        expect(screen.getByTestId('kb-workbench-row-d1').getAttribute('aria-current')).toBe('page');
    });

    it('expanding the legal group renders the link with the right href', async () => {
        mockFetchOnce([doc({ id: 'd3', class: 'legal', title: 'Terms', path: 'legal/terms.md' })]);

        render(<KbTreePanel workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-group-legal')).toBeTruthy();
        });

        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-group-toggle-legal'));
        });

        const row = screen.getByTestId('kb-workbench-row-d3');
        expect(row.getAttribute('href')).toBe('/works/work-1/kb/legal/terms.md');
    });

    it('shows the Originals placeholder when the Originals tab is active', async () => {
        mockFetchOnce([doc({ id: 'd1' })]);
        render(<KbTreePanel workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-tab-originals')).toBeTruthy();
        });

        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-tab-originals'));
        });

        expect(screen.getByTestId('kb-workbench-originals-placeholder')).toBeTruthy();
        // KB rows should no longer be in the DOM after the tab switch.
        expect(screen.queryByTestId('kb-workbench-row-d1')).toBeNull();
    });

    it('renders the empty state when the server returns zero docs', async () => {
        mockFetchOnce([]);
        render(<KbTreePanel workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-tree-empty')).toBeTruthy();
        });
    });

    it('marks the lock icon on locked rows', async () => {
        mockFetchOnce([
            doc({ id: 'd1', class: 'brand', locked: true, lockMode: 'full', title: 'Voice' }),
        ]);
        render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-row-d1-lock')).toBeTruthy();
        });
    });
});
