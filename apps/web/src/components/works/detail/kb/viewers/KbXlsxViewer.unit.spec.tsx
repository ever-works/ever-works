import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
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

vi.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => {
        const StubCanvas = (props: Record<string, unknown>) => (
            <div
                data-testid="kb-xlsx-canvas-stub"
                data-url={String(props.url ?? '')}
                data-filename={String(props.filename ?? '')}
            />
        );
        return StubCanvas;
    },
}));

// Stub the thin exceljs loader so vitest never has to resolve the
// real exceljs package — exceljs pulls in jszip / archiver and
// OOMs the V8 worker on Windows during module discovery. The canvas
// spec uses `workbookFactory` to inject its own stub workbook, so
// the loader is only reached when a test doesn't override it.
vi.mock('./load-exceljs-workbook', () => ({
    createExceljsWorkbook: async () => ({
        worksheets: [],
        xlsx: { load: async () => {} },
    }),
}));

import { KbXlsxViewer, KB_XLSX_INLINE_MAX_BYTES } from './KbXlsxViewer';

/**
 * EW-641 Phase 1B/d row 11 — `KbXlsxViewer` mirrors the row 9/10
 * viewers but uses a tighter 5 MiB cap (spec §14.5 — parsing a
 * workbook is more expensive than rendering a PDF iframe). These
 * tests lock the inline-vs-download decision the Playwright A14 suite
 * keys off.
 */
describe('KbXlsxViewer', () => {
    it('renders the inline canvas under the cap', () => {
        render(
            <KbXlsxViewer
                url="https://files.example/budget.xlsx"
                sizeBytes={1024 * 1024}
                filename="budget.xlsx"
            />,
        );
        const root = screen.getByTestId('kb-xlsx-viewer');
        expect(root.getAttribute('data-mode')).toBe('inline');
        const canvas = screen.getByTestId('kb-xlsx-canvas-stub');
        expect(canvas.getAttribute('data-url')).toBe('https://files.example/budget.xlsx');
        expect(canvas.getAttribute('data-filename')).toBe('budget.xlsx');
        expect(screen.queryByTestId('kb-xlsx-download-fallback')).toBeNull();
    });

    it('renders the download fallback above the cap', () => {
        render(
            <KbXlsxViewer
                url="https://files.example/huge.xlsx"
                sizeBytes={2_000_000}
                filename="huge.xlsx"
                maxInlineBytes={1_000_000}
            />,
        );
        const root = screen.getByTestId('kb-xlsx-viewer');
        expect(root.getAttribute('data-mode')).toBe('download');
        const link = screen.getByTestId('kb-xlsx-download-link') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/huge.xlsx');
        expect(link.getAttribute('download')).toBe('huge.xlsx');
        expect(screen.queryByTestId('kb-xlsx-canvas-stub')).toBeNull();
    });

    it('treats exact-cap size as inline (boundary is `>`, not `>=`)', () => {
        render(
            <KbXlsxViewer
                url="https://files.example/edge.xlsx"
                sizeBytes={KB_XLSX_INLINE_MAX_BYTES}
                filename="edge.xlsx"
            />,
        );
        expect(screen.getByTestId('kb-xlsx-viewer').getAttribute('data-mode')).toBe('inline');
    });

    it('exposes the default 5 MiB cap', () => {
        expect(KB_XLSX_INLINE_MAX_BYTES).toBe(5 * 1024 * 1024);
    });

    it('interpolates size + cap into the fallback body copy', () => {
        render(
            <KbXlsxViewer
                url="https://files.example/huge.xlsx"
                sizeBytes={2 * 1024 * 1024}
                filename="huge.xlsx"
                maxInlineBytes={1 * 1024 * 1024}
            />,
        );
        const fallback = screen.getByTestId('kb-xlsx-download-fallback');
        expect(fallback.getAttribute('data-size-label')).toBe('2 MB');
        expect(fallback.getAttribute('data-cap-label')).toBe('1 MB');
        expect(fallback.textContent).toContain('size=2 MB');
        expect(fallback.textContent).toContain('cap=1 MB');
    });
});
