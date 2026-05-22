import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

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

// Stub `next/dynamic` so the canvas renders inline (no Suspense wait).
// Production path lazy-imports KbDocxViewerCanvas; tests use a stub.
vi.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => {
        const StubCanvas = (props: Record<string, unknown>) => (
            <div
                data-testid="kb-docx-canvas-stub"
                data-url={String(props.url ?? '')}
                data-filename={String(props.filename ?? '')}
            />
        );
        return StubCanvas;
    },
}));

import { KbDocxViewer, KB_DOCX_INLINE_MAX_BYTES } from './KbDocxViewer';

/**
 * EW-641 Phase 1B/d row 10 — `KbDocxViewer` mirrors the row 9 PDF
 * viewer's size-cap pattern. These tests lock the inline-vs-download
 * decision + selector contract the Playwright A14 suite uses.
 */
describe('KbDocxViewer', () => {
    it('renders the inline canvas when size is under the cap', () => {
        render(
            <KbDocxViewer
                url="https://files.example/voice.docx"
                sizeBytes={1024 * 1024}
                filename="voice.docx"
            />,
        );
        const root = screen.getByTestId('kb-docx-viewer');
        expect(root.getAttribute('data-mode')).toBe('inline');
        const canvas = screen.getByTestId('kb-docx-canvas-stub');
        expect(canvas.getAttribute('data-url')).toBe('https://files.example/voice.docx');
        expect(canvas.getAttribute('data-filename')).toBe('voice.docx');
        expect(screen.queryByTestId('kb-docx-download-fallback')).toBeNull();
    });

    it('renders the download fallback above the cap', () => {
        render(
            <KbDocxViewer
                url="https://files.example/huge.docx"
                sizeBytes={2_000_000}
                filename="huge.docx"
                maxInlineBytes={1_000_000}
            />,
        );
        const root = screen.getByTestId('kb-docx-viewer');
        expect(root.getAttribute('data-mode')).toBe('download');
        const link = screen.getByTestId('kb-docx-download-link') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/huge.docx');
        expect(link.getAttribute('download')).toBe('huge.docx');
        expect(screen.queryByTestId('kb-docx-canvas-stub')).toBeNull();
    });

    it('treats exact-cap size as inline (boundary is `>`, not `>=`)', () => {
        render(
            <KbDocxViewer
                url="https://files.example/edge.docx"
                sizeBytes={KB_DOCX_INLINE_MAX_BYTES}
                filename="edge.docx"
            />,
        );
        expect(screen.getByTestId('kb-docx-viewer').getAttribute('data-mode')).toBe('inline');
    });

    it('interpolates size + cap labels into the fallback body', () => {
        render(
            <KbDocxViewer
                url="https://files.example/huge.docx"
                sizeBytes={5 * 1024 * 1024}
                filename="huge.docx"
                maxInlineBytes={1 * 1024 * 1024}
            />,
        );
        const fallback = screen.getByTestId('kb-docx-download-fallback');
        expect(fallback.getAttribute('data-size-label')).toBe('5 MB');
        expect(fallback.getAttribute('data-cap-label')).toBe('1 MB');
        expect(fallback.textContent).toContain('size=5 MB');
        expect(fallback.textContent).toContain('cap=1 MB');
    });

    it('exposes the raw size + 30 MiB default cap', () => {
        expect(KB_DOCX_INLINE_MAX_BYTES).toBe(30 * 1024 * 1024);
        render(
            <KbDocxViewer url="https://files.example/x.docx" sizeBytes={4242} filename="x.docx" />,
        );
        expect(screen.getByTestId('kb-docx-viewer').getAttribute('data-size-bytes')).toBe('4242');
    });
});

// Direct canvas spec — exercises the fetch + mammoth wiring with stubs.
// Importing the canvas at module-top would tangle with the next/dynamic
// mock above, so this block lives in a sibling describe and re-imports
// after the module mocks are set up.
describe('KbDocxViewerCanvas', () => {
    it('fetches → converts → sanitises → renders the HTML', async () => {
        const arrayBuffer = new ArrayBuffer(8);
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => arrayBuffer,
        });
        const convertMock = vi.fn().mockResolvedValue({
            value: '<h2>Voice</h2><p>Brand voice <strong>matters</strong>.</p>',
        });

        const { KbDocxViewerCanvas } = await import('./KbDocxViewerCanvas');
        render(
            <KbDocxViewerCanvas
                url="https://files.example/voice.docx"
                filename="voice.docx"
                fetchImpl={fetchMock as unknown as typeof fetch}
                convertToHtml={convertMock}
            />,
        );

        // Starts in loading state.
        expect(screen.getByTestId('kb-docx-loading')).toBeTruthy();

        await waitFor(() => {
            expect(screen.getByTestId('kb-docx-canvas')).toBeTruthy();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://files.example/voice.docx',
            expect.objectContaining({ credentials: 'same-origin' }),
        );
        expect(convertMock).toHaveBeenCalledWith({ arrayBuffer });
        const canvas = screen.getByTestId('kb-docx-canvas');
        expect(canvas.innerHTML).toContain('<h2>Voice</h2>');
        expect(canvas.innerHTML).toContain('<strong>matters</strong>');
    });

    it('surfaces a render-failure pill + download link when fetch fails', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
        const convertMock = vi.fn();

        const { KbDocxViewerCanvas } = await import('./KbDocxViewerCanvas');
        render(
            <KbDocxViewerCanvas
                url="https://files.example/x.docx"
                filename="x.docx"
                fetchImpl={fetchMock as unknown as typeof fetch}
                convertToHtml={convertMock}
            />,
        );

        await waitFor(() => {
            expect(screen.getByTestId('kb-docx-error')).toBeTruthy();
        });
        const err = screen.getByTestId('kb-docx-error');
        expect(err.textContent).toContain('HTTP 503');
        const link = err.querySelector('a') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/x.docx');
        expect(link.getAttribute('download')).toBe('x.docx');
        expect(convertMock).not.toHaveBeenCalled();
    });

    it('strips disallowed tags before rendering the HTML', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(0),
        });
        const convertMock = vi.fn().mockResolvedValue({
            value: '<p>safe</p><script>alert(1)</script><p onclick="bad">click</p>',
        });

        const { KbDocxViewerCanvas } = await import('./KbDocxViewerCanvas');
        render(
            <KbDocxViewerCanvas
                url="https://files.example/x.docx"
                filename="x.docx"
                fetchImpl={fetchMock as unknown as typeof fetch}
                convertToHtml={convertMock}
            />,
        );

        await waitFor(() => {
            expect(screen.getByTestId('kb-docx-canvas')).toBeTruthy();
        });
        const html = screen.getByTestId('kb-docx-canvas').innerHTML;
        expect(html).toContain('<p>safe</p>');
        expect(html).toContain('<p>click</p>');
        expect(html).not.toContain('alert');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('<script');
    });
});
