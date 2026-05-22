import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string>) => {
        if (!args) return key;
        // Echo the args so the body assertion can verify interpolation.
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
        if (asChild) {
            // mimic shadcn `asChild` slot semantics — render the lone
            // child verbatim so the test asserts the anchor itself.
            return <>{children}</>;
        }
        return (
            <button type="button" onClick={onClick} {...rest}>
                {children}
            </button>
        );
    },
}));

// Stub `next/dynamic` so the lazy-loaded canvas renders inline in
// the test (no real dynamic import → no `Suspense` wait).
vi.mock('next/dynamic', () => ({
    __esModule: true,
    default: (loader: () => Promise<{ default: React.ComponentType<unknown> }>) => {
        const StubCanvas = (props: Record<string, unknown>) => (
            <div data-testid="kb-pdf-canvas-stub" data-url={String(props.url)}>
                {String(props.title ?? '')}
            </div>
        );
        // The dynamic loader is captured but not awaited — production
        // path lazy-imports `KbPdfViewerCanvas`; tests just render a
        // placeholder with the same selector shape.
        void loader;
        return StubCanvas;
    },
}));

import { formatBytes, KB_PDF_INLINE_MAX_BYTES, KbPdfViewer } from './KbPdfViewer';

/**
 * EW-641 Phase 1B/d row 9 — `KbPdfViewer` flips between an inline
 * canvas and a download fallback based on size. Selectors locked for
 * Playwright A14 — these tests lock the boundary + the `data-mode`
 * attribute that the e2e assertion uses.
 */
describe('KbPdfViewer', () => {
    it('renders the inline canvas when size is under the cap', () => {
        render(
            <KbPdfViewer
                url="https://files.example/voice.pdf"
                sizeBytes={1024 * 1024}
                filename="voice.pdf"
            />,
        );
        const root = screen.getByTestId('kb-pdf-viewer');
        expect(root.getAttribute('data-mode')).toBe('inline');
        const canvas = screen.getByTestId('kb-pdf-canvas-stub');
        expect(canvas.getAttribute('data-url')).toBe('https://files.example/voice.pdf');
        expect(canvas.textContent).toBe('voice.pdf');
        expect(screen.queryByTestId('kb-pdf-download-fallback')).toBeNull();
    });

    it('renders the download fallback when size is above the cap', () => {
        // Override the cap so the test doesn't have to fake 30 MiB.
        render(
            <KbPdfViewer
                url="https://files.example/huge.pdf"
                sizeBytes={2_000_000}
                filename="huge.pdf"
                maxInlineBytes={1_000_000}
            />,
        );
        const root = screen.getByTestId('kb-pdf-viewer');
        expect(root.getAttribute('data-mode')).toBe('download');
        const link = screen.getByTestId('kb-pdf-download-link') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/huge.pdf');
        expect(link.getAttribute('download')).toBe('huge.pdf');
        expect(screen.queryByTestId('kb-pdf-canvas-stub')).toBeNull();
    });

    it('treats exact-cap size as inline (boundary is `>`, not `>=`)', () => {
        render(
            <KbPdfViewer
                url="https://files.example/edge.pdf"
                sizeBytes={KB_PDF_INLINE_MAX_BYTES}
                filename="edge.pdf"
            />,
        );
        expect(screen.getByTestId('kb-pdf-viewer').getAttribute('data-mode')).toBe('inline');
    });

    it('interpolates the size + cap into the fallback body copy', () => {
        render(
            <KbPdfViewer
                url="https://files.example/huge.pdf"
                sizeBytes={5 * 1024 * 1024}
                filename="huge.pdf"
                maxInlineBytes={1 * 1024 * 1024}
            />,
        );
        const fallback = screen.getByTestId('kb-pdf-download-fallback');
        expect(fallback.getAttribute('data-size-label')).toBe('5 MB');
        expect(fallback.getAttribute('data-cap-label')).toBe('1 MB');
        // The mocked translator echoes `key arg1=v1 arg2=v2`, so we
        // can assert the interpolated payload made it through.
        expect(fallback.textContent).toContain('size=5 MB');
        expect(fallback.textContent).toContain('cap=1 MB');
    });

    it('exposes the raw size on the root via data-size-bytes', () => {
        render(<KbPdfViewer url="https://files.example/x.pdf" sizeBytes={4242} filename="x.pdf" />);
        expect(screen.getByTestId('kb-pdf-viewer').getAttribute('data-size-bytes')).toBe('4242');
    });
});

describe('formatBytes', () => {
    it.each([
        [0, '0 B'],
        [512, '512 B'],
        [1024, '1 KB'],
        [1536, '1.5 KB'],
        [1024 * 1024, '1 MB'],
        [Math.round(1.5 * 1024 * 1024), '1.5 MB'],
        [30 * 1024 * 1024, '30 MB'],
        [1024 * 1024 * 1024, '1 GB'],
    ])('formats %s bytes as %s', (input, expected) => {
        expect(formatBytes(input)).toBe(expected);
    });

    it('exports the spec §14.5 default cap', () => {
        expect(KB_PDF_INLINE_MAX_BYTES).toBe(30 * 1024 * 1024);
    });
});
