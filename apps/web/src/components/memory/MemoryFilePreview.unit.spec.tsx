import React, { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Same shim the sibling viewer specs use: the real Button imports the
// locale-aware `Link`, which drags the Next router into jsdom.
// The overlay derives the download URL from `usePathname()`: stand in an Org.
vi.mock('next/navigation', () => ({
    usePathname: () => '/org/ever/memory',
}));

vi.mock('@/components/ui/button', () => ({
    Button: ({
        children,
        asChild,
        onClick,
        ...rest
    }: {
        children: ReactNode;
        asChild?: boolean;
        onClick?: () => void;
    } & Record<string, unknown>) => {
        if (asChild) return <>{children}</>;
        return (
            <button type="button" onClick={onClick} {...rest}>
                {children}
            </button>
        );
    },
}));

import { MemoryFilePreview } from './MemoryFilePreview';
import type { MemoryFileRow } from '@/lib/api/memory-files-types';

/**
 * Memory Files preview — the viewer dispatch has to agree with the KB
 * workbench (same `pickKbViewer` helper), and the download URL it hands
 * every viewer has to carry the `source` discriminator, since the two
 * upload spines share an id space only by accident.
 */
function makeRow(over: Partial<MemoryFileRow> = {}): MemoryFileRow {
    return {
        id: 'f-1',
        source: 'upload',
        filename: 'thing.bin',
        mime: 'application/octet-stream',
        size: 1024,
        folderId: null,
        ownerAgentId: null,
        provenance: { chat: true },
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over,
    };
}

describe('MemoryFilePreview', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('mounts the image viewer for an image MIME', () => {
        render(<MemoryFilePreview row={makeRow({ mime: 'image/png' })} onClose={() => {}} />);

        expect(screen.getByTestId('memory-files-preview-body')).toHaveAttribute(
            'data-viewer',
            'image',
        );
        expect(screen.getByTestId('kb-image-viewer')).toBeInTheDocument();
    });

    it('mounts the pdf viewer for application/pdf', () => {
        render(<MemoryFilePreview row={makeRow({ mime: 'application/pdf' })} onClose={() => {}} />);

        expect(screen.getByTestId('memory-files-preview-body')).toHaveAttribute(
            'data-viewer',
            'pdf',
        );
    });

    it('points the download link at the row’s own spine', () => {
        render(
            <MemoryFilePreview
                row={makeRow({ id: 'kb-9', source: 'kb-upload', mime: 'image/png' })}
                onClose={() => {}}
            />,
        );

        expect(screen.getByTestId('memory-files-preview-download')).toHaveAttribute(
            'href',
            '/api/memory/files/kb-9/download?source=kb-upload&scope=org%3Aever',
        );
    });

    it('fetches and renders small text payloads inline', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => 'hello from the file',
        });
        vi.stubGlobal('fetch', fetchMock);

        render(
            <MemoryFilePreview
                row={makeRow({ mime: 'text/plain', size: 32 })}
                onClose={() => {}}
            />,
        );

        await waitFor(() =>
            expect(screen.getByTestId('memory-files-preview-text')).toHaveTextContent(
                'hello from the file',
            ),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/memory/files/f-1/download?source=upload&scope=org%3Aever',
            expect.objectContaining({ cache: 'no-store' }),
        );
    });

    it('does not fetch a text payload above the inline cap', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        render(
            <MemoryFilePreview
                row={makeRow({ mime: 'text/plain', size: 10 * 1024 * 1024 })}
                onClose={() => {}}
            />,
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('memory-files-preview-unsupported')).toBeInTheDocument();
    });

    it('falls back to the unsupported card for a binary MIME with no viewer', () => {
        render(<MemoryFilePreview row={makeRow()} onClose={() => {}} />);

        expect(screen.getByTestId('memory-files-preview-unsupported')).toBeInTheDocument();
    });

    it('closes on the close button and on Escape', () => {
        const onClose = vi.fn();
        render(<MemoryFilePreview row={makeRow()} onClose={onClose} />);

        fireEvent.click(screen.getByTestId('memory-files-preview-close'));
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
