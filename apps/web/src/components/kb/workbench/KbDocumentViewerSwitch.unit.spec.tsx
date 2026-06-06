import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { KbDocumentDto } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
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

// Mock each leaf viewer so the switch's branch choice is observable
// without dragging in `next/dynamic`, `mammoth`, `exceljs`, etc.
function viewerStub(label: string) {
    return ({
        url,
        sizeBytes,
        filename,
        mimeType,
    }: {
        url: string;
        sizeBytes: number;
        filename: string;
        mimeType?: string;
    }) => (
        <div
            data-testid={`stub-${label}`}
            data-url={url}
            data-size={sizeBytes}
            data-filename={filename}
            data-mime={mimeType ?? ''}
        />
    );
}

vi.mock('@/components/works/detail/kb/viewers/KbPdfViewer', () => ({
    KbPdfViewer: viewerStub('pdf'),
    formatBytes: (n: number) => `${n} B`,
}));
vi.mock('@/components/works/detail/kb/viewers/KbDocxViewer', () => ({
    KbDocxViewer: viewerStub('docx'),
}));
vi.mock('@/components/works/detail/kb/viewers/KbXlsxViewer', () => ({
    KbXlsxViewer: viewerStub('xlsx'),
}));
vi.mock('@/components/works/detail/kb/viewers/KbImageViewer', () => ({
    KbImageViewer: viewerStub('image'),
}));
vi.mock('@/components/works/detail/kb/viewers/KbVideoViewer', () => ({
    KbVideoViewer: viewerStub('video'),
}));
vi.mock('@/components/works/detail/kb/viewers/KbAudioViewer', () => ({
    KbAudioViewer: viewerStub('audio'),
}));

import { KbDocumentViewerSwitch } from './KbDocumentViewerSwitch';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-1',
        workId: 'w-1',
        organizationId: null,
        path: 'freeform/file.pdf',
        slug: 'file',
        title: 'file',
        description: null,
        class: 'freeform',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'user',
        sourceUploadId: 'up-1',
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
 * EW-641 slice D — the dispatcher's job is to mount EXACTLY one of
 * `Kb{Pdf,Docx,Xlsx,Image,Video,Audio}Viewer` per supported MIME
 * (plus the unsupported / no-viewer banner). This spec locks the
 * MIME → viewer mapping. Each viewer is stubbed so we only assert
 * which branch fired, not what the leaf renders.
 *
 * `fileSize` is set well under every per-MIME cap so the gate
 * passes through to the leaf viewer.
 */
describe('KbDocumentViewerSwitch — MIME dispatch', () => {
    const baseProps = {
        workId: 'w-1',
        fileSize: 1024,
        downloadUrl: '/dl',
        filename: 'sample',
    };

    it('renders nothing for text/markdown (caller mounts the editor)', () => {
        const { container } = render(
            <KbDocumentViewerSwitch document={doc()} mimeType="text/markdown" {...baseProps} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing for an empty MIME', () => {
        const { container } = render(
            <KbDocumentViewerSwitch document={doc()} mimeType="" {...baseProps} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('mounts the PDF viewer for application/pdf', () => {
        render(
            <KbDocumentViewerSwitch document={doc()} mimeType="application/pdf" {...baseProps} />,
        );
        expect(screen.getByTestId('stub-pdf')).toBeTruthy();
    });

    it('mounts the DOCX viewer for the OOXML wordprocessing MIME', () => {
        render(
            <KbDocumentViewerSwitch
                document={doc()}
                mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                {...baseProps}
            />,
        );
        expect(screen.getByTestId('stub-docx')).toBeTruthy();
    });

    it('mounts the XLSX viewer for the OOXML spreadsheet MIME', () => {
        render(
            <KbDocumentViewerSwitch
                document={doc()}
                mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                {...baseProps}
            />,
        );
        expect(screen.getByTestId('stub-xlsx')).toBeTruthy();
    });

    it('mounts the XLSX viewer for text/csv (sheet view)', () => {
        render(<KbDocumentViewerSwitch document={doc()} mimeType="text/csv" {...baseProps} />);
        expect(screen.getByTestId('stub-xlsx')).toBeTruthy();
    });

    it('mounts the XLSX viewer for text/tab-separated-values', () => {
        render(
            <KbDocumentViewerSwitch
                document={doc()}
                mimeType="text/tab-separated-values"
                {...baseProps}
            />,
        );
        expect(screen.getByTestId('stub-xlsx')).toBeTruthy();
    });

    it('falls back to the unsupported banner for PPTX (no PPTX viewer in slice D)', () => {
        render(
            <KbDocumentViewerSwitch
                document={doc()}
                mimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
                {...baseProps}
            />,
        );
        expect(screen.getByTestId('kb-workbench-unsupported-viewer')).toBeTruthy();
        // Download anchor surfaces the proxy URL.
        const link = screen.getByTestId('kb-workbench-unsupported-download') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/dl');
    });

    it('mounts the image viewer for image/* MIMEs', () => {
        render(<KbDocumentViewerSwitch document={doc()} mimeType="image/png" {...baseProps} />);
        expect(screen.getByTestId('stub-image')).toBeTruthy();
    });

    it('mounts the video viewer for video/* MIMEs and forwards mimeType', () => {
        render(<KbDocumentViewerSwitch document={doc()} mimeType="video/mp4" {...baseProps} />);
        const stub = screen.getByTestId('stub-video');
        expect(stub.getAttribute('data-mime')).toBe('video/mp4');
    });

    it('mounts the audio viewer for audio/* MIMEs', () => {
        render(<KbDocumentViewerSwitch document={doc()} mimeType="audio/mpeg" {...baseProps} />);
        expect(screen.getByTestId('stub-audio')).toBeTruthy();
    });

    it('renders the unsupported banner for text/html (embedded HTML not wired in slice D)', () => {
        render(<KbDocumentViewerSwitch document={doc()} mimeType="text/html" {...baseProps} />);
        expect(screen.getByTestId('kb-workbench-unsupported-viewer')).toBeTruthy();
    });

    it('renders the unsupported banner for unknown MIMEs', () => {
        render(
            <KbDocumentViewerSwitch
                document={doc()}
                mimeType="application/x-not-real"
                {...baseProps}
            />,
        );
        const banner = screen.getByTestId('kb-workbench-unsupported-viewer');
        expect(banner.getAttribute('data-mime-type')).toBe('application/x-not-real');
    });

    it('blocks an over-cap PDF via the size gate before the leaf viewer mounts', () => {
        const sixtyMib = 60 * 1024 * 1024;
        render(
            <KbDocumentViewerSwitch
                document={doc()}
                mimeType="application/pdf"
                fileSize={sixtyMib}
                downloadUrl="/dl/huge.pdf"
                filename="huge.pdf"
                workId="w-1"
            />,
        );
        // Gate banner wins; the inner stub never renders.
        expect(screen.getByTestId('kb-workbench-size-blocked')).toBeTruthy();
        expect(screen.queryByTestId('stub-pdf')).toBeNull();
    });
});
