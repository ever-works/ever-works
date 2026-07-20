import { cn } from '@/lib/utils/cn';

/**
 * Goals & Metrics — PR-8. Dependency-free inline SVG sparkline of a
 * Goal's observation history (`GET /me/goals/:id/samples`). No chart
 * library: it draws a single polyline (plus a soft area fill, the
 * latest-point dot, and an optional dashed target line) into a fixed
 * viewBox that scales to the container width. `non-scaling-stroke`
 * keeps the line crisp at any width.
 *
 * `values` must be ordered oldest → newest (the samples endpoint
 * returns newest-first, so callers reverse before passing).
 */
interface SparklineProps {
    values: number[];
    target?: number | null;
    className?: string;
    strokeClassName?: string;
    fillClassName?: string;
    targetClassName?: string;
}

const VIEW_W = 260;
const VIEW_H = 64;
const PAD = 6;

export function Sparkline({
    values,
    target = null,
    className,
    strokeClassName = 'text-info',
    fillClassName = 'text-info',
    targetClassName = 'text-text-muted dark:text-text-muted-dark',
}: SparklineProps) {
    const clean = values.filter((v) => Number.isFinite(v));
    if (clean.length === 0) {
        return null;
    }

    const hasTarget = typeof target === 'number' && Number.isFinite(target);
    const domainMin = Math.min(...clean, hasTarget ? (target as number) : Infinity);
    const domainMax = Math.max(...clean, hasTarget ? (target as number) : -Infinity);
    const span = domainMax - domainMin || 1;

    const innerW = VIEW_W - PAD * 2;
    const innerH = VIEW_H - PAD * 2;

    const xFor = (i: number) =>
        clean.length === 1 ? VIEW_W / 2 : PAD + (i / (clean.length - 1)) * innerW;
    const yFor = (v: number) => PAD + innerH - ((v - domainMin) / span) * innerH;

    const points = clean.map((v, i) => `${xFor(i).toFixed(2)},${yFor(v).toFixed(2)}`);
    const linePath = `M ${points.join(' L ')}`;
    const areaPath = `${linePath} L ${xFor(clean.length - 1).toFixed(2)},${(VIEW_H - PAD).toFixed(
        2,
    )} L ${xFor(0).toFixed(2)},${(VIEW_H - PAD).toFixed(2)} Z`;

    const lastX = xFor(clean.length - 1);
    const lastY = yFor(clean[clean.length - 1]);
    const targetY = hasTarget ? yFor(target as number) : null;

    return (
        <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-hidden="true"
            className={cn('w-full h-16', className)}
        >
            <path d={areaPath} className={cn('opacity-10', fillClassName)} fill="currentColor" />
            {targetY !== null && (
                <line
                    x1={PAD}
                    y1={targetY}
                    x2={VIEW_W - PAD}
                    y2={targetY}
                    className={targetClassName}
                    stroke="currentColor"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                />
            )}
            <path
                d={linePath}
                className={strokeClassName}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
            <circle
                cx={lastX}
                cy={lastY}
                r={2.75}
                className={strokeClassName}
                fill="currentColor"
            />
        </svg>
    );
}
