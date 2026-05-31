/**
 * Canvas artifact model.
 *
 * The chat agent renders rich, non-conversational output (charts, tables,
 * stat tiles, entity detail panels) into a side "canvas" instead of cramming
 * it into the message stream. Canvas tools (`lib/ai/tools/canvas.tools.ts`)
 * return a `CanvasToolOutput`; the `CanvasBridge` picks it up and opens the
 * panel; `CanvasArtifactView` renders it.
 *
 * Artifacts are plain serializable data so they survive being persisted into
 * conversation message `parts` and replayed on reload.
 */

export type CanvasChartType = 'line' | 'bar' | 'area' | 'pie';

export interface CanvasSeries {
    /** Key in each data row holding the numeric value. */
    key: string;
    /** Human label for the legend. */
    label?: string;
    /** Optional explicit color (otherwise a palette color is assigned). */
    color?: string;
}

export interface ChartArtifact {
    id: string;
    kind: 'chart';
    title: string;
    chartType: CanvasChartType;
    /** Row data, e.g. `[{ date: '2026-05-01', spend: 12.5 }, ...]`. */
    data: Array<Record<string, unknown>>;
    /** Key in each row used for the X axis (or pie label). */
    xKey: string;
    /** One or more numeric series to plot. */
    series: CanvasSeries[];
    description?: string;
}

export interface TableArtifact {
    id: string;
    kind: 'table';
    title: string;
    columns: Array<{ key: string; label: string }>;
    rows: Array<Record<string, unknown>>;
    description?: string;
}

export interface StatArtifact {
    id: string;
    kind: 'stat';
    title: string;
    stats: Array<{ label: string; value: string | number; hint?: string }>;
    description?: string;
}

export interface DetailArtifact {
    id: string;
    kind: 'detail';
    title: string;
    fields: Array<{ label: string; value: string | number | boolean | null }>;
    description?: string;
    badges?: Array<{ label: string; tone?: 'default' | 'success' | 'warning' | 'danger' }>;
}

export interface KanbanArtifact {
    id: string;
    kind: 'kanban';
    title: string;
    columns: Array<{
        key: string;
        label: string;
        cards: Array<{ title: string; subtitle?: string }>;
    }>;
    description?: string;
}

/**
 * Keys of bespoke canvas components the agent can render via `show_component`.
 * Each maps to a React component in `canvas/components.tsx`. Extend both in
 * lockstep when adding to the canvas catalog.
 */
export const CANVAS_COMPONENT_KEYS = [
    'progress',
    'timeline',
    'gauge',
    'comparison',
    'markdown',
    'gallery',
    'funnel',
    'metric_delta',
    'donut',
    'sparkline',
    'bars',
    'kpi',
    'steps',
    'badges',
    'json',
    'code',
    'heatmap',
    'rating',
    'calendar',
] as const;
export type CanvasComponentKey = (typeof CANVAS_COMPONENT_KEYS)[number];

export interface ComponentArtifact {
    id: string;
    kind: 'component';
    title: string;
    /** Registry key — see CANVAS_COMPONENT_KEYS. */
    component: CanvasComponentKey;
    /** Serializable props for the component. */
    props: Record<string, unknown>;
    description?: string;
}

export type CanvasArtifact =
    | ChartArtifact
    | TableArtifact
    | StatArtifact
    | DetailArtifact
    | KanbanArtifact
    | ComponentArtifact;

export interface CanvasToolOutput {
    __canvas: true;
    artifact: CanvasArtifact;
}

export function isCanvasToolOutput(value: unknown): value is CanvasToolOutput {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { __canvas?: unknown }).__canvas === true &&
        !!(value as Partial<CanvasToolOutput>).artifact
    );
}
