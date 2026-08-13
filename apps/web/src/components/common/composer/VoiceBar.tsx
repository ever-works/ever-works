'use client';

import { useEffect, useState } from 'react';
import { Check, Mic, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * The composer's toolbar while dictation is running. Replaces the normal row
 * (attach / mic / counter / send) rather than sitting next to it, so recording
 * is a distinct mode instead of one more toggled button.
 *
 * Owns its own ticker so the elapsed clock doesn't re-render the composer (and
 * the textarea) twice a second.
 */

function formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function ElapsedClock({
    startedAt,
    compact,
}: {
    readonly startedAt: number;
    readonly compact?: boolean;
}) {
    // Seeded from mount (which coincides with dictation starting) so there is
    // no setState-in-effect just to show 0:00 on the first frame.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(id);
    }, [startedAt]);
    return (
        <span
            className={cn(
                'tabular-nums text-text-muted dark:text-text-muted-dark',
                compact ? 'text-[10px]' : 'text-[11px]',
            )}
        >
            {formatElapsed(now - startedAt)}
        </span>
    );
}

/**
 * Stand-in for the canvas meter when the mic level is unavailable — denied
 * permission, no Web Audio, or `prefers-reduced-motion`.
 */
function StaticBars({ compact, testId }: { readonly compact?: boolean; readonly testId?: string }) {
    const heights = compact ? [5, 9, 12, 8, 4] : [8, 14, 20, 12, 7];
    return (
        <span
            className={cn(
                'flex shrink-0 items-center',
                compact ? 'h-3.5 gap-[2px]' : 'h-6 gap-[3px]',
            )}
            aria-hidden="true"
            data-testid={testId ? `${testId}-voice-static` : undefined}
        >
            {heights.map((height, i) => (
                <span
                    key={i}
                    className={cn(
                        'rounded-full bg-text-muted/60 motion-safe:animate-pulse dark:bg-text-muted-dark/70',
                        compact ? 'w-[2px]' : 'w-[2.5px]',
                    )}
                    style={{ height: `${height}px`, animationDelay: `${i * 120}ms` }}
                />
            ))}
        </span>
    );
}

export interface VoiceBarProps {
    readonly startedAt: number;
    readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
    /** True when the mic meter is live; false falls back to static bars. */
    readonly waveformActive: boolean;
    /** Stop dictating and drop whatever this session appended. */
    readonly onCancel: () => void;
    /** Stop dictating and keep the transcript. */
    readonly onDone: () => void;
    readonly compact?: boolean;
    readonly testId?: string;
}

export function VoiceBar({
    startedAt,
    canvasRef,
    waveformActive,
    onCancel,
    onDone,
    compact,
    testId,
}: VoiceBarProps) {
    return (
        <div
            className={cn(
                'flex items-center',
                compact ? 'gap-1.5 px-1.5 pb-2 pt-1' : 'gap-2.5 px-2 pb-2.5 pt-1.5',
                'border-t border-border/[0.15] bg-foreground/[0.02] dark:border-white/[0.06] dark:bg-white/[0.02]',
            )}
            data-testid={testId ? `${testId}-voice-bar` : undefined}
        >
            <span
                className={cn(
                    'relative flex shrink-0 items-center justify-center',
                    compact ? 'ml-0.5 size-3.5' : 'ml-1 size-4',
                )}
                aria-hidden="true"
            >
                <span
                    className={cn(
                        'absolute inline-flex animate-ping rounded-full bg-text-muted/30 motion-reduce:animate-none dark:bg-text-muted-dark/40',
                        compact ? 'size-3' : 'size-3.5',
                    )}
                />
                <Mic
                    className={cn(
                        'relative text-text dark:text-text-dark',
                        compact ? 'size-3' : 'size-3.5',
                    )}
                />
            </span>

            {waveformActive ? (
                <canvas
                    ref={canvasRef}
                    // The bar colour is read off this element via
                    // getComputedStyle — see paint() in use-mic-waveform.
                    className={cn(
                        'shrink-0 text-text-secondary dark:text-text-secondary-dark',
                        compact ? 'h-3.5 w-14 sm:w-20' : 'h-6 w-24 sm:w-40',
                    )}
                    aria-hidden="true"
                    data-testid={testId ? `${testId}-voice-waveform` : undefined}
                />
            ) : (
                <StaticBars compact={compact} testId={testId} />
            )}

            {/* The meter carries this visually; screen readers get it in words. */}
            <span className="sr-only" aria-live="polite">
                Listening…
            </span>

            <span className={cn('ml-auto flex items-center', compact ? 'gap-1' : 'gap-2')}>
                <ElapsedClock startedAt={startedAt} compact={compact} />

                <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Discard dictation"
                    title="Discard dictation"
                    className={cn(
                        'rounded-lg text-text-muted transition-colors hover:bg-foreground/[0.06] hover:text-text dark:text-text-muted-dark dark:hover:bg-white/[0.06] dark:hover:text-text-dark',
                        compact ? 'p-1.5' : 'p-2',
                    )}
                    data-testid={testId ? `${testId}-voice-cancel` : undefined}
                >
                    <X className={compact ? 'size-3.5' : 'size-4'} aria-hidden="true" />
                </button>
                <button
                    type="button"
                    onClick={onDone}
                    aria-label="Stop dictation and keep text"
                    title="Stop dictation and keep text"
                    className={cn(
                        'inline-flex items-center justify-center rounded-full',
                        compact ? 'p-1.5' : 'p-2.5',
                        'bg-button-primary text-button-primary-foreground shadow-sm',
                        'dark:bg-button-primary-dark dark:text-button-primary-foreground-dark',
                        'transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark',
                        'active:scale-95',
                    )}
                    data-testid={testId ? `${testId}-voice-done` : undefined}
                >
                    <Check className={compact ? 'size-3.5' : 'size-4'} aria-hidden="true" />
                </button>
            </span>
        </div>
    );
}
