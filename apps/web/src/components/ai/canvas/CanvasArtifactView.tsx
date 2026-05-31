'use client';

import {
    ResponsiveContainer,
    LineChart,
    Line,
    BarChart,
    Bar,
    AreaChart,
    Area,
    PieChart,
    Pie,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
} from 'recharts';
import { cn } from '@/lib/utils/cn';
import type {
    CanvasArtifact,
    ChartArtifact,
    TableArtifact,
    StatArtifact,
    DetailArtifact,
    KanbanArtifact,
} from './types';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444'];

function colorAt(index: number, explicit?: string): string {
    return explicit ?? PALETTE[index % PALETTE.length];
}

export function CanvasArtifactView({ artifact }: { artifact: CanvasArtifact }) {
    switch (artifact.kind) {
        case 'chart':
            return <ChartView artifact={artifact} />;
        case 'table':
            return <TableView artifact={artifact} />;
        case 'stat':
            return <StatView artifact={artifact} />;
        case 'detail':
            return <DetailView artifact={artifact} />;
        case 'kanban':
            return <KanbanView artifact={artifact} />;
        default:
            return null;
    }
}

function ChartView({ artifact }: { artifact: ChartArtifact }) {
    const { chartType, data, xKey, series } = artifact;

    if (!data?.length) {
        return <EmptyState label="No data to chart" />;
    }

    if (chartType === 'pie') {
        const valueKey = series[0]?.key ?? 'value';
        return (
            <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie data={data} dataKey={valueKey} nameKey={xKey} outerRadius={110} label>
                            {data.map((_, i) => (
                                <Cell key={i} fill={colorAt(i)} />
                            ))}
                        </Pie>
                        <Tooltip />
                        <Legend />
                    </PieChart>
                </ResponsiveContainer>
            </div>
        );
    }

    return (
        <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
                {chartType === 'bar' ? (
                    <BarChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                        <XAxis dataKey={xKey} fontSize={11} />
                        <YAxis fontSize={11} />
                        <Tooltip />
                        <Legend />
                        {series.map((s, i) => (
                            <Bar
                                key={s.key}
                                dataKey={s.key}
                                name={s.label ?? s.key}
                                fill={colorAt(i, s.color)}
                            />
                        ))}
                    </BarChart>
                ) : chartType === 'area' ? (
                    <AreaChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                        <XAxis dataKey={xKey} fontSize={11} />
                        <YAxis fontSize={11} />
                        <Tooltip />
                        <Legend />
                        {series.map((s, i) => (
                            <Area
                                key={s.key}
                                type="monotone"
                                dataKey={s.key}
                                name={s.label ?? s.key}
                                stroke={colorAt(i, s.color)}
                                fill={colorAt(i, s.color)}
                                fillOpacity={0.2}
                            />
                        ))}
                    </AreaChart>
                ) : (
                    <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                        <XAxis dataKey={xKey} fontSize={11} />
                        <YAxis fontSize={11} />
                        <Tooltip />
                        <Legend />
                        {series.map((s, i) => (
                            <Line
                                key={s.key}
                                type="monotone"
                                dataKey={s.key}
                                name={s.label ?? s.key}
                                stroke={colorAt(i, s.color)}
                                dot={false}
                            />
                        ))}
                    </LineChart>
                )}
            </ResponsiveContainer>
        </div>
    );
}

function TableView({ artifact }: { artifact: TableArtifact }) {
    if (!artifact.rows?.length) return <EmptyState label="No rows" />;
    return (
        <div className="overflow-auto rounded-lg border border-border dark:border-white/10">
            <table className="w-full text-left text-xs">
                <thead className="bg-surface-secondary/60 dark:bg-white/[0.04]">
                    <tr>
                        {artifact.columns.map((c) => (
                            <th
                                key={c.key}
                                className="px-3 py-2 font-medium text-text dark:text-text-dark"
                            >
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {artifact.rows.map((row, i) => (
                        <tr key={i} className="border-t border-border/60 dark:border-white/[0.06]">
                            {artifact.columns.map((c) => (
                                <td
                                    key={c.key}
                                    className="px-3 py-2 text-text-muted dark:text-text-muted-dark"
                                >
                                    {formatCell(row[c.key])}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function StatView({ artifact }: { artifact: StatArtifact }) {
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {artifact.stats.map((s, i) => (
                <div
                    key={i}
                    className="rounded-lg border border-border bg-surface-secondary/40 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]"
                >
                    <p className="text-xl font-semibold text-text dark:text-white">{s.value}</p>
                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                        {s.label}
                    </p>
                    {s.hint ? (
                        <p className="mt-0.5 text-[10px] text-text-muted/70 dark:text-text-muted-dark/70">
                            {s.hint}
                        </p>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

function DetailView({ artifact }: { artifact: DetailArtifact }) {
    return (
        <div className="space-y-3">
            {artifact.badges?.length ? (
                <div className="flex flex-wrap gap-1.5">
                    {artifact.badges.map((b, i) => (
                        <span
                            key={i}
                            className={cn(
                                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                                b.tone === 'success' && 'bg-success/10 text-success',
                                b.tone === 'warning' && 'bg-warning/10 text-warning',
                                b.tone === 'danger' && 'bg-danger/10 text-danger',
                                (!b.tone || b.tone === 'default') &&
                                    'bg-surface-secondary text-text-muted dark:bg-white/[0.06] dark:text-text-muted-dark',
                            )}
                        >
                            {b.label}
                        </span>
                    ))}
                </div>
            ) : null}
            <dl className="divide-y divide-border/60 rounded-lg border border-border dark:divide-white/[0.06] dark:border-white/10">
                {artifact.fields.map((f, i) => (
                    <div key={i} className="flex gap-3 px-3 py-2">
                        <dt className="w-32 shrink-0 text-[11px] text-text-muted dark:text-text-muted-dark">
                            {f.label}
                        </dt>
                        <dd className="flex-1 break-words text-xs text-text dark:text-text-dark">
                            {formatCell(f.value)}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function KanbanView({ artifact }: { artifact: KanbanArtifact }) {
    if (!artifact.columns?.length) return <EmptyState label="No columns" />;
    return (
        <div className="flex gap-3 overflow-x-auto pb-2">
            {artifact.columns.map((col) => (
                <div
                    key={col.key}
                    className="flex w-56 shrink-0 flex-col rounded-lg border border-border bg-surface-secondary/40 dark:border-border-dark dark:bg-white/[0.03]"
                >
                    <div className="flex items-center justify-between border-b border-border px-3 py-2 dark:border-border-dark">
                        <span className="text-[11px] font-medium text-text dark:text-text-dark">
                            {col.label}
                        </span>
                        <span className="rounded-full bg-surface-secondary px-1.5 text-[10px] text-text-muted dark:bg-white/[0.06] dark:text-text-muted-dark">
                            {col.cards.length}
                        </span>
                    </div>
                    <div className="flex flex-col gap-1.5 p-2">
                        {col.cards.map((card, i) => (
                            <div
                                key={i}
                                className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-text dark:border-border-dark dark:bg-surface-dark dark:text-text-dark"
                            >
                                <p className="truncate font-medium">{card.title}</p>
                                {card.subtitle ? (
                                    <p className="truncate text-[10px] text-text-muted dark:text-text-muted-dark">
                                        {card.subtitle}
                                    </p>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function EmptyState({ label }: { label: string }) {
    return (
        <div className="flex h-40 items-center justify-center text-xs text-text-muted dark:text-text-muted-dark">
            {label}
        </div>
    );
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}
