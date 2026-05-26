'use client';

import { useMemo, useState, useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';
import { transitionTaskAction } from '@/app/actions/tasks';

const COLUMN_ORDER: TaskStatus[] = [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
];

const COLUMN_LABELS: Record<TaskStatus, string> = {
    backlog: 'Backlog',
    todo: 'Todo',
    in_progress: 'In progress',
    in_review: 'In review',
    blocked: 'Blocked',
    done: 'Done',
    cancelled: 'Cancelled',
};

const COLUMN_TONES: Record<TaskStatus, string> = {
    backlog: 'border-text-muted/30 bg-surface-secondary/40',
    todo: 'border-info/30 bg-info/5',
    in_progress: 'border-warning/30 bg-warning/5',
    in_review: 'border-warning/30 bg-warning/5',
    blocked: 'border-danger/30 bg-danger/5',
    done: 'border-success/30 bg-success/5',
    cancelled: 'border-text-muted/30 bg-text-muted/5',
};

const PRIORITY_TONES: Record<TaskPriority, string> = {
    p0: 'bg-danger/20 text-danger',
    p1: 'bg-danger/10 text-danger',
    p2: 'bg-warning/10 text-warning',
    p3: 'bg-surface-secondary text-text-secondary',
    p4: 'bg-text-muted/10 text-text-muted',
};

// Mirror of TaskTransitionService.canTransition() lattice (client-side
// for the move-menu affordance). Server still authoritative — the
// PATCH /tasks/:id/transition call rejects illegal jumps.
const NEXT_STATUS: Record<TaskStatus, TaskStatus[]> = {
    backlog: ['todo', 'cancelled'],
    todo: ['in_progress', 'blocked', 'cancelled'],
    in_progress: ['in_review', 'blocked', 'done', 'cancelled'],
    in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
    blocked: ['todo', 'in_progress', 'cancelled'],
    done: ['in_progress'],
    cancelled: [],
};

/**
 * Tasks feature — Phase 14.1.
 *
 * Kanban view modeled on WorksKanbanView.tsx — columns per status,
 * Cards inside each. v1 ships click-to-transition (popover menu on
 * each card) instead of drag-drop, so we don't take a dnd library
 * dependency this tick. The server's PATCH /tasks/:id/transition
 * endpoint is the same whether the move came from a drag-drop or a
 * click; drag-drop wires in later via a thin keyboard-accessible
 * wrapper.
 *
 * Transitions are optimistic-update: the card moves to the target
 * column immediately, and reverts on server rejection.
 */
export function TasksKanbanView({ tasks: initialTasks }: { tasks: Task[] }) {
    const [tasks, setTasks] = useState(initialTasks);
    const [errors, setErrors] = useState<Record<string, string | null>>({});

    const columns = useMemo(() => {
        const out: Record<TaskStatus, Task[]> = {
            backlog: [],
            todo: [],
            in_progress: [],
            in_review: [],
            blocked: [],
            done: [],
            cancelled: [],
        };
        for (const t of tasks) out[t.status].push(t);
        return out;
    }, [tasks]);

    const handleMove = (taskId: string, to: TaskStatus) => {
        const before = tasks.find((t) => t.id === taskId);
        if (!before) return;
        // Optimistic update — flip status locally.
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: to } : t)));
        setErrors((e) => ({ ...e, [taskId]: null }));
        void (async () => {
            try {
                const updated = await transitionTaskAction(taskId, to);
                setTasks((prev) =>
                    prev.map((t) => (t.id === taskId ? { ...t, status: updated.status } : t)),
                );
            } catch (err) {
                // Revert on failure.
                setTasks((prev) =>
                    prev.map((t) => (t.id === taskId ? { ...t, status: before.status } : t)),
                );
                setErrors((e) => ({
                    ...e,
                    [taskId]: err instanceof Error ? err.message : 'Transition failed',
                }));
            }
        })();
    };

    return (
        <div className="grid grid-flow-col auto-cols-[260px] gap-3 overflow-x-auto pb-4">
            {COLUMN_ORDER.map((status) => (
                <div
                    key={status}
                    className={`rounded-lg border ${COLUMN_TONES[status]} p-3 flex flex-col gap-2 min-h-[200px]`}
                >
                    <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-text dark:text-text-dark">
                            {COLUMN_LABELS[status]}
                        </span>
                        <span className="text-text-muted">{columns[status].length}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                        {columns[status].map((task) => (
                            <KanbanCard
                                key={task.id}
                                task={task}
                                onMove={(to) => handleMove(task.id, to)}
                                error={errors[task.id] ?? null}
                            />
                        ))}
                        {columns[status].length === 0 && (
                            <p className="text-[11px] text-text-muted italic text-center py-4">
                                empty
                            </p>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}

function KanbanCard({
    task,
    onMove,
    error,
}: {
    task: Task;
    onMove: (to: TaskStatus) => void;
    error: string | null;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [pending, startTransition] = useTransition();
    const targets = NEXT_STATUS[task.status] ?? [];

    return (
        <div className="rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-xs">
            <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-text-muted">
                <Link href={ROUTES.DASHBOARD_TASK(task.id)} className="hover:text-text">
                    {task.slug}
                </Link>
                <span
                    className={`uppercase tracking-wide px-1 py-0.5 rounded ${PRIORITY_TONES[task.priority]}`}
                >
                    {task.priority}
                </span>
            </div>
            <Link
                href={ROUTES.DASHBOARD_TASK(task.id)}
                className="block text-text dark:text-text-dark mt-1 line-clamp-2 hover:text-primary"
            >
                {task.title}
            </Link>
            {(task.labels ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {(task.labels ?? []).slice(0, 3).map((l) => (
                        <span
                            key={l}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                        >
                            {l}
                        </span>
                    ))}
                </div>
            )}
            {targets.length > 0 && (
                <div className="mt-2">
                    <button
                        type="button"
                        onClick={() => setMenuOpen((v) => !v)}
                        className="text-[10px] text-text-muted hover:text-primary underline"
                        aria-expanded={menuOpen}
                    >
                        Move →
                    </button>
                    {menuOpen && (
                        <ul className="mt-1 flex flex-wrap gap-1">
                            {targets.map((to) => (
                                <li key={to}>
                                    <button
                                        type="button"
                                        disabled={pending}
                                        onClick={() => {
                                            startTransition(() => onMove(to));
                                            setMenuOpen(false);
                                        }}
                                        className="text-[10px] px-1.5 py-0.5 rounded border border-border/60 dark:border-border-dark/60 hover:border-primary hover:text-primary"
                                    >
                                        {to.replace('_', ' ')}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
            {error && (
                <p className="text-[10px] text-danger mt-1" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
