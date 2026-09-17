'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { MEMORY_FACT_BODY_MAX } from '@/lib/api/memory-facts-types';

/** What a submit handler reports back. A failure keeps the text in place. */
export type FactComposerResult = { ok: true } | { ok: false; message?: string | null };

interface FactComposerProps {
    /** Text to start from — the fact being edited, or a search to add as a fact. */
    initialBody?: string;
    onSubmit: (body: string) => Promise<FactComposerResult>;
    onCancel?: () => void;
    /** Label of the primary button. Defaults to "Save". */
    submitLabel?: string;
    autoFocus?: boolean;
    testId?: string;
}

/**
 * Add / edit form for one memory fact (AW-07).
 *
 * The character counter runs against the SAME `MEMORY_FACT_BODY_MAX` the API
 * enforces, counted on the trimmed text exactly as the API counts it, so the
 * composer can never accept a body the API then refuses for length.
 *
 * Saving is deliberately NOT optimistic: a failed save must never look
 * saved, so the text stays in the field, the button re-enables and the
 * refusal is shown until the owner edits or cancels.
 *
 * Keys: `Ctrl/Cmd+Enter` saves, `Esc` cancels and restores the previous text.
 */
export function FactComposer({
    initialBody = '',
    onSubmit,
    onCancel,
    submitLabel,
    autoFocus = true,
    testId = 'fact-composer',
}: FactComposerProps) {
    const t = useTranslations('dashboard.memoryPage.facts');
    const [body, setBody] = useState(initialBody);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const counterId = useId();

    useEffect(() => {
        if (!autoFocus) return;
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        // Cursor at the end, so "Add '<query>' as a fact" reads naturally.
        el.setSelectionRange(el.value.length, el.value.length);
    }, [autoFocus]);

    const trimmedLength = body.trim().length;
    const tooLong = trimmedLength > MEMORY_FACT_BODY_MAX;
    const canSave = trimmedLength > 0 && !tooLong && !saving;

    const submit = async () => {
        if (!canSave) return;
        setSaving(true);
        setError(null);
        try {
            const result = await onSubmit(body.trim());
            if (!result.ok) {
                setError(result.message || t('saveFailed'));
            }
        } catch {
            setError(t('saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    const cancel = () => {
        setBody(initialBody);
        setError(null);
        onCancel?.();
    };

    return (
        <form
            data-testid={testId}
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <label className="sr-only" htmlFor={`${counterId}-body`}>
                {t('bodyLabel')}
            </label>
            <textarea
                id={`${counterId}-body`}
                ref={textareaRef}
                data-testid={`${testId}-input`}
                value={body}
                rows={2}
                placeholder={t('composerPlaceholder')}
                aria-describedby={counterId}
                aria-invalid={tooLong || undefined}
                onChange={(event) => {
                    setBody(event.target.value);
                    if (error) setError(null);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        cancel();
                    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submit();
                    }
                }}
                className={cn(
                    'w-full resize-y rounded-lg px-3 py-2 text-sm outline-none transition-colors',
                    'bg-card dark:bg-card-primary-dark border border-card-border dark:border-white/9',
                    'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                    'focus:border-primary dark:focus:border-white/20 focus:ring-2 focus:ring-primary-800/20',
                    tooLong && 'border-red-500/60 dark:border-red-500/60',
                )}
            />
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <span
                    id={counterId}
                    data-testid={`${testId}-counter`}
                    className={cn(
                        'text-xs tabular-nums',
                        tooLong
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-text-muted dark:text-text-muted-dark',
                    )}
                >
                    {tooLong
                        ? t('bodyTooLong', { count: trimmedLength, max: MEMORY_FACT_BODY_MAX })
                        : t('bodyCounter', { count: trimmedLength, max: MEMORY_FACT_BODY_MAX })}
                </span>
                <div className="flex items-center gap-2">
                    {onCancel && (
                        <button
                            type="button"
                            data-testid={`${testId}-cancel`}
                            onClick={cancel}
                            disabled={saving}
                            className={cn(
                                'inline-flex items-center rounded-lg border px-3 py-1.5 text-sm transition-colors',
                                'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                                'text-text dark:text-text-dark hover:border-border-secondary dark:hover:border-white/20',
                                'disabled:opacity-60 disabled:cursor-not-allowed',
                            )}
                        >
                            {t('cancel')}
                        </button>
                    )}
                    <button
                        type="submit"
                        data-testid={`${testId}-save`}
                        disabled={!canSave}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                            'bg-primary text-white hover:bg-primary/90 dark:bg-white dark:text-gray-900 dark:hover:bg-white/90',
                            'disabled:opacity-60 disabled:cursor-not-allowed',
                        )}
                    >
                        {saving && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                        )}
                        {saving ? t('saving') : (submitLabel ?? t('save'))}
                    </button>
                </div>
            </div>
            {error && (
                <p
                    role="alert"
                    data-testid={`${testId}-error`}
                    className="text-xs text-red-600 dark:text-red-400"
                >
                    {error}
                </p>
            )}
        </form>
    );
}
