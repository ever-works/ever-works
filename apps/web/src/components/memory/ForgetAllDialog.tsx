'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    MEMORY_FACT_FORGET_ALL_CONFIRMATION,
    MEMORY_FACT_FORGET_RETENTION_DAYS,
} from '@/lib/api/memory-facts-types';

interface ForgetAllDialogProps {
    open: boolean;
    counts: { active: number; proposed: number };
    onCancel: () => void;
    /** Resolve `true` on success (the dialog closes), `false` to keep it open. */
    onConfirm: () => Promise<boolean>;
}

/**
 * The "Forget all" confirmation (AW-07).
 *
 * The blast radius is stated BEFORE the confirmation field — what goes, and
 * what is explicitly not touched — and the destructive button stays disabled
 * until the field holds exactly `FORGET ALL`. Nothing about the gate is
 * forgiving on purpose: no trimming, no case folding, because the API applies
 * the same exact comparison and the two must never disagree.
 *
 * `Esc` and the backdrop cancel and never confirm; the dialog primitive
 * returns focus to the trigger when it closes.
 */
export function ForgetAllDialog({ open, counts, onCancel, onConfirm }: ForgetAllDialogProps) {
    const t = useTranslations('dashboard.memoryPage.forgetAllDialog');
    const [typed, setTyped] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [failed, setFailed] = useState(false);
    const inputId = useId();

    useEffect(() => {
        if (!open) {
            setTyped('');
            setFailed(false);
            setSubmitting(false);
        }
    }, [open]);

    const armed = typed === MEMORY_FACT_FORGET_ALL_CONFIRMATION;

    const confirm = async () => {
        if (!armed || submitting) return;
        setSubmitting(true);
        setFailed(false);
        try {
            const ok = await onConfirm();
            if (!ok) setFailed(true);
        } catch {
            setFailed(true);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next && !submitting) onCancel();
            }}
        >
            <DialogContent>
                <div data-testid="forget-all-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </DialogTitle>
                        <DialogDescription>
                            {t('body', { active: counts.active, proposed: counts.proposed })}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-2 text-sm text-text-muted dark:text-text-muted-dark">
                        <p data-testid="forget-all-not-affected">{t('notAffected')}</p>
                        <p>{t('restoreNote', { days: MEMORY_FACT_FORGET_RETENTION_DAYS })}</p>
                        <p>{t('resumeNote')}</p>
                    </div>

                    <form
                        className="mt-4 flex flex-col gap-1.5"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void confirm();
                        }}
                    >
                        <label
                            htmlFor={inputId}
                            className="text-sm font-medium text-text dark:text-text-dark"
                        >
                            {t('confirmLabel', { word: MEMORY_FACT_FORGET_ALL_CONFIRMATION })}
                        </label>
                        <input
                            id={inputId}
                            data-testid="forget-all-confirm-input"
                            value={typed}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => setTyped(event.target.value)}
                            className={cn(
                                'w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors',
                                'bg-card dark:bg-card-primary-dark border border-card-border dark:border-white/9',
                                'text-text dark:text-text-dark',
                                'focus:border-primary dark:focus:border-white/20 focus:ring-2 focus:ring-primary-800/20',
                            )}
                        />
                        {failed && (
                            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                                {t('failed')}
                            </p>
                        )}

                        <DialogFooter>
                            <button
                                type="button"
                                data-testid="forget-all-cancel"
                                onClick={onCancel}
                                disabled={submitting}
                                className={cn(
                                    'inline-flex items-center rounded-lg border px-3 py-2 text-sm transition-colors',
                                    'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                                    'text-text dark:text-text-dark hover:border-border-secondary dark:hover:border-white/20',
                                    'disabled:opacity-60 disabled:cursor-not-allowed',
                                )}
                            >
                                {t('cancel')}
                            </button>
                            <button
                                type="submit"
                                data-testid="forget-all-confirm"
                                disabled={!armed || submitting}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                                    'bg-red-600 text-white hover:bg-red-600/90',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {submitting && (
                                    <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                                )}
                                {t('confirm')}
                            </button>
                        </DialogFooter>
                    </form>
                </div>
            </DialogContent>
        </Dialog>
    );
}
