'use client';

import { cn } from '@/lib/utils/cn';

interface KbPdfViewerCanvasProps {
    url: string;
    title: string;
    // Security: sandbox is intentionally NOT a prop — callers must not be able to
    // add `allow-scripts` to a same-origin iframe (would enable sandbox escape).
}

/**
 * EW-641 Phase 1B/d row 9 — inline PDF render surface.
 *
 * Uses the browser's built-in PDF renderer via `<iframe>`. The
 * follow-up row #11 (XLSX grid viewer) plus a richer
 * `react-pdf`-based renderer (text selection, page nav, search) are
 * scoped for the post-MVP UX pass — Chrome / Firefox / Safari all
 * render PDFs natively in iframes today, so this ships A14 (30 MB
 * cap render + download fallback) without bundling a PDF.js worker
 * into every Workbench page load.
 *
 * Lives in its own file so the parent `KbPdfViewer` can `next/dynamic`
 * the canvas — keeps the initial Workbench bundle lean (the iframe
 * is trivial today but the upgrade path is to swap this canvas for a
 * react-pdf wrapper without touching `KbPdfViewer`).
 */
export function KbPdfViewerCanvas({ url, title }: KbPdfViewerCanvasProps) {
    return (
        <iframe
            src={url}
            title={title}
            data-testid="kb-pdf-iframe"
            // Security: hard-coded — never include `allow-scripts` here;
            // combining allow-same-origin + allow-scripts enables sandbox escape.
            sandbox="allow-same-origin"
            className={cn(
                'h-[36rem] w-full rounded-md border',
                'border-border dark:border-border-dark',
                'bg-card dark:bg-card-primary-dark/40',
            )}
        />
    );
}
