import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from 'ai';
import { callApi } from './generated/api-call';
import {
    toArray,
    labelize,
    money,
    groupCountChart,
    boardArtifact,
    countStat,
} from './reports-aggregate';
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
// Pure aggregation helpers live in ./reports-aggregate (unit-tested).
// fetchArray is the one helper that does I/O, so it stays here.

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
            return { artifact: boardArtifact('Tasks board', rows, 'status') };
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

    // ── Wave 6: more catalogue reports ───────────────────────────
    {
        id: 'works_by_status',
        title: 'Works by status',
        description: 'Bar chart of your works grouped by status.',
        run: async () => {
            const rows = await fetchArray('/api/works');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Works by status', rows, 'status', 'bar') };
        },
    },
    {
        id: 'ideas_by_status',
        title: 'Ideas by status',
        description: 'Bar chart of your ideas (work proposals) grouped by status.',
        run: async () => {
            const rows = await fetchArray('/api/me/work-proposals');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Ideas by status', rows, 'status', 'bar') };
        },
    },
    {
        id: 'agents_board',
        title: 'Agents kanban board',
        description: 'Kanban board of your agents grouped into status columns.',
        run: async () => {
            const rows = await fetchArray('/api/agents');
            if ('error' in rows) return rows;
            return { artifact: boardArtifact('Agents board', rows, 'status') };
        },
    },
    {
        id: 'missions_board',
        title: 'Missions kanban board',
        description: 'Kanban board of your missions grouped into status columns.',
        run: async () => {
            const rows = await fetchArray('/api/me/missions');
            if ('error' in rows) return rows;
            return { artifact: boardArtifact('Missions board', rows, 'status') };
        },
    },
    {
        id: 'notifications_by_type',
        title: 'Notifications by type',
        description: 'Bar chart of your notifications grouped by type.',
        run: async () => {
            const rows = await fetchArray('/api/notifications');
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Notifications by type', rows, 'type', 'bar') };
        },
    },
    {
        id: 'webhook_deliveries_by_status',
        title: 'Webhook deliveries by status',
        description: 'Bar chart of recent webhook deliveries grouped by status.',
        run: async () => {
            const rows = await fetchArray('/api/webhooks/deliveries');
            if ('error' in rows) return rows;
            return {
                artifact: groupCountChart('Webhook deliveries by status', rows, 'status', 'bar'),
            };
        },
    },
    {
        id: 'skills_count',
        title: 'Skills total',
        description: 'How many skills you have.',
        run: async () => {
            const rows = await fetchArray('/api/skills');
            if ('error' in rows) return rows;
            return { artifact: countStat('Skills', rows, 'Skills') };
        },
    },
    {
        id: 'api_keys_count',
        title: 'API keys total',
        description: 'How many API keys you have.',
        run: async () => {
            const rows = await fetchArray('/api/auth/api-keys');
            if ('error' in rows) return rows;
            return { artifact: countStat('API keys', rows, 'API keys') };
        },
    },
    {
        id: 'work_members_by_role',
        title: 'Work members by role',
        description: 'Bar chart of a work’s members grouped by role. Needs a workId.',
        needsWorkId: true,
        run: async ({ workId }) => {
            const rows = await fetchArray('/api/works/{workId}/members', workId);
            if ('error' in rows) return rows;
            return { artifact: groupCountChart('Members by role', rows, 'role', 'bar') };
        },
    },
    {
        id: 'work_items_per_day',
        title: 'Items generated per day',
        description:
            'Line chart of new items generated per day for a work, from its generation history. Needs a workId.',
        needsWorkId: true,
        run: async ({ workId }) => {
            const res = await callApi({
                method: 'GET',
                path: '/api/works/{id}/history',
                pathParams: { id: workId! },
            });
            if (!res.success) return { error: res.error ?? 'Request failed' };
            const history = toArray(res.data) as Array<{
                createdAt?: string;
                newItemsCount?: number;
            }>;
            const perDay = new Map<string, number>();
            for (const entry of history) {
                const day = String(entry.createdAt ?? '').slice(0, 10);
                if (!day) continue;
                perDay.set(day, (perDay.get(day) ?? 0) + (Number(entry.newItemsCount) || 0));
            }
            const data = [...perDay.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([day, items]) => ({ day, items }));
            if (!data.length) return { error: 'No generation history yet for this work.' };
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'chart',
                    title: 'Items generated per day',
                    chartType: 'line',
                    xKey: 'day',
                    series: [{ key: 'items', label: 'New items' }],
                    data,
                    description: `${history.length} generation run(s).`,
                },
            };
        },
    },
    {
        id: 'activity_per_day',
        title: 'Activity per day',
        description: 'Line chart of how many activity-log events occurred per day (recent).',
        run: async () => {
            const rows = await fetchArray('/api/activity-log');
            if ('error' in rows) return rows;
            const perDay = new Map<string, number>();
            for (const row of rows) {
                const day = String(row.createdAt ?? row.created_at ?? row.timestamp ?? '').slice(
                    0,
                    10,
                );
                if (!day) continue;
                perDay.set(day, (perDay.get(day) ?? 0) + 1);
            }
            const data = [...perDay.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([day, count]) => ({ day, count }));
            if (!data.length) return { error: 'No activity to chart.' };
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'chart',
                    title: 'Activity per day',
                    chartType: 'line',
                    xKey: 'day',
                    series: [{ key: 'count', label: 'Events' }],
                    data,
                },
            };
        },
    },
    {
        id: 'work_overview',
        title: 'Work item overview',
        description: 'Stat tiles summarising a work’s item counts by status. Needs a workId.',
        needsWorkId: true,
        run: async ({ workId }) => {
            const res = await callApi({
                method: 'GET',
                path: '/api/works/{id}/count',
                pathParams: { id: workId! },
            });
            if (!res.success) return { error: res.error ?? 'Request failed' };
            const obj = (res.data ?? {}) as Record<string, unknown>;
            const stats: Array<{ label: string; value: string | number }> = [];
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'number') stats.push({ label: labelize(key), value });
            }
            if (!stats.length) return { error: 'No item counts available for this work.' };
            return {
                artifact: {
                    id: randomUUID(),
                    kind: 'stat',
                    title: 'Work items',
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

/**
 * Generic, parameterised report builder. Covers the long tail of "group X by
 * field Y as a chart" reports without a hardcoded entry for each — the model
 * picks a known-safe list source + a field. Path params are resolved from the
 * source's declared scope (id vs workId).
 */
const REPORT_SOURCES: Record<
    string,
    { path: string; scopeParam?: 'id' | 'workId'; label: string }
> = {
    tasks: { path: '/api/tasks', label: 'tasks' },
    agents: { path: '/api/agents', label: 'agents' },
    missions: { path: '/api/me/missions', label: 'missions' },
    ideas: { path: '/api/me/work-proposals', label: 'ideas' },
    works: { path: '/api/works', label: 'works' },
    skills: { path: '/api/skills', label: 'skills' },
    notifications: { path: '/api/notifications', label: 'notifications' },
    webhook_deliveries: { path: '/api/webhooks/deliveries', label: 'webhook deliveries' },
    work_members: {
        path: '/api/works/{workId}/members',
        scopeParam: 'workId',
        label: 'work members',
    },
    work_items: { path: '/api/works/{id}/items', scopeParam: 'id', label: 'work items' },
    kb_documents: {
        path: '/api/works/{id}/kb/documents',
        scopeParam: 'id',
        label: 'knowledge-base documents',
    },
    plugins: { path: '/api/plugins', label: 'plugins' },
    organizations: { path: '/api/organizations', label: 'organizations' },
    notification_channels: { path: '/api/notification-channels', label: 'notification channels' },
    webhooks: { path: '/api/webhooks', label: 'webhooks' },
    api_keys: { path: '/api/auth/api-keys', label: 'API keys' },
    templates: { path: '/api/templates', label: 'templates' },
    comparisons: { path: '/api/works/{id}/comparisons', scopeParam: 'id', label: 'comparisons' },
    deployments: {
        path: '/api/deploy/works/{id}/deployments',
        scopeParam: 'id',
        label: 'deployments',
    },
};
const SOURCE_KEYS = Object.keys(REPORT_SOURCES);

export const buildReport = tool({
    description:
        'Build an ad-hoc report by grouping a list of your entities by a field and rendering a ' +
        'bar/pie chart in the canvas. Use when no built-in run_report fits. ' +
        `Sources: ${SOURCE_KEYS.join(', ')}. Work-scoped sources (work_members, work_items, ` +
        'kb_documents) need workId. groupBy is the field to count by (e.g. status, priority, role, ' +
        'category, type). After calling, give a one-line summary.',
    inputSchema: z.object({
        source: z
            .enum(SOURCE_KEYS as [string, ...string[]])
            .describe('Which list of entities to group'),
        groupBy: z.string().describe('Field name to group/count by (e.g. status, priority, role)'),
        chartType: z.enum(['bar', 'pie']).optional(),
        workId: z.string().optional().describe('Required for work-scoped sources'),
    }),
    execute: async ({ source, groupBy, chartType, workId }) => {
        const src = REPORT_SOURCES[source];
        if (!src) return { success: false, error: `Unknown source "${source}".` };
        if (src.scopeParam && !workId) {
            return {
                success: false,
                error: `Source "${source}" needs a workId — ask the user which work.`,
            };
        }
        const res = await callApi({
            method: 'GET',
            path: src.path,
            pathParams: src.scopeParam ? { [src.scopeParam]: workId! } : undefined,
        });
        if (!res.success) return { success: false, error: res.error ?? 'Request failed' };
        const rows = toArray(res.data);
        if (!rows.length) return { success: false, error: `No ${src.label} found.` };
        const artifact = groupCountChart(
            `${labelize(src.label)} by ${labelize(groupBy)}`,
            rows,
            groupBy,
            chartType ?? 'bar',
        );
        return { __canvas: true, artifact };
    },
});

export function buildReportTools() {
    return { runReport, listReports, buildReport };
}
