'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Horizontally-scrollable chip row for the dashboard prompt surfaces
 * (`/new`, `/works/new`). Mirrors the marketing site's
 * `GenerationTypeChips` (see
 * `Ever Works/Code/website/packages/web/components/global/
 * GenerationTypeChips.tsx`) so the dashboard and landing pages share
 * the same chip behavior:
 *
 *   - Chips overflow horizontally instead of wrapping to a second row.
 *   - Mouse-friendly ◀ / ▶ buttons appear when the row overflows; the
 *     buttons disable themselves at the start / end so they always
 *     reflect what's actually scrollable.
 *   - Edge gradient fades make the chips appear to slide under the
 *     buttons.
 *   - Trackpad + touch swipe still work — the scroll position drives
 *     the button enabled state through a `ResizeObserver` and a
 *     passive scroll listener.
 *   - `comingSoon` chips render as inert `<span>`s with a "SOON" badge
 *     (matching the marketing site) so the chip catalog can telegraph
 *     upcoming kinds without making them clickable.
 */
export interface PromptChip<TValue extends string = string> {
    readonly value: TValue;
    readonly label: ReactNode;
    readonly Icon: LucideIcon;
    /**
     * When true, the chip is rendered as a muted, inert span with a
     * "SOON" badge — the user sees it's coming but can't activate it.
     */
    readonly comingSoon?: boolean;
}

export interface PromptChipsRowProps<TValue extends string = string> {
    readonly chips: ReadonlyArray<PromptChip<TValue>>;
    readonly value: TValue | null;
    readonly onChange: (next: TValue | null) => void;
    /**
     * Optional aria-label for the row (defaults to "Pick a kind").
     * Pages with a translated label should pass the translated string.
     */
    readonly ariaLabel?: string;
    /** Stable hook for tests. */
    readonly testIdPrefix?: string;
    readonly className?: string;
}

export function PromptChipsRow<TValue extends string = string>({
    chips,
    value,
    onChange,
    ariaLabel = 'Pick a kind',
    testIdPrefix,
    className,
}: PromptChipsRowProps<TValue>) {
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const [overflowing, setOverflowing] = useState(false);
    const [atStart, setAtStart] = useState(true);
    const [atEnd, setAtEnd] = useState(false);

    const measure = useCallback(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const overflows = el.scrollWidth > el.clientWidth + 1;
        setOverflowing(overflows);
        setAtStart(el.scrollLeft <= 1);
        setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
    }, []);

    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        el.addEventListener('scroll', measure, { passive: true });
        return () => {
            ro.disconnect();
            el.removeEventListener('scroll', measure);
        };
    }, [measure]);

    const scrollBy = (delta: number) => {
        scrollerRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
    };

    return (
        <div className={cn('relative w-full', className)}>
            {overflowing && !atStart ? (
                <>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-12 bg-gradient-to-r from-background to-transparent dark:from-black"
                    />
                    <button
                        type="button"
                        onClick={() => scrollBy(-220)}
                        aria-label="Scroll chips left"
                        className="absolute left-0 top-1/2 z-20 grid -translate-y-1/2 place-items-center rounded-full border border-border/60 dark:border-white/10 bg-background/90 dark:bg-black/80 size-8 shadow-md hover:bg-foreground/5"
                        data-testid={testIdPrefix ? `${testIdPrefix}-scroll-left` : undefined}
                    >
                        <ChevronLeft className="size-4" aria-hidden="true" />
                    </button>
                </>
            ) : null}

            <div
                ref={scrollerRef}
                role="listbox"
                aria-label={ariaLabel}
                data-testid={testIdPrefix ? `${testIdPrefix}-chips` : undefined}
                className={cn(
                    'flex gap-2 overflow-x-auto overscroll-x-contain scroll-smooth py-1',
                    // Hide native scrollbar across browsers (Firefox uses
                    // `scrollbar-width`, WebKit/Chromium uses the
                    // `::-webkit-scrollbar` pseudo). Without both, some
                    // users still see a horizontal scrollbar even though
                    // the explicit ◀ / ▶ buttons are the intended
                    // affordance.
                    '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
                    // Asymmetric padding — only reserve room for an arrow
                    // button on the side that's currently showing one.
                    // Without this, the first chip ("Mission") looked like
                    // it had stray left padding when the row was scrolled
                    // to the start: the left button was hidden but the
                    // padding was still applied.
                    !overflowing && 'px-1',
                    overflowing && !atStart && 'pl-10',
                    overflowing && atStart && 'pl-1',
                    overflowing && !atEnd && 'pr-10',
                    overflowing && atEnd && 'pr-1',
                )}
            >
                {chips.map((c) => {
                    const { Icon } = c;
                    if (c.comingSoon) {
                        return (
                            <span
                                key={c.value}
                                role="option"
                                aria-disabled="true"
                                aria-selected="false"
                                title="Coming soon"
                                className="inline-flex shrink-0 cursor-not-allowed select-none items-center gap-2 rounded-full border px-3 py-1.5 text-sm border-border/40 dark:border-white/5 bg-foreground/[0.03] text-text-muted dark:text-text-muted-dark"
                                data-testid={
                                    testIdPrefix ? `${testIdPrefix}-${c.value}` : undefined
                                }
                            >
                                <Icon className="size-3.5 opacity-70" aria-hidden="true" />
                                <span className="whitespace-nowrap">{c.label}</span>
                                <span
                                    aria-label="Coming soon"
                                    className="ml-1 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted dark:bg-white/10 dark:text-text-muted-dark"
                                >
                                    Soon
                                </span>
                            </span>
                        );
                    }
                    const selected = value === c.value;
                    return (
                        <button
                            key={c.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            // role="option" doesn't support aria-pressed
                            // (jsx-a11y/role-supports-aria-props). aria-selected
                            // is the right toggle state inside a listbox; tests
                            // querying by `[aria-selected]` get the live chips.
                            onClick={() => onChange(selected ? null : c.value)}
                            data-testid={testIdPrefix ? `${testIdPrefix}-${c.value}` : undefined}
                            className={cn(
                                'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors',
                                selected
                                    ? 'border-primary/60 bg-primary/10 text-primary shadow-sm'
                                    : 'border-border/60 dark:border-white/10 bg-transparent text-text-secondary dark:text-text-secondary-dark hover:border-primary/40',
                            )}
                        >
                            <Icon className="size-3.5" aria-hidden="true" />
                            {c.label}
                        </button>
                    );
                })}
            </div>

            {overflowing && !atEnd ? (
                <>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute right-0 top-0 bottom-0 z-10 w-12 bg-gradient-to-l from-background to-transparent dark:from-black"
                    />
                    <button
                        type="button"
                        onClick={() => scrollBy(220)}
                        aria-label="Scroll chips right"
                        className="absolute right-0 top-1/2 z-20 grid -translate-y-1/2 place-items-center rounded-full border border-border/60 dark:border-white/10 bg-background/90 dark:bg-black/80 size-8 shadow-md hover:bg-foreground/5"
                        data-testid={testIdPrefix ? `${testIdPrefix}-scroll-right` : undefined}
                    >
                        <ChevronRight className="size-4" aria-hidden="true" />
                    </button>
                </>
            ) : null}
        </div>
    );
}
