'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';
import { transitionTaskAction } from '@/app/actions/tasks';
import {
    Inbox,
    Circle,
    Loader2,
    Eye,
    Ban,
    CheckCircle2,
    XCircle,
    ChevronDown,
    type LucideIcon,
} from 'lucide-react';

const MAX_VISIBLE = 15;

// ─── Column definitions ────────────────────────────────────────────────────

interface ColumnDef {
    key: TaskStatus;
    label: string;
    icon: LucideIcon;
    spinning?: boolean;
    dotClass: string;
    headerClass: string;
    countClass: string;
    cardBorderClass: string;
    iconBgClass: string;
    iconColorClass: string;
}

const COLUMNS: ColumnDef[] = [
    {
        key: 'backlog',
        label: 'Backlog',
        icon: Inbox,
        dotClass: 'bg-slate-400',
        headerClass: 'bg-slate-50 dark:bg-slate-950/20 border-slate-200 dark:border-slate-700/40',
        countClass: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
        cardBorderClass:
            'border-slate-200/60 dark:border-slate-700/30 hover:border-slate-300 dark:hover:border-slate-600/50',
        iconBgClass: 'bg-slate-50 dark:bg-slate-800/20',
        iconColorClass: 'text-slate-500 dark:text-slate-400',
    },
    {
        key: 'todo',
        label: 'Todo',
        icon: Circle,
        dotClass: 'bg-info',
        headerClass: 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800/40',
        countClass: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
        cardBorderClass:
            'border-blue-200/60 dark:border-blue-800/30 hover:border-blue-300 dark:hover:border-blue-700/50',
        iconBgClass: 'bg-blue-50 dark:bg-blue-900/20',
        iconColorClass: 'text-info dark:text-blue-400',
    },
    {
        key: 'in_progress',
        label: 'In Progress',
        icon: Loader2,
        spinning: true,
        dotClass: 'bg-warning animate-pulse',
        headerClass: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/40',
        countClass: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
        cardBorderClass:
            'border-amber-200/60 dark:border-amber-800/30 hover:border-amber-300 dark:hover:border-amber-700/50',
        iconBgClass: 'bg-amber-50 dark:bg-amber-900/20',
        iconColorClass: 'text-warning dark:text-amber-400',
    },
    {
        key: 'in_review',
        label: 'In Review',
        icon: Eye,
        dotClass: 'bg-violet-500',
        headerClass:
            'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800/40',
        countClass: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300',
        cardBorderClass:
            'border-violet-200/60 dark:border-violet-800/30 hover:border-violet-300 dark:hover:border-violet-700/50',
        iconBgClass: 'bg-violet-50 dark:bg-violet-900/20',
        iconColorClass: 'text-violet-600 dark:text-violet-400',
    },
    {
        key: 'blocked',
        label: 'Blocked',
        icon: Ban,
        dotClass: 'bg-danger',
        headerClass: 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800/40',
        countClass: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
        cardBorderClass:
            'border-red-200/60 dark:border-red-800/30 hover:border-red-300 dark:hover:border-red-700/50',
        iconBgClass: 'bg-red-50 dark:bg-red-900/20',
        iconColorClass: 'text-danger dark:text-red-400',
    },
    {
        key: 'done',
        label: 'Done',
        icon: CheckCircle2,
        dotClass: 'bg-success',
        headerClass:
            'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/40',
        countClass: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
        cardBorderClass:
            'border-emerald-200/60 dark:border-emerald-800/30 hover:border-emerald-300 dark:hover:border-emerald-700/50',
        iconBgClass: 'bg-emerald-50 dark:bg-emerald-900/20',
        iconColorClass: 'text-success dark:text-emerald-400',
    },
    {
        key: 'cancelled',
        label: 'Cancelled',
        icon: XCircle,
        dotClass: 'bg-text-muted',
        headerClass: 'bg-slate-50 dark:bg-slate-950/20 border-slate-200 dark:border-slate-700/40',
        countClass: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
        cardBorderClass:
            'border-slate-200/60 dark:border-slate-700/30 hover:border-slate-300 dark:hover:border-slate-600/50',
        iconBgClass: 'bg-slate-50 dark:bg-slate-800/20',
        iconColorClass: 'text-text-muted dark:text-slate-500',
    },
];

// Mirror of TaskTransitionService.canTransition() lattice (client-side
// for the move-menu affordance). Server still authoritative.
const NEXT_STATUS: Record<TaskStatus, TaskStatus[]> = {
    backlog: ['todo', 'cancelled'],
    todo: ['in_progress', 'blocked', 'cancelled'],
    in_progress: ['in_review', 'blocked', 'done', 'cancelled'],
    in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
    blocked: ['todo', 'in_progress', 'cancelled'],
    done: ['in_progress'],
    cancelled: [],
};

const PRIORITY_TONES: Record<TaskPriority, string> = {
    p0: 'bg-danger/20 text-danger',
    p1: 'bg-danger/10 text-danger',
    p2: 'bg-warning/10 text-warning',
    p3: 'bg-surface-secondary text-text-secondary',
    p4: 'bg-text-muted/10 text-text-muted',
};

// ─── Kanban card ───────────────────────────────────────────────────────────

function TaskKanbanCard({
    task,
    col,
    onMove,
    error,
    onDragStart,
    onDragEnd,
}: {
    task: Task;
    col: ColumnDef;
    onMove: (to: TaskStatus) => void;
    error: string | null;
    onDragStart?: () => void;
    onDragEnd?: () => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [pending, startTransition] = useTransition();
    const [dragging, setDragging] = useState(false);
    const targets = NEXT_STATUS[task.status] ?? [];

    return (
        <div
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData('text/x-task-id', task.id);
                e.dataTransfer.effectAllowed = 'move';
                setDragging(true);
                onDragStart?.();
            }}
            onDragEnd={() => {
                setDragging(false);
                onDragEnd?.();
            }}
            className={cn(
                'group flex flex-col gap-2 p-3.5 rounded-lg border',
                'bg-card dark:bg-card-primary-dark/70',
                'transition-all duration-150 cursor-grab active:cursor-grabbing',
                col.cardBorderClass,
                dragging && 'opacity-50',
            )}
        >
            {/* Header: slug + priority */}
            <div className="flex items-center justify-between gap-2">
                <Link
                    href={ROUTES.DASHBOARD_TASK(task.id)}
                    className="text-[10px] font-mono text-text-muted hover:text-primary"
                >
                    {task.slug}
                </Link>
                <span
                    className={cn(
                        'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0',
                        PRIORITY_TONES[task.priority],
                    )}
                >
                    {task.priority}
                </span>
            </div>

            {/* Title */}
            <Link
                href={ROUTES.DASHBOARD_TASK(task.id)}
                className="text-xs font-semibold text-text dark:text-text-dark leading-snug line-clamp-2 hover:text-primary"
            >
                {task.title}
            </Link>

            {/* Labels */}
            {(task.labels ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {(task.labels ?? []).slice(0, 3).map((label) => (
                        <span
                            key={label}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                        >
                            {label}
                        </span>
                    ))}
                </div>
            )}

            {/* Footer: move menu + updated */}
            <div className="flex items-center justify-between pt-2 border-t border-border dark:border-border-dark mt-auto">
                {targets.length > 0 ? (
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setMenuOpen((v) => !v)}
                            className="text-[10px] text-text-muted hover:text-primary underline"
                            aria-expanded={menuOpen}
                        >
                            Move →
                        </button>
                        {menuOpen && (
                            <ul className="absolute bottom-full left-0 mb-1 flex flex-col gap-0.5 z-10 bg-card dark:bg-card-primary-dark border border-border/60 dark:border-border-dark/60 rounded-md p-1 shadow-sm min-w-[110px]">
                                {targets.map((to) => (
                                    <li key={to}>
                                        <button
                                            type="button"
                                            disabled={pending}
                                            onClick={() => {
                                                startTransition(() => onMove(to));
                                                setMenuOpen(false);
                                            }}
                                            className="w-full text-left text-[10px] px-2 py-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary disabled:opacity-50"
                                        >
                                            {to.replace('_', ' ')}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ) : (
                    <span />
                )}
                <span className="text-[10px] text-text-muted dark:text-text-muted-dark shrink-0 ml-2">
                    {new Date(task.updatedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                    })}
                </span>
            </div>

            {error && (
                <p className="text-[10px] text-danger" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

// ─── Column ────────────────────────────────────────────────────────────────

function TaskKanbanColumn({
    col,
    tasks,
    errors,
    draggingTaskId,
    dropTargetStatus,
    onMove,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
}: {
    col: ColumnDef;
    tasks: Task[];
    errors: Record<string, string | null>;
    draggingTaskId: string | null;
    dropTargetStatus: TaskStatus | null;
    onMove: (taskId: string, to: TaskStatus) => void;
    onDragStart: (taskId: string) => void;
    onDragEnd: () => void;
    onDragOver: (e: React.DragEvent, status: TaskStatus) => void;
    onDragLeave: (e: React.DragEvent, status: TaskStatus) => void;
    onDrop: (e: React.DragEvent, status: TaskStatus) => void;
}) {
    const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);
    const Icon = col.icon;

    const visibleTasks = tasks.slice(0, visibleCount);
    const remaining = tasks.length - visibleCount;
    const hasMore = remaining > 0;
    const isDropActive = dropTargetStatus === col.key && draggingTaskId !== null;

    return (
        <div className="flex flex-col min-w-[220px] w-full flex-1">
            {/* Column header */}
            <div
                className={cn(
                    'flex items-center gap-2 px-3 py-2.5 rounded-t-lg border border-b-0',
                    col.headerClass,
                )}
            >
                <span className={cn('w-2 h-2 rounded-full shrink-0', col.dotClass)} />
                <Icon className={cn('w-3.5 h-3.5 shrink-0', col.iconColorClass)} />
                <span className="text-xs font-semibold text-text dark:text-text-dark flex-1 truncate">
                    {col.label}
                </span>
                <span
                    className={cn(
                        'min-w-5 text-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                        col.countClass,
                    )}
                >
                    {tasks.length}
                </span>
            </div>

            {/* Card list — fixed height, scrollable */}
            <div
                onDragOver={(e) => onDragOver(e, col.key)}
                onDragLeave={(e) => onDragLeave(e, col.key)}
                onDrop={(e) => onDrop(e, col.key)}
                className={cn(
                    'flex flex-col gap-2 p-2 overflow-y-auto border border-t-0',
                    'border-slate-200/60 dark:border-white/8',
                    'bg-slate-50/50 dark:bg-white/1.5',
                    'min-h-[120px] h-[600px]',
                    !hasMore && 'rounded-b-lg',
                    isDropActive && 'ring-2 ring-inset ring-primary/40',
                )}
            >
                {tasks.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-6">
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark text-center italic">
                            empty
                        </p>
                    </div>
                ) : (
                    visibleTasks.map((task) => (
                        <TaskKanbanCard
                            key={task.id}
                            task={task}
                            col={col}
                            onMove={(to) => onMove(task.id, to)}
                            error={errors[task.id] ?? null}
                            onDragStart={() => onDragStart(task.id)}
                            onDragEnd={onDragEnd}
                        />
                    ))
                )}
            </div>

            {/* Load more */}
            {hasMore && (
                <button
                    onClick={() => setVisibleCount((v) => v + MAX_VISIBLE)}
                    className={cn(
                        'flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-b-lg border border-t-0',
                        'border-slate-200/60 dark:border-white/8',
                        'bg-slate-50 dark:bg-white/2',
                        'text-[11px] font-medium text-text-muted dark:text-text-muted-dark',
                        'hover:bg-slate-100 dark:hover:bg-white/4 hover:text-text-secondary dark:hover:text-text-secondary-dark',
                        'transition-colors',
                    )}
                >
                    <ChevronDown className="w-3 h-3" />
                    Show {Math.min(remaining, MAX_VISIBLE)} more
                </button>
            )}
        </div>
    );
}

// ─── Main export ───────────────────────────────────────────────────────────

export function TasksKanbanView({ tasks: initialTasks }: { tasks: Task[] }) {
    const [tasks, setTasks] = useState(initialTasks);
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
    const [dropTargetStatus, setDropTargetStatus] = useState<TaskStatus | null>(null);

    // `useState(initialTasks)` only seeds on the first render, so any later
    // change to the `tasks` prop (filter swap, parent refetch) would never
    // reach the board. Sync explicitly when the prop reference changes.
    useEffect(() => {
        setTasks(initialTasks);
    }, [initialTasks]);

    const grouped = useMemo(() => {
        const map = new Map<TaskStatus, Task[]>(COLUMNS.map((c) => [c.key, []]));
        for (const t of tasks) map.get(t.status)?.push(t);
        return map;
    }, [tasks]);

    const handleMove = (taskId: string, to: TaskStatus) => {
        const before = tasks.find((t) => t.id === taskId);
        if (!before) return;
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: to } : t)));
        setErrors((e) => ({ ...e, [taskId]: null }));
        void (async () => {
            try {
                const updated = await transitionTaskAction(taskId, to);
                setTasks((prev) =>
                    prev.map((t) => (t.id === taskId ? { ...t, status: updated.status } : t)),
                );
            } catch (err) {
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

    const handleDragOver = (e: React.DragEvent, status: TaskStatus) => {
        if (!draggingTaskId) return;
        const src = tasks.find((t) => t.id === draggingTaskId);
        if (!src || src.status === status) return;
        if (!(NEXT_STATUS[src.status] ?? []).includes(status)) return;
        e.preventDefault();
        setDropTargetStatus(status);
    };

    const handleDragLeave = (e: React.DragEvent, status: TaskStatus) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
        ) {
            setDropTargetStatus((prev) => (prev === status ? null : prev));
        }
    };

    const handleDrop = (e: React.DragEvent, status: TaskStatus) => {
        e.preventDefault();
        const taskId = draggingTaskId ?? e.dataTransfer.getData('text/x-task-id');
        setDropTargetStatus(null);
        setDraggingTaskId(null);
        if (!taskId) return;
        const src = tasks.find((t) => t.id === taskId);
        if (!src || src.status === status) return;
        if (!(NEXT_STATUS[src.status] ?? []).includes(status)) return;
        handleMove(taskId, status);
    };

    return (
        <div className="w-full overflow-x-auto pb-2">
            <div className="flex gap-3 min-w-[900px]">
                {COLUMNS.map((col) => (
                    <TaskKanbanColumn
                        key={col.key}
                        col={col}
                        tasks={grouped.get(col.key)!}
                        errors={errors}
                        draggingTaskId={draggingTaskId}
                        dropTargetStatus={dropTargetStatus}
                        onMove={handleMove}
                        onDragStart={setDraggingTaskId}
                        onDragEnd={() => {
                            setDraggingTaskId(null);
                            setDropTargetStatus(null);
                        }}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    />
                ))}
            </div>
        </div>
    );
}
