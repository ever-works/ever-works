'use client';

import { useMemo } from 'react';
import { encodeQrCode, qrCodeToSvgPath, qrCodeViewBoxSize } from '@/lib/utils/qr-code';

interface FleetQrCodeProps {
    /** Text to encode. */
    value: string;
    /** Accessible name — the QR itself is not readable by assistive tech. */
    label: string;
    className?: string;
    'data-testid'?: string;
}

/**
 * A QR rendering of a short handoff string, drawn as one inline SVG path.
 *
 * Renders NOTHING when the payload cannot be encoded (too long for the
 * supported versions). That is the important behaviour: the enroll
 * dialog always shows the copyable token and command as well, so a
 * missing QR costs a convenience, while a wrongly drawn one would cost
 * an operator a confusing failed scan on a machine they walked to.
 *
 * `currentColor` on the fill and a white plate behind it keep the code
 * high-contrast in both themes — QR scanners want dark-on-light, so the
 * plate is intentionally light in dark mode too.
 */
export function FleetQrCode({ value, label, className, ...rest }: FleetQrCodeProps) {
    const path = useMemo(() => {
        const matrix = encodeQrCode(value);
        if (!matrix) return null;
        return { d: qrCodeToSvgPath(matrix), viewBox: qrCodeViewBoxSize(matrix) };
    }, [value]);

    if (!path) return null;

    return (
        <div
            className={`inline-flex items-center justify-center rounded-lg bg-white p-3 ${className ?? ''}`}
            data-testid={rest['data-testid']}
        >
            <svg
                viewBox={`0 0 ${path.viewBox} ${path.viewBox}`}
                width={168}
                height={168}
                role="img"
                aria-label={label}
                shapeRendering="crispEdges"
            >
                <path d={path.d} fill="#000000" />
            </svg>
        </div>
    );
}
