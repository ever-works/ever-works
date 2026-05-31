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

/** props: { stages: [{ label, value }] } — funnel where each bar is sized vs the first stage. */
function Funnel({ props }: { props: Record<string, unknown> }) {
    const stages = asArray(props.stages).map((s) => ({ label: str(s.label), value: num(s.value) }));
    if (!stages.length) return <Empty label="No stages" />;
    const top = Math.max(stages[0].value, 1);
    return (
        <div className="space-y-2">
            {stages.map((stage, i) => {
                const pct = Math.max(2, Math.round((stage.value / top) * 100));
                const conv = i === 0 ? 100 : Math.round((stage.value / top) * 100);
                return (
                    <div key={i}>
                        <div className="mb-0.5 flex items-center justify-between text-[11px]">
                            <span className="text-text dark:text-text-dark">{stage.label}</span>
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {stage.value} · {conv}%
                            </span>
                        </div>
                        <div
                            className="mx-auto h-5 rounded bg-primary/80"
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                );
            })}
        </div>
    );
}

/** props: { metrics: [{ label, value, delta?, deltaLabel? }] } — stat tiles with up/down deltas. */
function MetricDelta({ props }: { props: Record<string, unknown> }) {
    const metrics = asArray(props.metrics);
    if (!metrics.length) return <Empty label="No metrics" />;
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {metrics.map((m, i) => {
                const delta = m.delta === undefined || m.delta === null ? null : num(m.delta);
                const tone =
                    delta === null
                        ? 'text-text-muted dark:text-text-muted-dark'
                        : delta > 0
                          ? 'text-success'
                          : delta < 0
                            ? 'text-danger'
                            : 'text-text-muted dark:text-text-muted-dark';
                const arrow = delta === null ? '' : delta > 0 ? '▲' : delta < 0 ? '▼' : '–';
                return (
                    <div
                        key={i}
                        className="rounded-lg border border-border bg-surface-secondary/40 px-4 py-3 dark:border-border-dark dark:bg-white/[0.03]"
                    >
                        <p className="text-xl font-semibold text-text dark:text-white">
                            {str(m.value)}
                        </p>
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            {str(m.label)}
                        </p>
                        {delta !== null ? (
                            <p className={cn('mt-0.5 text-[10px]', tone)}>
                                {arrow} {Math.abs(delta)}
                                {m.deltaLabel ? ` ${str(m.deltaLabel)}` : ''}
                            </p>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444'];

/** props: { segments: [{ label, value, color? }] } — SVG donut with center total. */
function Donut({ props }: { props: Record<string, unknown> }) {
    const segs = asArray(props.segments).map((s, i) => ({
        label: str(s.label),
        value: num(s.value),
        color: typeof s.color === 'string' ? s.color : PALETTE[i % PALETTE.length],
    }));
    const total = segs.reduce((a, s) => a + s.value, 0);
    if (!total) return <Empty label="No data" />;
    const r = 52;
    const c = 2 * Math.PI * r;
    // Precompute cumulative offsets purely (no render-time mutation).
    const arcs = segs.map((s, i) => {
        const preceding = segs.slice(0, i).reduce((a, x) => a + x.value, 0);
        const frac = s.value / total;
        return { color: s.color, dash: `${frac * c} ${c}`, off: -(preceding / total) * c };
    });
    return (
        <div className="flex items-center gap-4">
            <div className="relative h-36 w-36 shrink-0">
                <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                    {arcs.map((a, i) => (
                        <circle
                            key={i}
                            cx="60"
                            cy="60"
                            r={r}
                            fill="none"
                            stroke={a.color}
                            strokeWidth="14"
                            strokeDasharray={a.dash}
                            strokeDashoffset={a.off}
                        />
                    ))}
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-semibold text-text dark:text-white">{total}</span>
                </div>
            </div>
            <ul className="space-y-1 text-[11px]">
                {segs.map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                        <span className="text-text dark:text-text-dark">{s.label}</span>
                        <span className="text-text-muted dark:text-text-muted-dark">{s.value}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** props: { points: number[], label? } — inline SVG sparkline. */
function Sparkline({ props }: { props: Record<string, unknown> }) {
    const points = (Array.isArray(props.points) ? props.points : []).map((p) => num(p));
    if (points.length < 2) return <Empty label="Not enough points" />;
    const max = Math.max(...points);
    const min = Math.min(...points);
    const span = max - min || 1;
    const w = 240;
    const h = 48;
    const d = points
        .map((p, i) => {
            const x = (i / (points.length - 1)) * w;
            const y = h - ((p - min) / span) * h;
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    return (
        <div>
            {props.label ? (
                <p className="mb-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {str(props.label)}
                </p>
            ) : null}
            <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full">
                <path d={d} fill="none" stroke="#6366f1" strokeWidth="2" />
            </svg>
        </div>
    );
}

/** props: { items: [{ label, value }] } — horizontal value bars sized vs the max. */
function Bars({ props }: { props: Record<string, unknown> }) {
    const items = asArray(props.items).map((it) => ({
        label: str(it.label),
        value: num(it.value),
    }));
    if (!items.length) return <Empty label="No items" />;
    const max = Math.max(...items.map((i) => i.value), 1);
    return (
        <div className="space-y-1.5">
            {items.map((it, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="w-28 shrink-0 truncate text-text dark:text-text-dark">
                        {it.label}
                    </span>
                    <div className="h-3 flex-1 overflow-hidden rounded bg-surface-secondary dark:bg-white/[0.06]">
                        <div
                            className="h-full rounded bg-primary"
                            style={{ width: `${Math.max(2, (it.value / max) * 100)}%` }}
                        />
                    </div>
                    <span className="w-10 shrink-0 text-right text-text-muted dark:text-text-muted-dark">
                        {it.value}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** props: { label, value, caption? } — one big KPI number. */
function Kpi({ props }: { props: Record<string, unknown> }) {
    return (
        <div className="flex flex-col items-center justify-center py-6">
            <span className="text-4xl font-bold text-text dark:text-white">{str(props.value)}</span>
            <span className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                {str(props.label)}
            </span>
            {props.caption ? (
                <span className="mt-0.5 text-[10px] text-text-muted/70 dark:text-text-muted-dark/70">
                    {str(props.caption)}
                </span>
            ) : null}
        </div>
    );
}

/** props: { steps: [{ label, done? }] } — a vertical stepper / checklist. */
function Steps({ props }: { props: Record<string, unknown> }) {
    const steps = asArray(props.steps);
    if (!steps.length) return <Empty label="No steps" />;
    return (
        <ol className="space-y-2">
            {steps.map((s, i) => {
                const done = s.done === true;
                return (
                    <li key={i} className="flex items-center gap-2 text-xs">
                        <span
                            className={cn(
                                'flex h-4 w-4 items-center justify-center rounded-full text-[9px]',
                                done
                                    ? 'bg-success text-white'
                                    : 'bg-surface-secondary text-text-muted dark:bg-white/[0.08]',
                            )}
                        >
                            {done ? '✓' : i + 1}
                        </span>
                        <span
                            className={cn(
                                done
                                    ? 'text-text-muted line-through dark:text-text-muted-dark'
                                    : 'text-text dark:text-text-dark',
                            )}
                        >
                            {str(s.label)}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

/** props: { badges: [{ label, tone? }] } — a wrap of status badges. */
function Badges({ props }: { props: Record<string, unknown> }) {
    const badges = asArray(props.badges);
    if (!badges.length) return <Empty label="No badges" />;
    return (
        <div className="flex flex-wrap gap-1.5">
            {badges.map((b, i) => {
                const tone = str(b.tone);
                return (
                    <span
                        key={i}
                        className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-medium',
                            tone === 'success' && 'bg-success/10 text-success',
                            tone === 'warning' && 'bg-warning/10 text-warning',
                            tone === 'danger' && 'bg-danger/10 text-danger',
                            (!tone || tone === 'default') &&
                                'bg-surface-secondary text-text-muted dark:bg-white/[0.06] dark:text-text-muted-dark',
                        )}
                    >
                        {str(b.label)}
                    </span>
                );
            })}
        </div>
    );
}

/** props: { data } — pretty-printed JSON for raw inspection. */
function JsonView({ props }: { props: Record<string, unknown> }) {
    let text: string;
    try {
        text = JSON.stringify(props.data ?? props, null, 2);
    } catch {
        text = String(props.data);
    }
    return (
        <pre className="max-h-96 overflow-auto rounded-lg bg-surface-secondary p-3 text-[11px] text-text dark:bg-white/[0.04] dark:text-text-dark">
            {text}
        </pre>
    );
}

/** props: { code, language? } — a code block. */
function CodeBlock({ props }: { props: Record<string, unknown> }) {
    return (
        <div>
            {props.language ? (
                <p className="mb-1 text-[10px] uppercase text-text-muted dark:text-text-muted-dark">
                    {str(props.language)}
                </p>
            ) : null}
            <pre className="max-h-96 overflow-auto rounded-lg bg-surface-secondary p-3 text-[11px] text-text dark:bg-white/[0.04] dark:text-text-dark">
                {str(props.code)}
            </pre>
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
    funnel: Funnel,
    metric_delta: MetricDelta,
    donut: Donut,
    sparkline: Sparkline,
    bars: Bars,
    kpi: Kpi,
    steps: Steps,
    badges: Badges,
    json: JsonView,
    code: CodeBlock,
};

export function renderCanvasComponent(
    component: CanvasComponentKey,
    props: Record<string, unknown>,
): React.ReactNode {
    const Component = REGISTRY[component];
    if (!Component) return <Empty label={`Unknown component "${component}"`} />;
    return <Component props={props} />;
}
