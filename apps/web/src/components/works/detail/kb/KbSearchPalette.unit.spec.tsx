import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
}));

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
// KbSearchPalette now imports `useRouter` from `@/i18n/navigation`
// (locale-aware). The legacy `next/navigation` mock stays as dead-code
// protection; both share the hoisted `pushMock` so existing
// `pushMock.mockReset()` / `toHaveBeenCalledWith(...)` assertions
// continue to work.
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock }),
}));
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

function jsonResponse(items: unknown[], total?: number): Response {
    return new Response(JSON.stringify({ items, total: total ?? items.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function makeDoc(
    overrides: Partial<{ id: string; path: string; title: string; class: string }> = {},
) {
    return {
        id: 'doc-1',
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

/**
 * EW-641 Phase 1B/d row 15 — search palette tests.
 *
 * The palette owns three things worth pinning:
 *  1. ⌘K / Ctrl+K global keyboard listener opens the dialog.
 *  2. Debounced fetch — successive keystrokes coalesce into a single
 *     `/api/works/:id/kb/search?q=…` GET.
 *  3. Selecting a result navigates via `router.push` and closes.
 *
 * Plus the empty-state, hint-state, and Escape-to-close affordances.
 */
describe('KbSearchPalette', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        pushMock.mockReset();
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('renders only the trigger button when closed', () => {
        render(<KbSearchPalette workId="work-1" />);
        expect(screen.getByTestId('kb-search-trigger')).toBeTruthy();
        expect(screen.queryByTestId('kb-search-palette')).toBeNull();
    });

    it('opens the palette on ⌘K and focuses the input', async () => {
        render(<KbSearchPalette workId="work-1" />);
        await act(async () => {
            fireEvent.keyDown(window, { key: 'k', metaKey: true });
            await Promise.resolve();
        });
        const palette = screen.getByTestId('kb-search-palette');
        expect(palette.getAttribute('data-open')).toBe('true');
        expect(document.activeElement).toBe(screen.getByTestId('kb-search-input'));
    });

    it('opens the palette on Ctrl+K as well', () => {
        render(<KbSearchPalette workId="work-1" />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(screen.getByTestId('kb-search-palette')).toBeTruthy();
    });

    it('opens via the trigger button click', () => {
        render(<KbSearchPalette workId="work-1" />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        expect(screen.getByTestId('kb-search-palette')).toBeTruthy();
    });

    it('shows the min-length hint until the query is long enough', () => {
        render(<KbSearchPalette workId="work-1" />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        const input = screen.getByTestId('kb-search-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'a' } });
        expect(screen.queryByTestId('kb-search-loading')).toBeNull();
        // The hint key is rendered (mock returns the key + interpolation).
        expect(screen.getByText(/hint min=2/)).toBeTruthy();
    });

    it('fires a debounced fetch and renders the result rows', async () => {
        fetchSpy.mockResolvedValueOnce(
            jsonResponse([
                makeDoc({ id: 'a', title: 'Brand voice', path: 'brand/voice.md', class: 'brand' }),
                makeDoc({
                    id: 'b',
                    title: 'Legal notice',
                    path: 'legal/notice.md',
                    class: 'legal',
                }),
            ]),
        );
        render(<KbSearchPalette workId="work-1" debounceMs={100} />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        const input = screen.getByTestId('kb-search-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'br' } });
        fireEvent.change(input, { target: { value: 'bra' } });
        fireEvent.change(input, { target: { value: 'brand' } });

        // Before the debounce window elapses, no fetch should have fired.
        expect(fetchSpy).not.toHaveBeenCalled();

        // Advance past the debounce + flush microtasks so the
        // `setState` after the awaited json() commits inside `act`.
        await act(async () => {
            vi.advanceTimersByTime(150);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/works/work-1/kb/search?q=brand');

        const rows = screen.getAllByTestId('kb-search-result');
        expect(rows.length).toBe(2);
        expect(rows[0].getAttribute('data-doc-id')).toBe('a');
        expect(rows[0].getAttribute('data-doc-path')).toBe('brand/voice.md');
        expect(rows[0].getAttribute('data-kb-class')).toBe('brand');
        expect(rows[0].getAttribute('data-active')).toBe('true');
        expect(rows[1].getAttribute('data-active')).toBe('false');
    });

    it('renders the empty state when the upstream returns zero results', async () => {
        fetchSpy.mockResolvedValueOnce(jsonResponse([]));
        render(<KbSearchPalette workId="work-1" debounceMs={50} />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        fireEvent.change(screen.getByTestId('kb-search-input'), { target: { value: 'zzz' } });
        await act(async () => {
            vi.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.getByTestId('kb-search-empty')).toBeTruthy();
        expect(screen.queryByTestId('kb-search-result')).toBeNull();
    });

    it('navigates to the doc on row click and closes the palette', async () => {
        fetchSpy.mockResolvedValueOnce(
            jsonResponse([
                makeDoc({ id: 'a', title: 'Brand voice', path: 'brand/voice.md', class: 'brand' }),
            ]),
        );
        render(<KbSearchPalette workId="work-1" debounceMs={50} />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        fireEvent.change(screen.getByTestId('kb-search-input'), { target: { value: 'br' } });
        await act(async () => {
            vi.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
        });

        fireEvent.click(screen.getByTestId('kb-search-result'));
        expect(pushMock).toHaveBeenCalledWith('/works/work-1/kb/brand/voice.md');
        expect(screen.queryByTestId('kb-search-palette')).toBeNull();
    });

    it('navigates via Enter on the focused result', async () => {
        fetchSpy.mockResolvedValueOnce(
            jsonResponse([
                makeDoc({ id: 'a', title: 'Brand voice', path: 'brand/voice.md', class: 'brand' }),
                makeDoc({ id: 'b', title: 'Legal', path: 'legal/notice.md', class: 'legal' }),
            ]),
        );
        render(<KbSearchPalette workId="work-1" debounceMs={50} />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        const input = screen.getByTestId('kb-search-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'br' } });
        await act(async () => {
            vi.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
        });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(pushMock).toHaveBeenCalledWith('/works/work-1/kb/legal/notice.md');
    });

    it('closes on Escape', () => {
        render(<KbSearchPalette workId="work-1" />);
        fireEvent.click(screen.getByTestId('kb-search-trigger'));
        const input = screen.getByTestId('kb-search-input') as HTMLInputElement;
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByTestId('kb-search-palette')).toBeNull();
    });
});
