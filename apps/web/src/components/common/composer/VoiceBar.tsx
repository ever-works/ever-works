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

function ElapsedClock({ startedAt }: { readonly startedAt: number }) {
    // Seeded from mount (which coincides with dictation starting) so there is
    // no setState-in-effect just to show 0:00 on the first frame.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(id);
    }, [startedAt]);
    return (
        <span className="text-[11px] tabular-nums text-text-muted dark:text-text-muted-dark">
            {formatElapsed(now - startedAt)}
        </span>
    );
}

/**
 * Stand-in for the canvas meter when the mic level is unavailable — denied
 * permission, no Web Audio, or `prefers-reduced-motion`.
 */
function StaticBars({ testId }: { readonly testId?: string }) {
    return (
        <span
            className="flex h-6 shrink-0 items-center gap-[3px]"
            aria-hidden="true"
            data-testid={testId ? `${testId}-voice-static` : undefined}
        >
            {[0, 1, 2, 3, 4].map((i) => (
                <span
                    key={i}
                    className="w-[2.5px] rounded-full bg-text-muted/60 motion-safe:animate-pulse dark:bg-text-muted-dark/70"
                    style={{ height: `${[8, 14, 20, 12, 7][i]}px`, animationDelay: `${i * 120}ms` }}
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
    readonly testId?: string;
}

export function VoiceBar({
    startedAt,
    canvasRef,
    waveformActive,
    onCancel,
    onDone,
    testId,
}: VoiceBarProps) {
    return (
        <div
            className={cn(
                'flex items-center gap-2.5 px-2 pb-2.5 pt-1.5',
                'border-t border-border/[0.15] bg-foreground/[0.02] dark:border-white/[0.06] dark:bg-white/[0.02]',
            )}
            data-testid={testId ? `${testId}-voice-bar` : undefined}
        >
            <span
                className="relative ml-1 flex size-4 shrink-0 items-center justify-center"
                aria-hidden="true"
            >
                <span className="absolute inline-flex size-3.5 animate-ping rounded-full bg-text-muted/30 motion-reduce:animate-none dark:bg-text-muted-dark/40" />
                <Mic className="relative size-3.5 text-text dark:text-text-dark" />
            </span>

            {waveformActive ? (
                <canvas
                    ref={canvasRef}
                    // The bar colour is read off this element via
                    // getComputedStyle — see paint() in use-mic-waveform.
                    className="h-6 w-24 shrink-0 text-text-secondary dark:text-text-secondary-dark sm:w-40"
                    aria-hidden="true"
                    data-testid={testId ? `${testId}-voice-waveform` : undefined}
                />
            ) : (
                <StaticBars testId={testId} />
            )}

            {/* The meter carries this visually; screen readers get it in words. */}
            <span className="sr-only" aria-live="polite">
                Listening…
            </span>

            <span className="ml-auto flex items-center gap-2">
                <ElapsedClock startedAt={startedAt} />

                <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Discard dictation"
                    title="Discard dictation"
                    className="rounded-lg p-2 text-text-muted transition-colors hover:bg-foreground/[0.06] hover:text-text dark:text-text-muted-dark dark:hover:bg-white/[0.06] dark:hover:text-text-dark"
                    data-testid={testId ? `${testId}-voice-cancel` : undefined}
                >
                    <X className="size-4" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    onClick={onDone}
                    aria-label="Stop dictation and keep text"
                    title="Stop dictation and keep text"
                    className={cn(
                        'inline-flex items-center justify-center rounded-full p-2.5',
                        'bg-button-primary text-button-primary-foreground shadow-sm',
                        'dark:bg-button-primary-dark dark:text-button-primary-foreground-dark',
                        'transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark',
                        'active:scale-95',
                    )}
                    data-testid={testId ? `${testId}-voice-done` : undefined}
                >
                    <Check className="size-4" aria-hidden="true" />
                </button>
            </span>
        </div>
    );
}
