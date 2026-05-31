'use client';

import { cn } from '@/lib/utils/cn';
import type { CanvasComponentKey } from './types';

/**
 * Bespoke canvas components the agent can render via `show_component`.
 *
 * These take plain serializable props (data the agent already gathered) and
 * render a richer layout than the generic chart/table/stat/detail renderers.
 * This registry is the extension point for the larger canvas catalog: add a
 * component here + its key to `CANVAS_COMPONENT_KEYS` in `types.ts`.
 */

function num(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown): string {
    return value === undefined || value === null ? '' : String(value);
}

function asArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** props: { bars: [{ label, percent, caption? }] } */
function ProgressBars({ props }: { props: Record<string, unknown> }) {
    const bars = asArray(props.bars);
    if (!bars.length) return <Empty label="No values" />;
    return (
        <div className="space-y-3">
            {bars.map((bar, i) => {
                const percent = Math.max(0, Math.min(100, num(bar.percent)));
                const tone =
                    percent >= 90 ? 'bg-danger' : percent >= 70 ? 'bg-warning' : 'bg-primary';
                return (
                    <div key={i}>
                        <div className="mb-1 flex items-center justify-between text-[11px]">
                            <span className="text-text dark:text-text-dark">{str(bar.label)}</span>
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {percent}%
                            </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-secondary dark:bg-white/[0.06]">
                            <div
                                className={cn('h-full rounded-full', tone)}
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                        {bar.caption ? (
                            <p className="mt-0.5 text-[10px] text-text-muted dark:text-text-muted-dark">
                                {str(bar.caption)}
                            </p>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

/** props: { items: [{ title, subtitle?, status? }] } */
function Timeline({ props }: { props: Record<string, unknown> }) {
    const items = asArray(props.items);
    if (!items.length) return <Empty label="No events" />;
    return (
        <ol className="relative ml-2 border-l border-border pl-4 dark:border-border-dark">
            {items.map((item, i) => (
                <li key={i} className="mb-4 last:mb-0">
                    <span className="absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full bg-primary" />
                    <p className="text-xs font-medium text-text dark:text-text-dark">
                        {str(item.title)}
                    </p>
                    {item.subtitle ? (
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            {str(item.subtitle)}
                        </p>
                    ) : null}
                    {item.status ? (
                        <span className="mt-1 inline-block rounded-full bg-surface-secondary px-1.5 py-0.5 text-[9px] text-text-muted dark:bg-white/[0.06] dark:text-text-muted-dark">
                            {str(item.status)}
                        </span>
                    ) : null}
                </li>
            ))}
        </ol>
    );
}

function Empty({ label }: { label: string }) {
    return (
        <div className="flex h-24 items-center justify-center text-xs text-text-muted dark:text-text-muted-dark">
            {label}
        </div>
    );
}

const REGISTRY: Record<
    CanvasComponentKey,
    (p: { props: Record<string, unknown> }) => React.ReactNode
> = {
    progress: ProgressBars,
    timeline: Timeline,
};

export function renderCanvasComponent(
    component: CanvasComponentKey,
    props: Record<string, unknown>,
): React.ReactNode {
    const Component = REGISTRY[component];
    if (!Component) return <Empty label={`Unknown component "${component}"`} />;
    return <Component props={props} />;
}
