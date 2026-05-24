'use client';

import { useEffect, useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';

interface KbDeleteConfirmDialogProps {
    /** Dialog title — usually "Delete document?" or "Delete all N documents?". */
    title: string;
    /** Body copy explaining the consequence. */
    body: string;
    /** Optional inline error (e.g. partial bulk-delete failure). */
    error?: string | null;
    /** Confirmed-action label override. Defaults to the i18n "Delete". */
    confirmLabel?: string;
    /** Busy state — disables both buttons + shows the busy label on confirm. */
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * EW-641 KB workbench follow-up — confirm dialog for KB delete actions.
 *
 * Shared by the per-doc trash (`KbTreeDocRow`), the per-class bulk
 * trash (`KbTreeClassDeleteButton`), and the detail-page delete
 * (`KbDeleteDocButton`). Mirrors `KbClassifyModal`'s panel chrome
 * (dark-theme overlay fix included) so the surface feels consistent
 * with the other workbench dialogs.
 *
 * Selectors locked for tests / screen-reader paths:
 *  - `data-testid="kb-delete-confirm-dialog"` on the wrapper
 *  - `data-testid="kb-delete-confirm-cta"` on the primary "Delete"
 *    button
 *  - `data-testid="kb-delete-confirm-cancel"` on the cancel button
 */
export function KbDeleteConfirmDialog({
    title,
    body,
    error,
    confirmLabel,
    busy = false,
    onConfirm,
    onCancel,
}: KbDeleteConfirmDialogProps) {
    const t = useTranslations('dashboard.workDetail.kb.delete');
    const headingId = useId();
    const bodyId = useId();
    const dialogRef = useRef<HTMLDivElement | null>(null);

    // ESC closes the dialog (mirrors KbClassifyModal).
    useEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape' && !busy) onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [busy, onCancel]);

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            aria-describedby={bodyId}
            data-testid="kb-delete-confirm-dialog"
            ref={dialogRef}
            className={cn('fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4')}
            onClick={(event) => {
                if (event.target === event.currentTarget && !busy) onCancel();
            }}
        >
            <div
                className={cn(
                    'w-full max-w-md rounded-lg border border-border dark:border-border-dark',
                    // Elevated-surface convention from KbClassifyModal —
                    // `bg-card-dark` is solid so the dialog isn't see-through.
                    'bg-card dark:bg-card-dark p-5 shadow-xl',
                    'flex flex-col gap-3',
                )}
            >
                <header className="flex flex-col gap-1">
                    <h2
                        id={headingId}
                        className="text-base font-semibold text-text dark:text-text-dark"
                    >
                        {title}
                    </h2>
                    <p id={bodyId} className="text-sm text-text-muted dark:text-text-muted-dark/70">
                        {body}
                    </p>
                </header>

                {error ? (
                    <p
                        role="alert"
                        data-testid="kb-delete-confirm-error"
                        className="text-xs text-red-600 dark:text-red-400"
                    >
                        {error}
                    </p>
                ) : null}

                <footer className="flex items-center justify-end gap-2 pt-1">
                    <Button
                        type="button"
                        data-testid="kb-delete-confirm-cancel"
                        onClick={onCancel}
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        data-testid="kb-delete-confirm-cta"
                        onClick={onConfirm}
                        size="sm"
                        disabled={busy}
                        className={cn(
                            'bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600',
                            'text-white',
                        )}
                    >
                        {busy ? t('errorBusy') : (confirmLabel ?? t('confirm'))}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
