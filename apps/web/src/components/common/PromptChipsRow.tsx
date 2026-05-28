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

/**
 * Total horizontal padding in the container when the row is panned to
 * either boundary (atStart: `pl-1 pr-10` = 4 + 40 = 44; atEnd:
 * `pl-10 pr-1` = 40 + 4 = 44). Used to compute `maxOffset` so the
 * last chip's right edge can fully reach the visible area when the
 * user clicks ▶ all the way — without this, `maxOffset` underestimates
 * by `PADDING_AT_BOUNDARY` and `atEnd` triggers ~40px early (Codex P2
 * on PR #1069).
 */
const PADDING_AT_BOUNDARY = 44;

/** Padding values that match the Tailwind classes below. Pixel-perfect
 *  mirrors of `pl-1 = 4`, `pl-10 = 40`, etc. */
const PADDING_LARGE = 40; // pl-10 / pr-10
const PADDING_SMALL = 4; // pl-1 / pr-1

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

    // `clientWidth` includes the container's padding. When the user has
    // panned away from the start, that padding is `pl-10 pr-10` (80px
    // total); at the boundaries it's `pl-1 pr-10` or `pl-10 pr-1`
    // (44px total). The chip area visible to the user is therefore
    // `clientWidth - totalPadding`. The largest valid `offset` keeps
    // the last chip's right edge aligned with the inner right padding
    // when atEnd, which is `trackWidth - (containerWidth - 44)`.
    // (Codex P2 on PR #1069 — the previous `trackWidth - containerWidth`
    // formula clipped the last ~44px of chips before atEnd flipped.)
    const maxOffset = Math.max(0, trackWidth - containerWidth + PADDING_AT_BOUNDARY);

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

    /**
     * Keyboard accessibility — pan the track so a newly-focused chip is
     * fully visible. With the transform-based pan replacing the native
     * scroller (PR #1069), the browser no longer scrolls hidden chip
     * buttons into view when Tab focus advances. Codex P2 on PR #1069:
     * without this, a keyboard user can tab to off-screen options with
     * no visible focus indicator.
     *
     * Uses `getBoundingClientRect` for absolute position comparison —
     * dodges the question of which element is the focused chip's
     * `offsetParent` (it depends on `position` on ancestors).
     */
    const ensureChipVisible = useCallback(
        (buttonEl: HTMLElement) => {
            const container = containerRef.current;
            if (!container) return;

            const containerRect = container.getBoundingClientRect();
            const buttonRect = buttonEl.getBoundingClientRect();

            // Visible chip window: container interior minus arrow
            // gutters. The gutter is `PADDING_LARGE` on the side that
            // has a button and `PADDING_SMALL` on the side that doesn't.
            const leftGutter = atStart ? PADDING_SMALL : PADDING_LARGE;
            const rightGutter = atEnd ? PADDING_SMALL : PADDING_LARGE;
            const visibleStart = containerRect.left + leftGutter;
            const visibleEnd = containerRect.right - rightGutter;

            if (buttonRect.left < visibleStart) {
                const delta = buttonRect.left - visibleStart; // negative
                setOffset((prev) => Math.max(0, prev + delta));
            } else if (buttonRect.right > visibleEnd) {
                const delta = buttonRect.right - visibleEnd; // positive
                setOffset((prev) => Math.min(maxOffset, prev + delta));
            }
        },
        [atStart, atEnd, maxOffset],
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
                                // Keyboard accessibility: when Tab moves focus
                                // to a chip that's currently panned off-screen,
                                // pan the track so the focused chip is in
                                // view. Native scrolling used to handle this
                                // automatically; the transform-based pan does
                                // not, so we wire it explicitly.
                                onFocus={(e) => ensureChipVisible(e.currentTarget)}
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
