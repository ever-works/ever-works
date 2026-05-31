'use client';

import { cn } from '@/lib/utils/cn';
import { ChatMarkdown } from '../ChatMarkdown';
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

/** props: { label, percent, caption? } — a single large percentage dial. */
function Gauge({ props }: { props: Record<string, unknown> }) {
    const percent = Math.max(0, Math.min(100, num(props.percent)));
    const tone = percent >= 90 ? 'text-danger' : percent >= 70 ? 'text-warning' : 'text-primary';
    const ring =
        percent >= 90 ? 'stroke-danger' : percent >= 70 ? 'stroke-warning' : 'stroke-primary';
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - percent / 100);
    return (
        <div className="flex flex-col items-center gap-2 py-4">
            <div className="relative h-32 w-32">
                <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                    <circle
                        cx="60"
                        cy="60"
                        r={radius}
                        className="fill-none stroke-surface-secondary dark:stroke-white/[0.08]"
                        strokeWidth="10"
                    />
                    <circle
                        cx="60"
                        cy="60"
                        r={radius}
                        className={cn('fill-none', ring)}
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                    />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className={cn('text-2xl font-semibold', tone)}>{percent}%</span>
                </div>
            </div>
            <p className="text-xs font-medium text-text dark:text-text-dark">{str(props.label)}</p>
            {props.caption ? (
                <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    {str(props.caption)}
                </p>
            ) : null}
        </div>
    );
}

/** props: { left: { title, fields: [{label,value}] }, right: {...} } — side-by-side compare. */
function Comparison({ props }: { props: Record<string, unknown> }) {
    const sides = [props.left, props.right]
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({
            title: str(s.title),
            fields: asArray(s.fields),
        }));
    if (sides.length < 2) return <Empty label="Need two sides to compare" />;
    return (
        <div className="grid grid-cols-2 gap-3">
            {sides.map((side, i) => (
                <div key={i} className="rounded-lg border border-border dark:border-border-dark">
                    <div className="border-b border-border px-3 py-2 text-xs font-medium text-text dark:border-border-dark dark:text-text-dark">
                        {side.title}
                    </div>
                    <dl className="divide-y divide-border/60 dark:divide-white/[0.06]">
                        {side.fields.map((f, j) => (
                            <div key={j} className="px-3 py-1.5">
                                <dt className="text-[10px] text-text-muted dark:text-text-muted-dark">
                                    {str(f.label)}
                                </dt>
                                <dd className="text-[11px] text-text dark:text-text-dark">
                                    {str(f.value)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            ))}
        </div>
    );
}

/** props: { content } — render markdown (KB doc, README, item body) in the canvas. */
function Markdown({ props }: { props: Record<string, unknown> }) {
    const content = str(props.content);
    if (!content.trim()) return <Empty label="No content" />;
    return (
        <div className="text-xs leading-relaxed text-text dark:text-text-dark">
            <ChatMarkdown content={content} />
        </div>
    );
}

/** props: { images: [string | { url, caption? }] } — image / screenshot grid. */
function Gallery({ props }: { props: Record<string, unknown> }) {
    const raw = Array.isArray(props.images) ? (props.images as unknown[]) : [];
    const images = raw
        .map((item) => {
            if (typeof item === 'string') return { url: item, caption: '' };
            if (item && typeof item === 'object') {
                const o = item as Record<string, unknown>;
                return { url: str(o.url ?? o.src), caption: str(o.caption ?? o.label) };
            }
            return { url: '', caption: '' };
        })
        .filter((i) => i.url);
    if (!images.length) return <Empty label="No images" />;
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {images.map((img, i) => (
                <figure
                    key={i}
                    className="overflow-hidden rounded-lg border border-border dark:border-border-dark"
                >
                    {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external URLs, not a known domain */}
                    <img
                        src={img.url}
                        alt={img.caption || `image ${i + 1}`}
                        loading="lazy"
                        className="h-28 w-full object-cover"
                    />
                    {img.caption ? (
                        <figcaption className="truncate px-2 py-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                            {img.caption}
                        </figcaption>
                    ) : null}
                </figure>
            ))}
        </div>
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
    gauge: Gauge,
    comparison: Comparison,
    markdown: Markdown,
    gallery: Gallery,
};

export function renderCanvasComponent(
    component: CanvasComponentKey,
    props: Record<string, unknown>,
): React.ReactNode {
    const Component = REGISTRY[component];
    if (!Component) return <Empty label={`Unknown component "${component}"`} />;
    return <Component props={props} />;
}
