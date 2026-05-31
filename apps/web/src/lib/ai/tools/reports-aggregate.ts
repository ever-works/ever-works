import { randomUUID } from 'node:crypto';
import type { CanvasArtifact } from '@/components/ai/canvas/types';

/**
 * Pure aggregation helpers for the report engine (no I/O, no `server-only`) so
 * they can be unit-tested directly. `reports.ts` composes these with `callApi`.
 * This is where data-shape bugs hide — keep it tested.
 */

export const LIST_KEYS = [
    'data',
    'items',
    'results',
    'rows',
    'entries',
    'history',
    'tasks',
    'agents',
    'works',
    'missions',
    'notifications',
];

/** Normalise an API response into an array of rows, tolerating common envelopes. */
export function toArray(data: unknown): Record<string, unknown>[] {
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

export function labelize(value: unknown): string {
    if (value === undefined || value === null || value === '') return 'Unknown';
    return String(value)
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Cents → dollars, rounded; non-numeric → 0. */
export function money(cents: unknown): number {
    const n = typeof cents === 'number' ? cents : Number(cents);
    return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

export function groupCountChart(
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

export const STATUS_ORDER = ['draft', 'pending', 'in_progress', 'blocked', 'completed', 'archived'];

export function boardArtifact(
    title: string,
    rows: Record<string, unknown>[],
    statusField: string,
): CanvasArtifact {
    const byStatus = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
        const key = String(row[statusField] ?? 'unknown');
        if (!byStatus.has(key)) byStatus.set(key, []);
        byStatus.get(key)!.push(row);
    }
    const keys = [
        ...STATUS_ORDER.filter((s) => byStatus.has(s)),
        ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s)),
    ];
    return {
        id: randomUUID(),
        kind: 'kanban',
        title,
        columns: keys.map((key) => ({
            key,
            label: labelize(key),
            cards: (byStatus.get(key) ?? []).map((row) => ({
                title: String(row.title ?? row.name ?? row.slug ?? 'Untitled'),
                subtitle: row.priority ? `Priority: ${labelize(row.priority)}` : undefined,
            })),
        })),
        description: `${rows.length} item(s).`,
    };
}

export function countStat(
    title: string,
    rows: Record<string, unknown>[],
    label: string,
): CanvasArtifact {
    return {
        id: randomUUID(),
        kind: 'stat',
        title,
        stats: [{ label, value: rows.length }],
    };
}
