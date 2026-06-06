import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => {
        const fn = (key: string, vars?: Record<string, unknown>) => {
            if (!vars) return key;
            return `${key}:${JSON.stringify(vars)}`;
        };
        return fn;
    },
}));

const pushMock = vi.fn();

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: pushMock,
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

import { KbSearchPalette } from './KbSearchPalette';
import type { KbSearchHit, KbSearchResult } from '@ever-works/contracts';

function hit(overrides: Partial<KbSearchHit> = {}): KbSearchHit {
    return {
        documentId: 'doc-' + Math.random().toString(36).slice(2, 9),
        path: 'brand/voice.md',
        title: 'Brand voice',
        class: 'brand',
        snippet: 'A document about <em>brand</em> voice.',
        score: 0.9,
        ...overrides,
    };
}

function mockSearchFetchOnce(result: KbSearchResult, capture?: { url?: string }) {
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (capture) capture.url = url;
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
}

function mockSearchFetchManyCalls(captured: string[], result: KbSearchResult) {
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        captured.push(url);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
}

describe('workbench KbSearchPalette', () => {
    beforeEach(() => {
        pushMock.mockReset();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('opens on Cmd+K and closes on Esc', async () => {
        render(<KbSearchPalette workId="work-1" />);

        // Initially closed.
        expect(screen.queryByTestId('kb-workbench-search-palette')).toBeNull();

        // Cmd+K → open.
        act(() => {
            fireEvent.keyDown(window, { key: 'k', metaKey: true });
        });
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-search-palette')).toBeTruthy();
        });

        // Esc → close.
        act(() => {
            fireEvent.keyDown(window, { key: 'Escape' });
        });
        await waitFor(() => {
            expect(screen.queryByTestId('kb-workbench-search-palette')).toBeNull();
        });
    });

    it('also opens on Ctrl+K (Windows)', async () => {
        render(<KbSearchPalette workId="work-1" />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-search-palette')).toBeTruthy();
        });
    });

    it('shows the empty state until the operator types', async () => {
        render(<KbSearchPalette workId="work-1" defaultOpen />);
        expect(screen.getByTestId('kb-workbench-search-palette-empty')).toBeTruthy();
    });

    it('debounces the search call to /api/works/:id/kb/search', async () => {
        vi.useFakeTimers();
        const captured: string[] = [];
        mockSearchFetchManyCalls(captured, { hits: [hit()], total: 1 });

        render(<KbSearchPalette workId="work-1" defaultOpen debounceMs={200} />);

        const input = screen.getByTestId('kb-workbench-search-palette-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'brand' } });

        // Before the debounce window elapses, no fetch yet.
        await act(async () => {
            vi.advanceTimersByTime(100);
        });
        expect(captured.length).toBe(0);

        // After the debounce window, exactly one fetch fires.
        await act(async () => {
            vi.advanceTimersByTime(200);
            await vi.runAllTimersAsync();
        });
        expect(captured.length).toBe(1);
        expect(captured[0]).toContain('/api/works/work-1/kb/search');
        expect(captured[0]).toContain('q=brand');
    });

    it('toggling a class filter drives a new search request', async () => {
        vi.useFakeTimers();
        const captured: string[] = [];
        mockSearchFetchManyCalls(captured, { hits: [], total: 0 });

        render(<KbSearchPalette workId="work-1" defaultOpen debounceMs={50} />);

        const input = screen.getByTestId('kb-workbench-search-palette-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'voice' } });

        await act(async () => {
            vi.advanceTimersByTime(60);
            await vi.runAllTimersAsync();
        });
        expect(captured.length).toBe(1);

        // Toggle the brand chip → second fetch fires with class=brand.
        const chips = screen.getAllByTestId(
            'kb-workbench-search-palette-class-chip',
        ) as HTMLButtonElement[];
        const brandChip = chips.find((c) => c.dataset.kbClass === 'brand');
        expect(brandChip).toBeTruthy();
        fireEvent.click(brandChip!);

        await act(async () => {
            vi.advanceTimersByTime(60);
            await vi.runAllTimersAsync();
        });

        expect(captured.length).toBeGreaterThanOrEqual(2);
        expect(captured[captured.length - 1]).toContain('class=brand');
    });

    it('clicking a result row pushes the workbench route via next-intl router', async () => {
        mockSearchFetchOnce({
            hits: [
                hit({ documentId: 'd1', path: 'brand/voice.md', title: 'Voice', class: 'brand' }),
            ],
            total: 1,
        });

        render(<KbSearchPalette workId="work-1" defaultOpen debounceMs={10} />);

        const input = screen.getByTestId('kb-workbench-search-palette-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'voice' } });

        await waitFor(
            () => {
                expect(screen.getByTestId('kb-workbench-search-palette-result')).toBeTruthy();
            },
            { timeout: 3000 },
        );

        const row = screen.getByTestId('kb-workbench-search-palette-result');
        fireEvent.click(row);

        await waitFor(() => {
            expect(pushMock).toHaveBeenCalledWith('/works/work-1/kb/brand/voice.md');
        });
    });

    it('shows a noResults branch when the search returns an empty hit list', async () => {
        mockSearchFetchOnce({ hits: [], total: 0 });

        render(<KbSearchPalette workId="work-1" defaultOpen debounceMs={10} />);

        const input = screen.getByTestId('kb-workbench-search-palette-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'asdf' } });

        await waitFor(
            () => {
                expect(screen.getByTestId('kb-workbench-search-palette-noresults')).toBeTruthy();
            },
            { timeout: 3000 },
        );
    });

    it('renders a loading shimmer while the search request is pending', async () => {
        // Mock fetch that never resolves so we observe the shimmer mid-flight.
        (globalThis as { fetch: typeof fetch }).fetch = vi.fn(
            () => new Promise(() => undefined),
        ) as unknown as typeof fetch;

        render(<KbSearchPalette workId="work-1" defaultOpen debounceMs={10} />);

        const input = screen.getByTestId('kb-workbench-search-palette-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'brand' } });

        await waitFor(
            () => {
                expect(screen.getByTestId('kb-workbench-search-palette-loading')).toBeTruthy();
            },
            { timeout: 3000 },
        );
    });

    it('locked toggle adds locked=true to the search params', async () => {
        vi.useFakeTimers();
        const captured: string[] = [];
        mockSearchFetchManyCalls(captured, { hits: [], total: 0 });

        render(<KbSearchPalette workId="work-1" defaultOpen debounceMs={20} />);

        const input = screen.getByTestId('kb-workbench-search-palette-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'voice' } });
        await act(async () => {
            vi.advanceTimersByTime(40);
            await vi.runAllTimersAsync();
        });
        expect(captured.length).toBeGreaterThanOrEqual(1);

        const toggle = screen.getByTestId(
            'kb-workbench-search-palette-locked-toggle',
        ) as HTMLInputElement;
        fireEvent.click(toggle);

        await act(async () => {
            vi.advanceTimersByTime(40);
            await vi.runAllTimersAsync();
        });

        const lastUrl = captured[captured.length - 1];
        expect(lastUrl).toContain('locked=true');
    });
});
