'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Phase 9 — shared prompt composer used by `/missions`, `/ideas`,
 * and `/new`. Modeled on the website's `LandingPromptForm` (see
 * `Ever Works/Code/website/packages/web/components/global/
 * LandingPromptForm.tsx`) so the dashboard's quick-add surfaces
 * read the same way visitors first met the product:
 *
 *   - Rounded card, sits on the page's natural dark background
 *     (no nested `bg-card` wrapper).
 *   - Typewriter placeholder cycling through example briefs.
 *   - Arrow submit button anchored bottom-right inside the card
 *     (no separate "Add" / "Create" button beside the textarea).
 *   - Enter submits; Shift+Enter inserts a newline.
 *   - Optional `belowInput` slot for chip strips (used by `/new`).
 */
const TYPE_MS = 35;
const ERASE_MS = 18;
const HOLD_TYPED_MS = 1800;
const HOLD_ERASED_MS = 350;

function useTypewriterPlaceholder(
    focused: boolean,
    examples: ReadonlyArray<string>,
    fallback?: string,
): string {
    const [index, setIndex] = useState(0);
    const [shown, setShown] = useState('');
    const [phase, setPhase] = useState<'typing' | 'holding' | 'erasing' | 'paused'>('typing');

    // Reset whenever the examples array reference changes so a
    // parent-controlled list swap (e.g. chip selection on /new)
    // doesn't leave a half-erased stale string on screen.
    useEffect(() => {
        setIndex(0);
        setShown('');
        setPhase(focused ? 'paused' : 'typing');
        // Only react to a *new* examples reference.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [examples]);

    useEffect(() => {
        if (focused) {
            setPhase('paused');
            return;
        }
        if (phase === 'paused') setPhase('typing');
    }, [focused, phase]);

    useEffect(() => {
        if (focused) return;
        if (!examples || examples.length === 0) return;
        const target = examples[index % examples.length];
        let timer: ReturnType<typeof setTimeout>;
        if (phase === 'typing') {
            if (shown.length < target.length) {
                timer = setTimeout(() => setShown(target.slice(0, shown.length + 1)), TYPE_MS);
            } else {
                timer = setTimeout(() => setPhase('holding'), HOLD_TYPED_MS);
            }
        } else if (phase === 'holding') {
            timer = setTimeout(() => setPhase('erasing'), HOLD_TYPED_MS);
        } else if (phase === 'erasing') {
            if (shown.length > 0) {
                timer = setTimeout(() => setShown(shown.slice(0, -1)), ERASE_MS);
            } else {
                timer = setTimeout(() => {
                    setIndex((i) => (i + 1) % examples.length);
                    setPhase('typing');
                }, HOLD_ERASED_MS);
            }
        }
        return () => clearTimeout(timer);
    }, [phase, shown, index, focused, examples]);

    return shown || examples[0] || fallback || '';
}

export interface PromptComposerProps {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    /** Min chars required for submit to be enabled. Defaults to 10. */
    minLength?: number;
    /** Hard cap enforced by the textarea. Defaults to 5000. */
    maxLength?: number;
    /** Number of rows in the textarea. Defaults to 3. */
    rows?: number;
    submitting?: boolean;
    /** Placeholder examples to cycle through. Falls back to the single `placeholder`. */
    placeholderExamples?: ReadonlyArray<string>;
    placeholder?: string;
    /** Accessible label for the textarea. */
    ariaLabel: string;
    /** Optional content rendered BELOW the textarea inside the same card. */
    belowInput?: ReactNode;
    /** Optional id for the textarea so an external <label> can point at it. */
    inputId?: string;
    /** Stable hook for tests / instrumentation. */
    testId?: string;
    /** Submit button tooltip. */
    submitTitle?: string;
    className?: string;
    /** Disable the input + submit entirely. */
    disabled?: boolean;
    /** Show the running character counter. Defaults to true. */
    showCounter?: boolean;
}

export function PromptComposer({
    value,
    onChange,
    onSubmit,
    minLength = 10,
    maxLength = 5000,
    rows = 3,
    submitting = false,
    placeholderExamples,
    placeholder,
    ariaLabel,
    belowInput,
    inputId,
    testId,
    submitTitle,
    className,
    disabled = false,
    showCounter = true,
}: PromptComposerProps) {
    const [focused, setFocused] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const trimmed = value.trim();
    const tooLong = trimmed.length > maxLength;
    const canSubmit = !disabled && !submitting && trimmed.length >= minLength && !tooLong;

    const examples = placeholderExamples && placeholderExamples.length > 0 ? placeholderExamples : [];
    const typed = useTypewriterPlaceholder(focused || value.length > 0, examples, placeholder);
    const effectivePlaceholder = examples.length > 0 ? typed : placeholder || '';

    function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit) onSubmit();
        }
    }

    return (
        <div
            className={cn(
                // Rounded composer card. No solid background — the page's
                // dark surface shows through, matching the website's
                // landing prompt. The subtle ring + border give it shape
                // without making it feel like a separate panel.
                'relative flex flex-col rounded-2xl border border-border/60 dark:border-white/10 bg-white/40 dark:bg-black/40 backdrop-blur',
                'shadow-sm ring-1 ring-black/[0.02] dark:ring-white/[0.04]',
                'transition focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/30',
                submitting && 'opacity-70 pointer-events-none',
                className,
            )}
        >
            <textarea
                ref={textareaRef}
                id={inputId}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={effectivePlaceholder}
                maxLength={maxLength}
                rows={rows}
                disabled={disabled || submitting}
                aria-label={ariaLabel}
                data-testid={testId}
                className="block w-full resize-none rounded-2xl bg-transparent px-5 pt-4 pb-2 text-base outline-none placeholder:text-text-muted dark:placeholder:text-text-muted-dark text-text dark:text-text-dark"
            />

            {belowInput ? <div className="px-4 pb-2">{belowInput}</div> : null}

            <div className="flex items-center gap-2 px-3 pb-2">
                <div className="ml-auto flex items-center gap-2">
                    {showCounter ? (
                        <span className="text-xs tabular-nums text-text-muted dark:text-text-muted-dark">
                            {trimmed.length}/{maxLength}
                        </span>
                    ) : null}
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={!canSubmit}
                        title={submitTitle}
                        aria-label={submitTitle || ariaLabel}
                        data-testid={testId ? `${testId}-submit` : undefined}
                        className={cn(
                            'inline-flex items-center justify-center rounded-full p-2.5 shadow-md transition',
                            'bg-primary text-white hover:bg-primary/90',
                            'disabled:cursor-not-allowed disabled:opacity-40',
                        )}
                    >
                        {submitting ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                            <ArrowRight className="size-4" aria-hidden="true" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
