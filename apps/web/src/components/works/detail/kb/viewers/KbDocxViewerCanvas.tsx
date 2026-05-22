'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { sanitizeDocxHtml } from './sanitize-docx-html';

interface KbDocxViewerCanvasProps {
    url: string;
    /** Used in the `<iframe srcdoc>` title + fallback download anchor. */
    filename: string;
    /**
     * Test seam — production code leaves this undefined and the canvas
     * dynamic-imports `mammoth/mammoth.browser` itself; specs supply a
     * stub so vitest doesn't need the real (DOM-heavy) library.
     */
    convertToHtml?: (input: { arrayBuffer: ArrayBuffer }) => Promise<{
        value: string;
        messages?: Array<{ type?: string; message?: string }>;
    }>;
    /** Test seam for fetch — defaults to the global. */
    fetchImpl?: typeof fetch;
}

type CanvasStatus = 'loading' | 'ready' | 'failed';

/**
 * EW-641 Phase 1B/d row 10 — DOCX → HTML render canvas.
 *
 * Fetches the original DOCX bytes from the supplied URL, hands them
 * to `mammoth.convertToHtml` (dynamic-imported so the ~150 KB lib
 * only ships when an operator actually opens a DOCX preview), pipes
 * the result through {@link sanitizeDocxHtml}, and injects the HTML
 * via `dangerouslySetInnerHTML`. The sanitiser strips anything
 * outside the allowlist (script/style/embed/object/iframe and any
 * `on*` event handlers) so a malicious DOCX can't XSS through the
 * Workbench origin.
 *
 * Lives in its own file because the parent `KbDocxViewer` lazy-loads
 * it via `next/dynamic`. Same pattern as the row 9 PDF viewer.
 */
export function KbDocxViewerCanvas({
    url,
    filename,
    convertToHtml,
    fetchImpl,
}: KbDocxViewerCanvasProps) {
    const t = useTranslations('dashboard.workDetail.kb.docx');
    const [status, setStatus] = useState<CanvasStatus>('loading');
    const [html, setHtml] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    // Track the in-flight request so the effect cleanup can ignore a
    // late response if the URL changes mid-render.
    const requestRef = useRef(0);

    useEffect(() => {
        const reqId = ++requestRef.current;
        setStatus('loading');
        setError(null);

        const run = async () => {
            try {
                const fetchFn = fetchImpl ?? fetch;
                const res = await fetchFn(url, { credentials: 'same-origin' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const arrayBuffer = await res.arrayBuffer();

                const convert =
                    convertToHtml ?? (await import('mammoth/mammoth.browser')).convertToHtml;
                const result = await convert({ arrayBuffer });
                if (reqId !== requestRef.current) return; // superseded

                const safe = sanitizeDocxHtml(result.value ?? '');
                setHtml(safe);
                setStatus('ready');
            } catch (e: unknown) {
                if (reqId !== requestRef.current) return;
                setError(e instanceof Error ? e.message : 'DOCX render failed');
                setStatus('failed');
            }
        };
        void run();
    }, [url, convertToHtml, fetchImpl]);

    if (status === 'loading') {
        return (
            <div
                data-testid="kb-docx-loading"
                aria-live="polite"
                className={cn(
                    'flex h-48 items-center justify-center rounded-md border',
                    'border-border bg-card/30 text-sm text-text-muted',
                    'dark:border-border-dark dark:bg-card-primary-dark/20 dark:text-text-muted-dark/70',
                )}
            >
                {t('loading')}
            </div>
        );
    }

    if (status === 'failed') {
        return (
            <div
                data-testid="kb-docx-error"
                role="alert"
                className={cn(
                    'rounded-md border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm',
                    'text-red-700 dark:text-red-300',
                )}
            >
                {t('renderFailed', { error: error ?? 'unknown error' })}{' '}
                <a
                    href={url}
                    download={filename}
                    className="ml-1 underline hover:no-underline"
                    rel="noopener noreferrer"
                >
                    {t('download')}
                </a>
            </div>
        );
    }

    return (
        <div
            data-testid="kb-docx-canvas"
            className={cn(
                'prose prose-sm dark:prose-invert max-w-none',
                'rounded-md border border-border dark:border-border-dark',
                'bg-card dark:bg-card-primary-dark/40 px-4 py-3 overflow-auto',
                'max-h-[36rem]',
            )}
            // sanitizeDocxHtml ran above — any element/attribute outside
            // the allowlist has been stripped. Mammoth itself doesn't
            // emit scripts, but a malicious uploader could embed
            // `<iframe srcdoc>` or `onclick` attributes inside oMath
            // elements; the sanitiser is the belt-and-braces guard.
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
