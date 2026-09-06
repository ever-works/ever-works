import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MemoryReviewPanel } from './MemoryReviewPanel';

/**
 * EW-786 — the client half of the review-queue fix.
 *
 * The three BFF routes behind `/api/memory/review` now translate the per-tab
 * `x-ever-workspace` selector into the API's `x-scope-slug` and answer 400
 * without it, so this panel must reach them through `browserApiFetch`. A raw
 * `fetch()` here sent no selector: the queue read as empty for every
 * Organization (and so the panel hid itself), and both write verbs would now
 * refuse outright. The two halves only work together, which is what these
 * assertions pin.
 */
describe('MemoryReviewPanel workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    function selectorOf(index: number): string | null {
        const init = fetchMock.mock.calls[index][1] as RequestInit | undefined;
        return new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER);
    }

    beforeEach(() => {
        fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.startsWith('/api/memory/review?')) {
                return new Response(
                    JSON.stringify({
                        items: [
                            {
                                id: 'doc-1',
                                title: 'Merged onboarding notes',
                                path: 'memory/onboarding.md',
                            },
                        ],
                        total: 1,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return new Response(JSON.stringify({ id: 'doc-1' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['/org/ever/memory', 'org:ever'],
        ['/memory', 'personal'],
    ])(
        'loads the queue from %s with the selector derived from the visible URL',
        async (pathname, selector) => {
            window.history.replaceState({}, '', pathname);

            render(<MemoryReviewPanel />);

            await waitFor(() => expect(screen.getByTestId('memory-review-row')).toBeTruthy());
            expect(String(fetchMock.mock.calls[0][0])).toBe('/api/memory/review?limit=50');
            expect(selectorOf(0)).toBe(selector);
        },
    );

    it.each([
        ['memory-review-accept', 'accept'],
        ['memory-review-reject', 'reject'],
    ])('sends %s with the same selector the queue was read under', async (testId, verb) => {
        window.history.replaceState({}, '', '/org/ever/memory');

        render(<MemoryReviewPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-review-row')).toBeTruthy());

        fireEvent.click(screen.getByTestId(testId));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(String(fetchMock.mock.calls[1][0])).toBe(`/api/memory/review/doc-1/${verb}`);
        expect(selectorOf(1)).toBe('org:ever');
        // The row leaves the queue, which is the whole point of the verb
        // working — an unscoped write left it in place with an error.
        await waitFor(() => expect(screen.queryByTestId('memory-review-row')).toBeNull());
    });
});
