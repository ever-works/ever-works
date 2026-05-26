'use client';

import { useMemo, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';

const STATUS_TONES: Record<TaskStatus, string> = {
    backlog: 'bg-surface-secondary text-text-secondary',
    todo: 'bg-info/10 text-info',
    in_progress: 'bg-warning/10 text-warning',
    in_review: 'bg-warning/10 text-warning',
    blocked: 'bg-danger/10 text-danger',
    done: 'bg-success/10 text-success',
    cancelled: 'bg-text-muted/10 text-text-muted',
};

const PRIORITY_TONES: Record<TaskPriority, string> = {
    p0: 'bg-danger/20 text-danger',
    p1: 'bg-danger/10 text-danger',
    p2: 'bg-warning/10 text-warning',
    p3: 'bg-surface-secondary text-text-secondary',
    p4: 'bg-text-muted/10 text-text-muted',
};

/**
 * Agents/Skills/Tasks PR #1017 — Phase 12.6 client. View-mode
 * switch (Cards / Table) + status filter. v1 ships both views;
 * Kanban + drag-drop transitions land in Phase 14.
 */
export function TasksList({ tasks }: { tasks: Task[] }) {
    const [view, setView] = useState<'cards' | 'table'>('cards');
    const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');

    const filtered = useMemo(
        () => (statusFilter === 'all' ? tasks : tasks.filter((t) => t.status === statusFilter)),
        [tasks, statusFilter],
    );

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1">
                    {(['cards', 'table'] as const).map((v) => (
                        <button
                            key={v}
                            type="button"
                            onClick={() => setView(v)}
                            className={`text-xs px-2.5 py-1 rounded border transition-colors capitalize ${
                                view === v
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border/60 dark:border-border-dark/60 text-text-secondary hover:text-text'
                            }`}
                        >
                            {v}
                        </button>
                    ))}
                </div>
                <span className="text-xs text-text-muted">·</span>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'all')}
                    className="text-xs px-2.5 py-1 rounded border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark text-text dark:text-text-dark"
                >
                    <option value="all">All statuses</option>
                    <option value="backlog">Backlog</option>
                    <option value="todo">Todo</option>
                    <option value="in_progress">In progress</option>
                    <option value="in_review">In review</option>
                    <option value="blocked">Blocked</option>
                    <option value="done">Done</option>
                    <option value="cancelled">Cancelled</option>
                </select>
                <span className="text-xs text-text-muted ml-auto">
                    {filtered.length} of {tasks.length}
                </span>
            </div>

            {filtered.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                    No Tasks {statusFilter === 'all' ? 'yet' : `in status "${statusFilter}"`}.
                </div>
            ) : view === 'cards' ? (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {filtered.map((t) => (
                        <TaskCard key={t.id} task={t} />
                    ))}
                </div>
            ) : (
                <TaskTable tasks={filtered} />
            )}
        </div>
    );
}

function TaskCard({ task }: { task: Task }) {
    return (
        <Link
            href={ROUTES.DASHBOARD_TASK(task.id)}
            className="block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-border transition-colors"
        >
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-text-muted">
                <span>{task.slug}</span>
                <span
                    className={`uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[task.priority]}`}
                >
                    {task.priority}
                </span>
            </div>
            <h3 className="text-sm font-semibold text-text dark:text-text-dark mt-2 truncate">
                {task.title}
            </h3>
            {task.description && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 line-clamp-2">
                    {task.description}
                </p>
            )}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_TONES[task.status]}`}
                >
                    {task.status.replace('_', ' ')}
                </span>
                {(task.labels ?? []).slice(0, 3).map((label) => (
                    <span
                        key={label}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                    >
                        {label}
                    </span>
                ))}
            </div>
        </Link>
    );
}

function TaskTable({ tasks }: { tasks: Task[] }) {
    return (
        <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
            <table className="w-full text-sm">
                <thead className="bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 text-xs text-text-secondary">
                    <tr>
                        <th className="text-left px-4 py-2 font-medium">Slug</th>
                        <th className="text-left px-4 py-2 font-medium">Title</th>
                        <th className="text-left px-4 py-2 font-medium">Status</th>
                        <th className="text-left px-4 py-2 font-medium">Priority</th>
                        <th className="text-left px-4 py-2 font-medium">Updated</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/60 dark:divide-border-dark/60">
                    {tasks.map((t) => (
                        <tr key={t.id} className="hover:bg-surface-secondary/30">
                            <td className="px-4 py-2 font-mono text-xs text-text-muted">{t.slug}</td>
                            <td className="px-4 py-2">
                                <Link
                                    href={ROUTES.DASHBOARD_TASK(t.id)}
                                    className="text-text dark:text-text-dark hover:text-primary"
                                >
                                    {t.title}
                                </Link>
                            </td>
                            <td className="px-4 py-2">
                                <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_TONES[t.status]}`}
                                >
                                    {t.status.replace('_', ' ')}
                                </span>
                            </td>
                            <td className="px-4 py-2">
                                <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_TONES[t.priority]}`}
                                >
                                    {t.priority}
                                </span>
                            </td>
                            <td className="px-4 py-2 text-xs text-text-muted">
                                {new Date(t.updatedAt).toLocaleDateString()}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
