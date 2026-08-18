import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * Human + Agent — the icon for the merged "Teams" hub (navigation
 * consolidation, `docs/specs/features/navigation-consolidation`): one entry
 * that covers people AND agents, so the glyph has to say both.
 *
 * Hand-drawn in lucide's 24×24 stroke grammar (currentColor, round caps and
 * joins, default stroke width 2) so it sits next to the other sidebar icons
 * without a visible seam: the left half is lucide `user` (head + shoulders),
 * the right half is lucide `bot`'s head (rounded rect, antenna, two eyes).
 *
 * Declared with `forwardRef` so it is structurally a lucide `LucideIcon` —
 * that is what `PageHeader`'s `icon` prop and the sidebar's navigation array
 * are typed as, and a plain function component is not assignable to it.
 */
export const HumanAgentIcon = forwardRef<SVGSVGElement, LucideProps>(function HumanAgentIcon(
    { size = 24, strokeWidth = 2, absoluteStrokeWidth = false, className, ...rest },
    ref,
) {
    // Same rule as lucide's own icons: with `absoluteStrokeWidth` the stroke
    // stays the same visual weight at any `size` instead of scaling with the
    // viewBox. Destructured either way so it never lands on the <svg> as an
    // unknown attribute.
    const numericSize = Number(size) || 24;
    const resolvedStrokeWidth = absoluteStrokeWidth
        ? (Number(strokeWidth) * 24) / numericSize
        : strokeWidth;
    return (
        <svg
            ref={ref}
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={resolvedStrokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
            {...rest}
        >
            {/* person (left) — lucide `user` */}
            <circle cx="7.5" cy="7" r="3" />
            <path d="M2 21v-2a4.5 4.5 0 0 1 4.5-4.5h2A4.5 4.5 0 0 1 13 19v2" />
            {/* bot head (right) — lucide `bot` */}
            <rect x="13" y="10" width="9" height="8" rx="2" />
            <path d="M17.5 10V7" />
            <circle cx="17.5" cy="6" r="1" />
            <path d="M15.5 14v1" />
            <path d="M19.5 14v1" />
        </svg>
    );
});
