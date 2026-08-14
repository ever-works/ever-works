import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
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

/** Records every request the panel makes and answers the three GETs. */
function installFetch() {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.startsWith('/api/memory/files/tree')) {
            return { ok: true, status: 200, json: async () => ({ folders: [folder] }) } as Response;
        }
        if (url.startsWith('/api/memory/files?') || url === '/api/memory/files') {
            return { ok: true, status: 200, json: async () => ({ files: [file] }) } as Response;
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
