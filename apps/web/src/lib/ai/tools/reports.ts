import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from 'ai';
import { callApi } from './generated/api-call';
import type { CanvasArtifact } from '@/components/ai/canvas/types';

/**
 * Built-in report engine.
 *
 * A report fetches data from the platform API (as the logged-in user),
 * aggregates it, and returns a canvas artifact (chart / stat tiles / kanban).
 * The `run_report` tool exposes them to chat — e.g. "show me spend over time
 * for this work" or "how are my tasks distributed". This is the turnkey path
 * for the analytics use cases; the model can still hand-roll a report with a
 * read tool + `renderChart` when no built-in fits.
 */

type ReportResult = { artifact: CanvasArtifact } | { error: string };

interface ReportDef {
    id: string;
    title: string;
    description: string;
    needsWorkId?: boolean;
    run: (args: { workId?: string }) => Promise<ReportResult>;
}

// ── helpers ──────────────────────────────────────────────────────

const LIST_KEYS = [
    'data',
    'items',
    'results',
    'rows',
    'entries',
    'tasks',
    'agents',
    'works',
    'missions',
    'notifications',
];

function toArray(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        for (const key of LIST_KEYS) {
            if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
        }
        for (const value of Object.values(obj)) {
            if (Array.isArray(value)) return value as Record<string, unknown>[];
        }
    }
    return [];
}

function labelize(value: unknown): string {
    if (value === undefined || value === null || value === '') return 'Unknown';
    return String(value)
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function money(cents: unknown): number {
    const n = typeof cents === 'number' ? cents : Number(cents);
    return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

function groupCountChart(
    title: string,
    rows: Record<string, unknown>[],
    field: string,
    chartType: 'bar' | 'pie',
): CanvasArtifact {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const key = labelize(row[field]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const data = [...counts.entries()].map(([label, count]) => ({ label, count }));
    return {
        id: randomUUID(),
        kind: 'chart',
        title,
        chartType,
        xKey: 'label',
        series: [{ key: 'count', label: 'Count' }],
        data,
        description: `${rows.length} item(s) grouped by ${field}.`,
    };
}

async function fetchArray(
    path: string,
    workId?: string,
): Promise<Record<string, unknown>[] | { error: string }> {
    const res = await callApi({
        method: 'GET',
        path,
        pathParams: workId ? { workId } : undefined,
    });
    if (!res.success) return { error: res.error ?? 'Request failed' };
    return toArray(res.data);
}

const STATUS_ORDER = ['draft', 'pending', 'in_progress', 'blocked', 'completed', 'archived'];

// ── report definitions ───────────────────────────────────────────

const REPORTS: ReportDef[] = [
    {
        id: 'tasks_by_status',
        title: 'Tasks by status',
        description: 'Bar chart of your tasks grouped by status.',
        run: async () => {
            const rows = await fetchArray('/api/tasks');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Tasks by status', rows, 'status', 'bar') };
        },
    },
    {
        id: 'tasks_by_priority',
        title: 'Tasks by priority',
        description: 'Pie chart of your tasks grouped by priority.',
        run: async () => {
            const rows = await fetchArray('/api/tasks');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Tasks by priority', rows, 'priority', 'pie') };
        },
    },
    {
        id: 'tasks_board',
        title: 'Tasks kanban board',
        description: 'Kanban board of your tasks grouped into status columns.',
        run: async () => {
            const rows = await fetchArray('/api/tasks');
            if ('error' in rows) return rows;
            const byStatus = new Map<string, Record<string, unknown>[]>();
            for (const row of rows) {
                const key = String(row.status ?? 'unknown');
                if (!byStatus.has(key)) byStatus.set(key, []);
                byStatus.get(key)!.push(row);
            }
            const keys = [
                ...STATUS_ORDER.filter((s) => byStatus.has(s)),
                ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s)),
            ];
            const columns = keys.map((key) => ({
                key,
                label: labelize(key),
                cards: (byStatus.get(key) ?? []).map((row) => ({
                    title: String(row.title ?? row.name ?? row.slug ?? 'Untitled'),
                    subtitle: row.priority ? `Priority: ${labelize(row.priority)}` : undefined,
                })),
            }));
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'kanban',
                    title: 'Tasks board',
                    columns,
                    description: `${rows.length} task(s).`,
                },
            };
        },
    },
    {
        id: 'agents_by_status',
        title: 'Agents by status',
        description: 'Bar chart of your agents grouped by status.',
        run: async () => {
            const rows = await fetchArray('/api/agents');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Agents by status', rows, 'status', 'bar') };
        },
    },
    {
        id: 'missions_by_status',
        title: 'Missions by status',
        description: 'Bar chart of your missions grouped by status.',
        run: async () => {
            const rows = await fetchArray('/api/me/missions');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Missions by status', rows, 'status', 'bar') };
        },
    },
    {
        id: 'work_spend_trend',
        title: 'Work spend over time',
        description: 'Daily spend trend for a work (area chart). Needs a workId.',
        needsWorkId: true,
        run: async ({ workId }) => {
            const res = await callApi({
                method: 'GET',
                path: '/api/works/{workId}/usage/trend',
                pathParams: { workId: workId! },
                query: { granularity: 'day' },
            });
            if (!res.success) return { error: res.error ?? 'Request failed' };
            const buckets = ((res.data as { buckets?: Array<{ day: string; costCents: number }> })
                ?.buckets ?? []) as Array<{ day: string; costCents: number }>;
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'chart',
                    title: 'Spend over time',
                    chartType: 'area',
                    xKey: 'day',
                    series: [{ key: 'spend', label: 'Spend ($)' }],
                    data: buckets.map((b) => ({ day: b.day, spend: money(b.costCents) })),
                },
            };
        },
    },
    {
        id: 'work_spend_by_plugin',
        title: 'Work spend by plugin',
        description: 'Bar chart of a work’s spend per plugin. Needs a workId.',
        needsWorkId: true,
        run: async ({ workId }) => {
            const res = await callApi({
                method: 'GET',
                path: '/api/works/{workId}/usage/summary',
                pathParams: { workId: workId! },
            });
            if (!res.success) return { error: res.error ?? 'Request failed' };
            const perPlugin = ((
                res.data as { perPlugin?: Array<{ pluginId: string; costCents: number }> }
            )?.perPlugin ?? []) as Array<{ pluginId: string; costCents: number }>;
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'chart',
                    title: 'Spend by plugin',
                    chartType: 'bar',
                    xKey: 'plugin',
                    series: [{ key: 'spend', label: 'Spend ($)' }],
                    data: perPlugin.map((p) => ({ plugin: p.pluginId, spend: money(p.costCents) })),
                },
            };
        },
    },
    {
        id: 'work_usage_overview',
        title: 'Work usage overview',
        description: 'Stat tiles summarising a work’s current-period spend. Needs a workId.',
        needsWorkId: true,
        run: async ({ workId }) => {
            const res = await callApi({
                method: 'GET',
                path: '/api/works/{workId}/usage/summary',
                pathParams: { workId: workId! },
            });
            if (!res.success) return { error: res.error ?? 'Request failed' };
            const s = res.data as {
                totalSpendCents?: number;
                periodLabel?: string;
                perPlugin?: unknown[];
                globalBudget?: { percentUsed?: number } | null;
            };
            const stats: Array<{ label: string; value: string | number; hint?: string }> = [
                { label: 'Total spend', value: `$${money(s.totalSpendCents).toFixed(2)}` },
                { label: 'Period', value: s.periodLabel ?? '—' },
                {
                    label: 'Plugins billed',
                    value: Array.isArray(s.perPlugin) ? s.perPlugin.length : 0,
                },
            ];
            if (s.globalBudget && typeof s.globalBudget.percentUsed === 'number') {
                stats.push({
                    label: 'Budget used',
                    value: `${Math.round(s.globalBudget.percentUsed)}%`,
                });
            }
            return {
                artifact: { id: randomUUID(), kind: 'stat', title: 'Usage overview', stats },
            };
        },
    },
    {
        id: 'account_spend_overview',
        title: 'Account spend overview',
        description: 'Stat tiles summarising your total spend and cap across all works.',
        run: async () => {
            const res = await callApi({ method: 'GET', path: '/api/me/usage/account-wide' });
            if (!res.success) return { error: res.error ?? 'Request failed' };
            const obj = (res.data ?? {}) as Record<string, unknown>;
            const stats: Array<{ label: string; value: string | number; hint?: string }> = [];
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'number') {
                    const isCents = /cents/i.test(key);
                    stats.push({
                        label: labelize(key.replace(/cents/i, '')),
                        value: isCents ? `$${money(value).toFixed(2)}` : value,
                    });
                } else if (typeof value === 'string' && value.length < 40) {
                    stats.push({ label: labelize(key), value });
                }
            }
            if (!stats.length) return { error: 'No account usage figures available.' };
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'stat',
                    title: 'Account spend',
                    stats: stats.slice(0, 6),
                },
            };
        },
    },
];

const REPORT_IDS = REPORTS.map((r) => r.id);

export const runReport = tool({
    description:
        'Run a built-in report: fetches data as the logged-in user, aggregates it, and renders a ' +
        'chart / stat tiles / kanban in the canvas. Pass `workId` for work-scoped reports. ' +
        'After calling, give a one-line summary. Available reports — ' +
        REPORTS.map((r) => `${r.id}: ${r.title}${r.needsWorkId ? ' (needs workId)' : ''}`).join(
            '; ',
        ) +
        '.',
    inputSchema: z.object({
        reportId: z
            .enum(REPORT_IDS as [string, ...string[]])
            .describe('Which built-in report to run'),
        workId: z.string().optional().describe('Required for work-scoped reports'),
    }),
    execute: async ({ reportId, workId }) => {
        const report = REPORTS.find((r) => r.id === reportId);
        if (!report) return { success: false, error: `Unknown report "${reportId}".` };
        if (report.needsWorkId && !workId) {
            return {
                success: false,
                error: `The "${report.title}" report needs a workId — ask the user which work to report on.`,
            };
        }
        const result = await report.run({ workId });
        if ('error' in result) return { success: false, error: result.error };
        return { __canvas: true, artifact: result.artifact };
    },
});

export const listReports = tool({
    description: 'List the built-in reports available to run via run_report.',
    inputSchema: z.object({}),
    execute: async () => ({
        reports: REPORTS.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            needsWorkId: !!r.needsWorkId,
        })),
    }),
});

export function buildReportTools() {
    return { runReport, listReports };
}
