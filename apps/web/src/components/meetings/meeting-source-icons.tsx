import * as React from 'react';
import { CircleDot, Download, PencilLine } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Meetings — the mark for each producing surface, so a meeting's origin
 * is recognizable before its label is read. Used by the source badge
 * (list cards + detail page) and by the source pickers (`/meetings/new`,
 * the `/meetings` filter).
 *
 * The vendor marks are STYLISED shapes in each vendor's signature colour,
 * NOT the vendors' official trademarked logos, drawn as inlined
 * theme-agnostic SVGs so a mid-tone badge with a white glyph reads
 * correctly in light and dark mode without per-theme variants. They can
 * be swapped for official SVGs later without touching a call site.
 *
 * `manual` and `import` are not vendors, so they get neutral lucide
 * glyphs rather than an invented brand badge — inside the pill they ride
 * `currentColor` and pick up the badge's own hue.
 */

interface GlyphProps {
    /** Rendered pixel size (width === height). */
    size?: number;
}

// Shared badge wrapper: a rounded square filled with `color`, `children`
// is the white glyph drawn on top (coordinates in a 20×20 viewBox).
function Badge({
    color,
    size = 12,
    children,
}: GlyphProps & { color: string; children: React.ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            className="shrink-0"
        >
            <rect x="0" y="0" width="20" height="20" rx="5" fill={color} />
            {children}
        </svg>
    );
}

// Zoom — brand blue; the video camera, body plus lens wedge.
function ZoomIcon({ size }: GlyphProps) {
    return (
        <Badge color="#0B5CFF" size={size}>
            <g fill="#FFFFFF">
                <rect x="4.2" y="6.6" width="8" height="6.8" rx="1.8" />
                <path d="M12.9 8.9 15.8 7v6l-2.9-1.9V8.9Z" />
            </g>
        </Badge>
    );
}

// Google Meet — brand green; the same camera silhouette, but with the
// clipped top-right corner the Meet mark is built from, so the two video
// surfaces stay apart at badge size on colour AND shape.
function GoogleMeetIcon({ size }: GlyphProps) {
    return (
        <Badge color="#00832D" size={size}>
            <g fill="#FFFFFF">
                <path d="M4.2 8.2a1.6 1.6 0 0 1 1.6-1.6h4.6l1.8 1.9v3.3l-1.8 1.6H5.8a1.6 1.6 0 0 1-1.6-1.6V8.2Z" />
                <path d="M13 8.9 15.8 7v6L13 11.1V8.9Z" />
            </g>
        </Badge>
    );
}

/** Neutral (non-vendor) marks — inherit `currentColor` unless tinted. */
const NEUTRAL_ICONS = {
    manual: PencilLine,
    import: Download,
} as const;

/** An unrecognized source still gets a mark, just a neutral one. */
const UNKNOWN_ICON = CircleDot;

const BRAND_ICONS: Record<string, (props: GlyphProps) => React.ReactElement> = {
    zoom: ZoomIcon,
    'google-meet': GoogleMeetIcon,
};

/**
 * The producing-surface mark on its own — always `aria-hidden`, since
 * every call site renders the translated source name alongside it.
 *
 * `className` tints the neutral glyphs only; the vendor badges carry
 * their own colour by definition.
 */
export function MeetingSourceIcon({
    source,
    size = 12,
    className,
}: {
    source: string;
    size?: number;
    className?: string;
}) {
    const Brand = BRAND_ICONS[source];
    if (Brand) {
        return (
            <span data-testid="meeting-source-icon" className="flex shrink-0 items-center">
                <Brand size={size} />
            </span>
        );
    }

    const Glyph = NEUTRAL_ICONS[source as keyof typeof NEUTRAL_ICONS] ?? UNKNOWN_ICON;
    return (
        <Glyph
            aria-hidden="true"
            size={size}
            strokeWidth={1.9}
            className={cn('shrink-0', className)}
            data-testid="meeting-source-icon"
        />
    );
}
