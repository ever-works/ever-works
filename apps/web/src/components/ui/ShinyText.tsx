'use client';

/**
 * Letter-by-letter shiny wave animation.
 *
 * Each character transitions:  muted → bright → muted  in a staggered loop.
 * Uses a single CSS @keyframes rule (injected in globals.css) so the browser
 * handles everything on the compositor — zero JS timers after mount.
 */

interface ShinyTextProps {
    /** The text to animate */
    text: string;
    /** Base delay between each letter in seconds (default 0.06) */
    stagger?: number;
    /** Total animation cycle duration in seconds (default 1.8) */
    duration?: number;
    /** Extra className on the wrapper <span> */
    className?: string;
}

export function ShinyText({
    text,
    stagger = 0.06,
    duration = 1.8,
    className,
}: ShinyTextProps) {
    return (
        <span className={className} aria-label={text}>
            {text.split('').map((char, i) => (
                <span
                    key={`${char}-${i}`}
                    className="shiny-letter"
                    style={{
                        animationDelay: `${i * stagger}s`,
                        animationDuration: `${duration}s`,
                    }}
                    aria-hidden
                >
                    {char === ' ' ? '\u00A0' : char}
                </span>
            ))}
        </span>
    );
}
