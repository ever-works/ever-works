'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
    fileTypeLabel,
    formatBytes,
    isTextLike,
    TEXT_PREVIEW_BYTES,
    type ComposerFileAttachment,
} from './attachments';

/**
 * Full-size viewer for attachments the composer can render itself: images
 * (from their local object URL) and text / code / CSV documents (read
 * straight off the local `File`). Both paths are entirely local — nothing
 * here waits on the upload to finish.
 *
 * PDFs and other binaries are intentionally absent: the uploads API serves
 * attachments with a non-inline disposition and the app's CSP does not allow
 * `blob:` frames, so an embedded viewer would either be blocked or require
 * relaxing the policy. Those cards offer a download instead.
 *
 * Rendered through a portal onto `document.body` rather than inside the
 * composer card: the card is `overflow-hidden` and uses backdrop blur, which
 * establishes a containing block for `position: fixed` — an overlay mounted
 * inside it would be clipped to the card's rounded rectangle.
 *
 * Keyboard: Escape closes, ArrowLeft/ArrowRight step through the set. Focus
 * moves to the close button on open and returns to whatever was focused
 * before (the thumbnail) on close.
 */

/** Placeholder so the hook below has a stable `File` to depend on. */
const NO_FILE = typeof File === 'undefined' ? null : new File([], '');

/**
 * Reads the head of a text file for display, flagging truncation.
 *
 * The resolved text is stored *with* the file it came from, so stepping from
 * one document to the next never shows the previous file's contents while the
 * new read is in flight.
 */
function useTextPreview(file: File | null, enabled: boolean) {
    const [loaded, setLoaded] = useState<{
        readonly file: File | null;
        readonly text: string;
        readonly truncated: boolean;
    }>({ file: null, text: '', truncated: false });

    useEffect(() => {
        if (!enabled || !file) return;
        let cancelled = false;
        const truncated = file.size > TEXT_PREVIEW_BYTES;
        // Slice before reading: a 20 MB log would otherwise be decoded in
        // full and handed to the DOM as one text node.
        void file
            .slice(0, TEXT_PREVIEW_BYTES)
            .text()
            .then((text) => {
                if (!cancelled) setLoaded({ file, text, truncated });
            })
            .catch(() => {
                if (!cancelled)
                    setLoaded({ file, text: 'Could not read this file.', truncated: false });
            });
        return () => {
            cancelled = true;
        };
    }, [file, enabled]);

    const ready = loaded.file === file;
    return {
        text: ready ? loaded.text : '',
        truncated: ready && loaded.truncated,
        loading: enabled && !ready,
    };
}

export interface AttachmentPreviewProps {
    readonly attachments: ReadonlyArray<ComposerFileAttachment>;
    /** Index into `attachments`; callers keep this in sync with the clicked card. */
    readonly index: number;
    readonly onIndexChange: (next: number) => void;
    readonly onClose: () => void;
    readonly testId?: string;
}

export function AttachmentPreview({
    attachments,
    index,
    onIndexChange,
    onClose,
    testId,
}: AttachmentPreviewProps) {
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const restoreFocusRef = useRef<Element | null>(null);

    const current = attachments[index];
    const count = attachments.length;
    const isImage = Boolean(current?.previewUrl);
    const asText = Boolean(current && !isImage && isTextLike(current.file, current.displayName));
    const preview = useTextPreview(current?.file ?? NO_FILE, asText);

    const step = useCallback(
        (delta: number) => {
            if (count < 2) return;
            onIndexChange((index + delta + count) % count);
        },
        [count, index, onIndexChange],
    );

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                step(1);
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                step(-1);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, step]);

    // Stop the page behind the overlay from scrolling, and hand focus to the
    // dialog so Escape / arrows work without the user clicking first.
    useEffect(() => {
        restoreFocusRef.current = document.activeElement;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        return () => {
            document.body.style.overflow = previousOverflow;
            const restore = restoreFocusRef.current;
            if (restore instanceof HTMLElement) restore.focus();
        };
    }, []);

    if (typeof document === 'undefined' || !current) return null;

    const downloadHref = current.previewUrl ?? current.url;

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Attachment preview: ${current.displayName}`}
            data-testid={testId ? `${testId}-lightbox` : undefined}
            className="fixed inset-0 z-100 flex flex-col bg-black/80 backdrop-blur-sm"
            // Only a click on the backdrop itself closes — clicks that
            // started on the content or the chrome must not fall through.
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="flex items-center gap-3 px-4 py-3 text-white">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={current.displayName}>
                        {current.displayName}
                    </p>
                    <p className="text-[11px] text-white/60">
                        {fileTypeLabel(current.displayName, current.file.type)} ·{' '}
                        {formatBytes(current.file.size)}
                        {count > 1 ? ` · ${index + 1} of ${count}` : ''}
                    </p>
                </div>
                {downloadHref ? (
                    <a
                        href={downloadHref}
                        download={current.displayName}
                        aria-label={`Download ${current.displayName}`}
                        title="Download"
                        className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                        <Download className="size-4" aria-hidden="true" />
                    </a>
                ) : null}
                <button
                    ref={closeButtonRef}
                    type="button"
                    onClick={onClose}
                    aria-label="Close attachment preview"
                    title="Close (Esc)"
                    className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    data-testid={testId ? `${testId}-lightbox-close` : undefined}
                >
                    <X className="size-5" aria-hidden="true" />
                </button>
            </div>

            <div
                className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6"
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) onClose();
                }}
            >
                {count > 1 ? (
                    <button
                        type="button"
                        onClick={() => step(-1)}
                        aria-label="Previous attachment"
                        className={cn(
                            'absolute left-2 z-10 rounded-full p-2.5 sm:left-4',
                            'bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20',
                        )}
                    >
                        <ChevronLeft className="size-5" aria-hidden="true" />
                    </button>
                ) : null}

                {isImage ? (
                    /* eslint-disable-next-line @next/next/no-img-element --
                       the source is a local `blob:` object URL for a file the
                       user just picked; next/image can neither optimize nor
                       allowlist it. */
                    <img
                        key={current.localId}
                        src={current.previewUrl}
                        alt={current.displayName}
                        decoding="async"
                        className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
                        data-testid={testId ? `${testId}-lightbox-image` : undefined}
                    />
                ) : (
                    <div
                        className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl dark:bg-zinc-900"
                        data-testid={testId ? `${testId}-lightbox-text` : undefined}
                    >
                        {preview.loading ? (
                            <p className="p-4 text-sm text-text-muted dark:text-text-muted-dark">
                                Reading file…
                            </p>
                        ) : (
                            <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs leading-relaxed text-text dark:text-text-dark">
                                {preview.text}
                            </pre>
                        )}
                        {preview.truncated ? (
                            <p className="border-t border-border/60 px-4 py-2 text-[11px] text-text-muted dark:border-white/10 dark:text-text-muted-dark">
                                Showing the first {formatBytes(TEXT_PREVIEW_BYTES)} of this file.
                            </p>
                        ) : null}
                    </div>
                )}

                {count > 1 ? (
                    <button
                        type="button"
                        onClick={() => step(1)}
                        aria-label="Next attachment"
                        className={cn(
                            'absolute right-2 z-10 rounded-full p-2.5 sm:right-4',
                            'bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20',
                        )}
                    >
                        <ChevronRight className="size-5" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}
