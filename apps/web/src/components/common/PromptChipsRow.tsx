'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Arrow-paged chip row for the dashboard prompt surfaces (`/new`,
 * `/works/new`, `/works`).
 *
 * Behavior:
 *   - Chips never wrap to a second row. When the row's natural width
 *     exceeds the container, ◀ / ▶ buttons appear on the side that
 *     has hidden chips; the buttons disable themselves at the start /
 *     end so they always reflect what's actually pannable.
 *   - Edge gradient fades make the hidden chips appear to slide under
 *     the buttons.
 *   - There is **no native scrolling** — the container uses
 *     `overflow-hidden` and the inner track is panned via
 *     `transform: translateX(...)` controlled by React state. Trackpad
 *     swipes, touch gestures, and mousewheel cannot move the chips;
 *     only the arrow buttons do. Keyboard arrow keys on a focused chip
 *     fall back to the browser's default behavior.
 *   - `comingSoon` chips render as inert `<span>`s with a "SOON" badge
 *     so the catalog can telegraph upcoming kinds without making them
 *     clickable.
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

/** How far one click of ◀ / ▶ pans the track, in CSS pixels. */
const STEP = 220;

export function PromptChipsRow<TValue extends string = string>({
    chips,
    value,
    onChange,
    ariaLabel = 'Pick a kind',
    testIdPrefix,
    className,
}: PromptChipsRowProps<TValue>) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);

    const [offset, setOffset] = useState(0);
    const [containerWidth, setContainerWidth] = useState(0);
    const [trackWidth, setTrackWidth] = useState(0);

    // ResizeObserver on both the container (its width changes when the
    // chat panel opens/closes) and the track (its width changes when
    // the chips array changes language / coming-soon set). Either one
    // changing means we need to re-clamp the offset.
    useEffect(() => {
        const container = containerRef.current;
        const track = trackRef.current;
        if (!container || !track) return;

        const measure = () => {
            setContainerWidth(container.clientWidth);
            setTrackWidth(track.scrollWidth);
        };
        measure();

        const ro = new ResizeObserver(measure);
        ro.observe(container);
        ro.observe(track);
        return () => ro.disconnect();
    }, [chips]);

    const maxOffset = Math.max(0, trackWidth - containerWidth);

    // Clamp `offset` whenever the track or container resizes. Without
    // this, shrinking the viewport when the row is already panned to
    // the right leaves a visible empty gap on the right edge.
    useEffect(() => {
        setOffset((prev) => Math.min(prev, maxOffset));
    }, [maxOffset]);

    const overflowing = trackWidth > containerWidth + 1;
    const atStart = offset <= 0;
    const atEnd = offset >= maxOffset - 1;

    const panBy = useCallback(
        (delta: number) => {
            setOffset((prev) => Math.max(0, Math.min(maxOffset, prev + delta)));
        },
        [maxOffset],
    );

    const trackStyle = useMemo(() => ({ transform: `translate3d(${-offset}px, 0, 0)` }), [offset]);

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
                        onClick={() => panBy(-STEP)}
                        aria-label="Show previous chips"
                        className="absolute left-0 top-1/2 z-20 grid -translate-y-1/2 place-items-center rounded-full border border-border/60 dark:border-white/10 bg-background/90 dark:bg-black/80 size-8 shadow-md hover:bg-foreground/5"
                        data-testid={testIdPrefix ? `${testIdPrefix}-scroll-left` : undefined}
                    >
                        <ChevronLeft className="size-4" aria-hidden="true" />
                    </button>
                </>
            ) : null}

            <div
                ref={containerRef}
                className={cn(
                    'overflow-hidden py-1',
                    // Asymmetric padding — only reserve room for an arrow
                    // button on the side that's currently showing one.
                    !overflowing && 'px-1',
                    overflowing && !atStart && 'pl-10',
                    overflowing && atStart && 'pl-1',
                    overflowing && !atEnd && 'pr-10',
                    overflowing && atEnd && 'pr-1',
                )}
            >
                <div
                    ref={trackRef}
                    role="listbox"
                    aria-label={ariaLabel}
                    data-testid={testIdPrefix ? `${testIdPrefix}-chips` : undefined}
                    style={trackStyle}
                    className="flex w-max gap-2 transition-transform duration-200 ease-out will-change-transform"
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
                                // is the right toggle state inside a listbox.
                                onClick={() => onChange(selected ? null : c.value)}
                                data-testid={
                                    testIdPrefix ? `${testIdPrefix}-${c.value}` : undefined
                                }
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
            </div>

            {overflowing && !atEnd ? (
                <>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute right-0 top-0 bottom-0 z-10 w-12 bg-gradient-to-l from-background to-transparent dark:from-black"
                    />
                    <button
                        type="button"
                        onClick={() => panBy(STEP)}
                        aria-label="Show next chips"
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
