import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MemoryUploadsPanel } from './MemoryUploadsPanel';

/** Records the workspace selector each request carried. */
function installScopedFetch(listStatus = 200) {
    const seen: Array<{ url: string; method: string; selector: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({
            url,
            method: init?.method ?? 'GET',
            selector: new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER),
        });
        if (url.startsWith('/api/memory/uploads?')) {
            return new Response(
                JSON.stringify({
                    items: [
                        {
                            id: 'up-1',
                            originalFilename: 'handbook.pdf',
                            mimeType: 'application/pdf',
                            fileSize: 4096,
                            extractionStatus: 'succeeded',
                            createdAt: '2026-08-01T00:00:00.000Z',
                        },
                    ],
                    total: 1,
                }),
                { status: listStatus },
            );
        }
        return new Response(JSON.stringify({}), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return seen;
}

/**
 * EW-786 — the client half of the global-Memory Originals scope contract.
 *
 * This panel's whole subject is "the active Organization's originals", and
 * the BFF can only tell the API which Organization that is by turning the
 * per-tab `x-ever-workspace` selector into `X-Scope-Slug`. Both
 * `/api/memory/uploads` handlers now 400 without that selector, so both
 * calls have to go through `browserApiFetch`.
 *
 * The pre-fix failure was invisible rather than loud: `listMemoryUploads`
 * answered `{ items: [], total: 0 }` at HTTP 200 (an empty panel that looked
 * like an empty org) and `createMemoryUpload` threw 422, which this panel
 * renders as `noOrg` — telling a user staring at their Organization that
 * they had none.
 */
describe('MemoryUploadsPanel BFF transport', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['/org/ever/memory', 'org:ever'],
        ['/memory', 'personal'],
    ])('lists originals from %s with the workspace selector', async (pathname, selector) => {
        window.history.replaceState({}, '', pathname);
        const seen = installScopedFetch();

        render(<MemoryUploadsPanel />);

        await waitFor(() => expect(screen.getByTestId('memory-upload-row')).toBeVisible());
        const list = seen.find((r) => r.url.startsWith('/api/memory/uploads?'));
        expect(list?.selector).toBe(selector);
    });

    it('uploads with the workspace selector so the API can resolve the org', async () => {
        window.history.replaceState({}, '', '/org/ever/memory');
        const seen = installScopedFetch();
        render(<MemoryUploadsPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-upload-row')).toBeVisible());

        fireEvent.change(screen.getByTestId('memory-upload-input'), {
            target: { files: [new File(['x'], 'notes.md', { type: 'text/markdown' })] },
        });

        await waitFor(() =>
            expect(seen.some((r) => r.method === 'POST' && r.url === '/api/memory/uploads')).toBe(
                true,
            ),
        );
        expect(seen.find((r) => r.method === 'POST')?.selector).toBe('org:ever');
    });
});
