import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from 'ai';
import { CANVAS_COMPONENT_KEYS } from '@/components/ai/canvas/types';
import type {
    CanvasToolOutput,
    ChartArtifact,
    TableArtifact,
    StatArtifact,
    DetailArtifact,
    ComponentArtifact,
} from '@/components/ai/canvas/types';

/**
 * Canvas rendering tools.
 *
 * Unlike data tools these don't call the API — they package data the model has
 * already gathered (e.g. via `get_work_usage_trend`) into a serializable
 * artifact. The client `CanvasBridge` opens the side panel and renders it.
 *
 * Use these to present reports, comparisons, lists, and entity details as rich
 * UI instead of long markdown tables in the chat stream.
 */

const chartOutput = (artifact: ChartArtifact): CanvasToolOutput => ({ __canvas: true, artifact });
const tableOutput = (artifact: TableArtifact): CanvasToolOutput => ({ __canvas: true, artifact });
const statOutput = (artifact: StatArtifact): CanvasToolOutput => ({ __canvas: true, artifact });
const detailOutput = (artifact: DetailArtifact): CanvasToolOutput => ({ __canvas: true, artifact });

export const renderChart = tool({
    description:
        'Render a chart in the canvas (line, bar, area, or pie). Use for reports and ' +
        'trends, e.g. items generated per day, spend over time. Pass the data rows you ' +
        'gathered from a read tool. After calling, give a one-line summary in chat.',
    inputSchema: z.object({
        title: z.string().describe('Chart title'),
        chartType: z.enum(['line', 'bar', 'area', 'pie']),
        xKey: z.string().describe('Key in each data row used for the X axis (or pie slice label)'),
        series: z
            .array(
                z.object({
                    key: z.string().describe('Key in each row holding the numeric value'),
                    label: z.string().optional(),
                    color: z.string().optional(),
                }),
            )
            .min(1),
        data: z
            .array(z.record(z.string(), z.unknown()))
            .describe('Rows, e.g. [{ "date": "2026-05-01", "items": 12 }]'),
        description: z.string().optional(),
    }),
    execute: async ({ title, chartType, xKey, series, data, description }) =>
        chartOutput({
            id: randomUUID(),
            kind: 'chart',
            title,
            chartType,
            xKey,
            series,
            data,
            description,
        }),
});

export const renderTable = tool({
    description:
        'Render a table in the canvas. Use for lists of works/items/agents/tasks/etc. ' +
        'that are easier to scan as a grid than as prose.',
    inputSchema: z.object({
        title: z.string(),
        columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1),
        rows: z.array(z.record(z.string(), z.unknown())),
        description: z.string().optional(),
    }),
    execute: async ({ title, columns, rows, description }) =>
        tableOutput({ id: randomUUID(), kind: 'table', title, columns, rows, description }),
});

export const renderStatCards = tool({
    description:
        'Render a row of stat / metric tiles in the canvas (e.g. totals, counts, spend). ' +
        'Use for at-a-glance summaries and dashboard-style answers.',
    inputSchema: z.object({
        title: z.string(),
        stats: z
            .array(
                z.object({
                    label: z.string(),
                    value: z.union([z.string(), z.number()]),
                    hint: z.string().optional(),
                }),
            )
            .min(1),
        description: z.string().optional(),
    }),
    execute: async ({ title, stats, description }) =>
        statOutput({ id: randomUUID(), kind: 'stat', title, stats, description }),
});

export const renderDetail = tool({
    description:
        'Render an entity detail panel in the canvas (label/value fields plus optional ' +
        'status badges). Use to show one work/agent/task/mission’s details cleanly.',
    inputSchema: z.object({
        title: z.string(),
        fields: z
            .array(
                z.object({
                    label: z.string(),
                    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
                }),
            )
            .min(1),
        description: z.string().optional(),
        badges: z
            .array(
                z.object({
                    label: z.string(),
                    tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
                }),
            )
            .optional(),
    }),
    execute: async ({ title, fields, description, badges }) =>
        detailOutput({ id: randomUUID(), kind: 'detail', title, fields, description, badges }),
});

const componentOutput = (artifact: ComponentArtifact): CanvasToolOutput => ({
    __canvas: true,
    artifact,
});

export const showComponent = tool({
    description:
        'Render a bespoke canvas component for data you already gathered. ' +
        'Components — "progress": props { bars: [{ label, percent, caption? }] } (labeled percent bars); ' +
        '"gauge": props { label, percent, caption? } (one big % dial, great for budget/cap usage); ' +
        '"timeline": props { items: [{ title, subtitle?, status? }] } (vertical event history); ' +
        '"comparison": props { left: { title, fields: [{ label, value }] }, right: {…} } (side-by-side compare). ' +
        'After calling, give a one-line summary in chat.',
    inputSchema: z.object({
        title: z.string(),
        component: z.enum(CANVAS_COMPONENT_KEYS),
        props: z.record(z.string(), z.unknown()),
        description: z.string().optional(),
    }),
    execute: async ({ title, component, props, description }) =>
        componentOutput({
            id: randomUUID(),
            kind: 'component',
            title,
            component,
            props,
            description,
        }),
});

export function buildCanvasTools() {
    return {
        renderChart,
        renderTable,
        renderStatCards,
        renderDetail,
        showComponent,
    };
}
