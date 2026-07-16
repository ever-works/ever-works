import * as React from 'react';
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';

/**
 * EW-742 — small brand-mark badges for the job-runtime provider picker.
 *
 * Each provider renders as a rounded square in its signature colour with a
 * simple white glyph, so the picker shows an icon to the LEFT of the
 * provider name (Trigger.dev, Temporal, …). These are lightweight, inlined,
 * theme-agnostic SVGs — a mid-tone brand colour with a white glyph reads
 * correctly in both light and dark mode without per-theme variants. They are
 * stylised marks (not the vendors' official trademarked logos) and can be
 * swapped for official SVGs later without touching call sites.
 *
 * Rendered via the generic `Select`'s `iconMap` prop (keyed by provider id),
 * mirroring the existing `data-dot` chip mechanism.
 */

interface GlyphProps {
    /** Rendered pixel size (width === height). */
    size?: number;
    className?: string;
    title?: string;
}

// Shared badge wrapper: a rounded square filled with `color`, `children` is
// the white glyph drawn on top (coordinates in a 20×20 viewBox).
function Badge({
    color,
    size = 18,
    className,
    title,
    children,
}: GlyphProps & { color: string; children: React.ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            role="img"
            aria-hidden={title ? undefined : true}
            aria-label={title}
        >
            {title ? <title>{title}</title> : null}
            <rect x="0" y="0" width="20" height="20" rx="5" fill={color} />
            {children}
        </svg>
    );
}

// Trigger.dev — signature charcoal/lime; glyph is a "play/trigger" triangle.
function TriggerIcon({ size, className, title }: GlyphProps) {
    return (
        <Badge color="#16171D" size={size} className={className} title={title ?? 'Trigger.dev'}>
            <path d="M8 6.2 L14 10 L8 13.8 Z" fill="#C6F24E" />
        </Badge>
    );
}

// Temporal — brand blue; glyph is a clock (temporal = time).
function TemporalIcon({ size, className, title }: GlyphProps) {
    return (
        <Badge color="#1F6BFF" size={size} className={className} title={title ?? 'Temporal'}>
            <circle cx="10" cy="10" r="4.4" stroke="#FFFFFF" strokeWidth="1.5" />
            <path
                d="M10 7.4 V10 L12 11.2"
                stroke="#FFFFFF"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </Badge>
    );
}

// BullMQ — red; "B" monogram.
function BullmqIcon({ size, className, title }: GlyphProps) {
    return (
        <Badge color="#E11D48" size={size} className={className} title={title ?? 'BullMQ'}>
            <text
                x="10"
                y="10"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="11"
                fontWeight="700"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                fill="#FFFFFF"
            >
                B
            </text>
        </Badge>
    );
}

// pg-boss — Postgres blue; "pg" wordmark.
function PgbossIcon({ size, className, title }: GlyphProps) {
    return (
        <Badge color="#31648C" size={size} className={className} title={title ?? 'pg-boss'}>
            <text
                x="10"
                y="10.5"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="9"
                fontWeight="700"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                fill="#FFFFFF"
            >
                pg
            </text>
        </Badge>
    );
}

// Inngest — violet; waveform bars (functions / events).
function InngestIcon({ size, className, title }: GlyphProps) {
    return (
        <Badge color="#6D28D9" size={size} className={className} title={title ?? 'Inngest'}>
            <g fill="#FFFFFF">
                <rect x="5.5" y="9" width="1.8" height="5" rx="0.9" />
                <rect x="9.1" y="6" width="1.8" height="8" rx="0.9" />
                <rect x="12.7" y="10.5" width="1.8" height="3.5" rx="0.9" />
            </g>
        </Badge>
    );
}

const ICON_BY_PROVIDER: Record<
    TenantJobRuntimeProviderId,
    (props: GlyphProps) => React.ReactElement
> = {
    trigger: TriggerIcon,
    temporal: TemporalIcon,
    bullmq: BullmqIcon,
    pgboss: PgbossIcon,
    inngest: InngestIcon,
};

export interface ProviderBrandIconProps extends GlyphProps {
    providerId: TenantJobRuntimeProviderId;
}

/** Brand-mark badge for a single job-runtime provider. */
export function ProviderBrandIcon({ providerId, ...props }: ProviderBrandIconProps) {
    const Icon = ICON_BY_PROVIDER[providerId];
    if (!Icon) return null;
    return <Icon {...props} />;
}

/**
 * Prebuilt `iconMap` for the `Select` component: provider id → brand badge.
 * Consumed by the provider picker in `JobRuntimeSettings`.
 */
export function providerIconMap(size = 18): Record<string, React.ReactNode> {
    return Object.fromEntries(
        (Object.keys(ICON_BY_PROVIDER) as TenantJobRuntimeProviderId[]).map((id) => [
            id,
            <ProviderBrandIcon key={id} providerId={id} size={size} />,
        ]),
    );
}
