import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// The panel derives the download href from `usePathname()`; keep it in step
// with the `window.history` path the scoped-fetch assertions already use.
vi.mock('next/navigation', () => ({
    usePathname: () => window.location.pathname,
}));

vi.mock('@/components/ui/button', () => ({
    Button: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
        asChild ? <>{children}</> : <button type="button">{children}</button>,
}));

import { MemoryFilesPanel } from './MemoryFilesPanel';
import type { MemoryFileRow, MemoryFolderNode } from '@/lib/api/memory-files-types';

const folder: MemoryFolderNode = {
    id: 'fold-1',
    name: 'Invoices',
    parentId: null,
    path: '/Invoices',
    ownerAgentId: null,
    syncRepo: null,
    fileCount: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
};

const file: MemoryFileRow = {
    id: 'up-1',
    source: 'upload',
    filename: 'receipt.pdf',
    mime: 'application/pdf',
    size: 2048,
    folderId: null,
    ownerAgentId: null,
    provenance: { chat: true },
    updatedAt: '2026-08-02T00:00:00.000Z',
};

/** A file filed under an agent-private folder — its owner comes with it. */
const agentFile: MemoryFileRow = {
    id: 'up-2',
    source: 'upload',
    filename: 'agent-notes.md',
    mime: 'text/markdown',
    size: 512,
    folderId: 'fold-2',
    ownerAgentId: 'agent-7',
    provenance: { chat: true },
    updatedAt: '2026-08-03T00:00:00.000Z',
};

/** Records every request the panel makes and answers the three GETs. */
function installFetch(payload: { folders?: MemoryFolderNode[]; files?: MemoryFileRow[] } = {}) {
    const folders = payload.folders ?? [folder];
    const files = payload.files ?? [file];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.startsWith('/api/memory/files/tree')) {
            return { ok: true, status: 200, json: async () => ({ folders }) } as Response;
        }
        if (url.startsWith('/api/memory/files?') || url === '/api/memory/files') {
            return { ok: true, status: 200, json: async () => ({ files }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
}

/** DataTransfer shim — jsdom ships none (same helper as the KB dropzone spec). */
function dt(files: File[]): DataTransfer {
    return {
        types: ['Files'],
        files: {
            length: files.length,
            item: (i: number) => files[i] ?? null,
        } as unknown as FileList,
        dropEffect: 'none',
        effectAllowed: 'all',
    } as unknown as DataTransfer;
}

describe('MemoryFilesPanel', () => {
    beforeEach(() => {
        installFetch();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('lists folder rows before file rows for the browsed folder', async () => {
        render(<MemoryFilesPanel />);

        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());
        expect(screen.getByTestId('memory-files-preview-up-1')).toHaveTextContent('receipt.pdf');
    });

    it('searches across every folder and hides the folder rows while it does', async () => {
        const { calls } = installFetch();
        render(<MemoryFilesPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());

        fireEvent.change(screen.getByTestId('memory-files-search'), {
            target: { value: 'receipt' },
        });

        await waitFor(() => expect(calls.some((c) => c.includes('q=receipt'))).toBe(true));
        // A `q` list is folder-less by contract — the API searches everywhere.
        expect(calls.find((c) => c.includes('q=receipt'))).not.toContain('folderId');
        await waitFor(() =>
            expect(screen.queryByTestId('memory-files-folder-fold-1')).not.toBeInTheDocument(),
        );
    });

    it('uploads OS files dropped onto the table', async () => {
        const { calls } = installFetch();
        render(<MemoryFilesPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());

        const zone = screen.getByTestId('kb-workbench-dropzone');
        fireEvent.drop(zone, { dataTransfer: dt([new File(['x'], 'dropped.txt')]) });

        await waitFor(() => expect(calls).toContain('POST /api/memory/files/upload'));
    });

    it('opens the preview overlay from a file row', async () => {
        render(<MemoryFilesPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-files-preview-up-1')).toBeVisible());

        fireEvent.click(screen.getByTestId('memory-files-preview-up-1'));

        expect(screen.getByTestId('memory-files-preview')).toBeInTheDocument();
    });

    // The Global/Agents toggle sits above a table holding BOTH folder and
    // file rows, and a file carries the ownership of the folder it is
    // filed under. Filtering only the folder rows made "Global" show
    // agent-private files and "Agents" show every Global file.
    describe('scope toggle', () => {
        it('hides agent-owned files under the Global scope', async () => {
            installFetch({ files: [file, agentFile] });
            render(<MemoryFilesPanel />);
            await waitFor(() =>
                expect(screen.getByTestId('memory-files-preview-up-2')).toBeVisible(),
            );

            fireEvent.click(screen.getByTestId('memory-files-scope-global'));

            expect(screen.queryByTestId('memory-files-preview-up-2')).not.toBeInTheDocument();
            expect(screen.getByTestId('memory-files-preview-up-1')).toBeVisible();
        });

        it('hides Global files under the Agents scope', async () => {
            installFetch({ files: [file, agentFile] });
            render(<MemoryFilesPanel />);
            await waitFor(() =>
                expect(screen.getByTestId('memory-files-preview-up-1')).toBeVisible(),
            );

            fireEvent.click(screen.getByTestId('memory-files-scope-agents'));

            expect(screen.queryByTestId('memory-files-preview-up-1')).not.toBeInTheDocument();
            expect(screen.getByTestId('memory-files-preview-up-2')).toBeVisible();
        });

        it('shows both again under the All scope', async () => {
            installFetch({ files: [file, agentFile] });
            render(<MemoryFilesPanel />);
            await waitFor(() =>
                expect(screen.getByTestId('memory-files-preview-up-1')).toBeVisible(),
            );

            fireEvent.click(screen.getByTestId('memory-files-scope-agents'));
            fireEvent.click(screen.getByTestId('memory-files-scope-all'));

            expect(screen.getByTestId('memory-files-preview-up-1')).toBeVisible();
            expect(screen.getByTestId('memory-files-preview-up-2')).toBeVisible();
        });
    });

    it('exposes a sync-target editor so a folder can be pointed at a repo', async () => {
        const { calls } = installFetch();
        render(<MemoryFilesPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());

        fireEvent.click(screen.getByTestId('memory-files-sync-config-fold-1'));
        const form = screen.getByTestId('memory-files-sync-form-fold-1');
        const [owner, repo] = Array.from(form.querySelectorAll('input'));
        fireEvent.change(owner, { target: { value: 'acme' } });
        fireEvent.change(repo, { target: { value: 'docs' } });
        fireEvent.submit(form);

        await waitFor(() => expect(calls).toContain('PATCH /api/memory/files/folders/fold-1'));
    });
});

/**
 * EW-786 — the client half of the Files BFF scope contract.
 *
 * `GET /api/memory/files`, `PATCH /api/memory/files/move` and
 * `POST /api/memory/files/folders/:id/sync` now mint the API's
 * `X-Scope-Slug` from the per-tab `x-ever-workspace` selector and answer
 * 400 without it, so every call this panel makes has to go through
 * `browserApiFetch`. With a raw `fetch()` the list came back at HTTP 200
 * with the Organization's Memory originals silently missing — the Files
 * area looked complete and was not.
 *
 * The sibling tree / upload / folder-CRUD proxies are per-user and stay
 * unscoped, but they share this transport on purpose: `refresh()` fires
 * tree and list as one `Promise.all`, and splitting the transport across
 * that pair is how a half-landed change hides.
 */
describe('MemoryFilesPanel BFF transport', () => {
    /** Records the workspace selector each request carried. */
    function installScopedFetch(folders: MemoryFolderNode[] = [folder]) {
        const seen: Array<{ url: string; selector: string | null }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            seen.push({
                url,
                selector: new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER),
            });
            if (url.startsWith('/api/memory/files/tree')) {
                return new Response(JSON.stringify({ folders }), { status: 200 });
            }
            if (url.startsWith('/api/memory/files?') || url === '/api/memory/files') {
                return new Response(JSON.stringify({ files: [file] }), { status: 200 });
            }
            return new Response(JSON.stringify({ results: [] }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        return seen;
    }

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['/org/ever/memory', 'org:ever'],
        ['/memory', 'personal'],
    ])('stamps the %s selector on the initial tree + list pair', async (pathname, selector) => {
        window.history.replaceState({}, '', pathname);
        const seen = installScopedFetch();

        render(<MemoryFilesPanel />);

        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());
        const listed = seen.filter((r) => r.url.startsWith('/api/memory/files'));
        expect(listed.length).toBeGreaterThanOrEqual(2);
        // Every call, not just the scoped ones — the pair must not split.
        expect(listed.every((r) => r.selector === selector)).toBe(true);
    });

    it('stamps the selector on the move request', async () => {
        window.history.replaceState({}, '', '/org/ever/memory');
        const seen = installScopedFetch();
        render(<MemoryFilesPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());

        fireEvent.change(screen.getByTestId('memory-files-move-up-1'), {
            target: { value: 'fold-1' },
        });

        await waitFor(() =>
            expect(seen.some((r) => r.url === '/api/memory/files/move')).toBe(true),
        );
        expect(seen.find((r) => r.url === '/api/memory/files/move')?.selector).toBe('org:ever');
    });

    it('stamps the selector on the folder sync request', async () => {
        window.history.replaceState({}, '', '/org/ever/memory');
        // "Sync now" only renders once a git target is configured.
        const seen = installScopedFetch([
            { ...folder, syncRepo: { owner: 'acme', repo: 'docs', branch: 'main' } },
        ]);
        render(<MemoryFilesPanel />);
        await waitFor(() => expect(screen.getByTestId('memory-files-folder-fold-1')).toBeVisible());

        fireEvent.click(screen.getByTestId('memory-files-sync-fold-1'));

        const syncUrl = '/api/memory/files/folders/fold-1/sync';
        await waitFor(() => expect(seen.some((r) => r.url === syncUrl)).toBe(true));
        expect(seen.find((r) => r.url === syncUrl)?.selector).toBe('org:ever');
    });

    /**
     * The download control is a document navigation, so it cannot use
     * `browserApiFetch`; the tab's workspace rides on the href as `?scope=`
     * instead and `[id]/download/route.ts` reads it back. This closes the
     * EW-786 gap the previous version of this test pinned: org-scoped Memory
     * originals were listed by the scoped table and then 404'd on download.
     */
    it('puts the tab’s workspace selector on the download anchor', async () => {
        window.history.replaceState({}, '', '/org/ever/memory');
        installScopedFetch();
        render(<MemoryFilesPanel />);

        const anchor = await screen.findByTestId('memory-files-download-up-1');
        expect(anchor.tagName).toBe('A');
        expect(anchor).toHaveAttribute(
            'href',
            '/api/memory/files/up-1/download?source=upload&scope=org%3Aever',
        );
    });

    it('carries the personal selector on a personal-scope page', async () => {
        window.history.replaceState({}, '', '/memory');
        installScopedFetch();
        render(<MemoryFilesPanel />);

        const anchor = await screen.findByTestId('memory-files-download-up-1');
        expect(anchor).toHaveAttribute(
            'href',
            '/api/memory/files/up-1/download?source=upload&scope=personal',
        );
    });
});
