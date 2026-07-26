'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';
import {
    listTaskRunCandidatesAction,
    runTasksBatchAction,
    transitionTaskAction,
} from '@/app/actions/tasks';
import { useTaskRunPolling } from '@/lib/hooks/use-task-run-polling';
import { TaskBranchChip } from './TaskBranchChip';
import { TaskRunChip } from './TaskRunChip';
import { GateChip } from './GateChip';
import { RunWithAgentMenu } from './RunWithAgentMenu';
import {
    Inbox,
    Circle,
    Loader2,
    Eye,
    Ban,
    CheckCircle2,
    XCircle,
    ChevronDown,
    Play,
    type LucideIcon,
} from 'lucide-react';

const MAX_VISIBLE = 15;

/**
 * Board dispatch (kanban M4) — hard cap on the column "Run all" action,
 * mirroring the API's `RUN_BATCH_MAX_TASKS`. The button labels itself
 * with the real count so a 40-card column never silently runs 20.
 */
const RUN_ALL_MAX = 20;

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
    pickerOpen,
    onPickerOpenChange,
}: {
    task: Task;
    col: ColumnDef;
    onMove: (to: TaskStatus) => void;
    error: string | null;
    onDragStart?: () => void;
    onDragEnd?: () => void;
    /** Board-driven picker state — set when a drag landed with no Agent. */
    pickerOpen: boolean;
    onPickerOpenChange: (open: boolean) => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [pending, startTransition] = useTransition();
    const [dragging, setDragging] = useState(false);
    const targets = NEXT_STATUS[task.status] ?? [];
    const runButtonRef = useRef<HTMLDivElement | null>(null);

    return (
        <div
            draggable
            // Board dispatch (kanban M3) — the card is focusable so `r`
            // has something to act on. `tabIndex={0}` + a role keeps it
            // reachable by keyboard without turning the whole card into
            // a button (it still holds links and its own menus).
            tabIndex={0}
            role="group"
            aria-label={`${task.slug} — ${task.title}`}
            data-testid="task-kanban-card"
            onKeyDown={(e) => {
                // `r` runs the focused card. Ignore it while a modifier
                // is held (browser shortcuts) or while focus sits in a
                // text field, and ignore repeats from a held key.
                if (e.key !== 'r' && e.key !== 'R') return;
                if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
                const target = e.target as HTMLElement | null;
                const tag = target?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
                e.preventDefault();
                runButtonRef.current
                    ?.querySelector<HTMLButtonElement>('[data-testid="task-run-button"]')
                    ?.click();
            }}
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
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
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

            {/* Wave 2 M7 — isolated-branch chip · Wave 2 run cockpit — run
                chip · Wave 3 M6 — gate chip when the latest run carries a
                gate verdict. */}
            {(task.branchRef || task.run) && (
                <div className="flex flex-wrap gap-1">
                    {task.branchRef && <TaskBranchChip task={task} />}
                    {task.run && <TaskRunChip task={task} />}
                    {task.run?.gateStatus && <GateChip status={task.run.gateStatus} />}
                </div>
            )}

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
                <div className="flex items-center gap-2 shrink-0 ml-2">
                    {/* Board dispatch (kanban M3) — run this Task without
                        leaving the board. Also the target of the `r`
                        shortcut and of the board's drag fallback. */}
                    <div ref={runButtonRef}>
                        <RunWithAgentMenu
                            taskId={task.id}
                            compact
                            open={pickerOpen}
                            onOpenChange={onPickerOpenChange}
                        />
                    </div>
                    <span className="text-[10px] text-text-muted dark:text-text-muted-dark">
                        {new Date(task.updatedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                        })}
                    </span>
                </div>
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
    pickerTaskId,
    onPickerTaskChange,
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
    pickerTaskId: string | null;
    onPickerTaskChange: (taskId: string | null) => void;
    onMove: (taskId: string, to: TaskStatus) => void;
    onDragStart: (taskId: string) => void;
    onDragEnd: () => void;
    onDragOver: (e: React.DragEvent, status: TaskStatus) => void;
    onDragLeave: (e: React.DragEvent, status: TaskStatus) => void;
    onDrop: (e: React.DragEvent, status: TaskStatus) => void;
}) {
    const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);
    const [batchBusy, setBatchBusy] = useState(false);
    const [batchSummary, setBatchSummary] = useState<string | null>(null);
    const Icon = col.icon;

    const visibleTasks = tasks.slice(0, visibleCount);
    const remaining = tasks.length - visibleCount;
    const hasMore = remaining > 0;
    const isDropActive = dropTargetStatus === col.key && draggingTaskId !== null;

    // Board dispatch (kanban M4) — "Run all" is offered only where it
    // means something: columns holding work that has not been handed to
    // an agent yet. Running a done/cancelled column is not a feature.
    const runAllEligible = col.key === 'todo' || col.key === 'backlog' || col.key === 'in_progress';
    const runAllTargets = tasks.slice(0, RUN_ALL_MAX);

    const handleRunAll = async () => {
        if (runAllTargets.length === 0) return;
        setBatchBusy(true);
        setBatchSummary(null);
        try {
            const { results } = await runTasksBatchAction(
                runAllTargets.map((task) => ({ taskId: task.id })),
            );
            const started = results.filter((row) => row.ok).length;
            setBatchSummary(`${started}/${results.length} started`);
        } finally {
            setBatchBusy(false);
        }
    };

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
                {runAllEligible && runAllTargets.length > 0 && (
                    <button
                        type="button"
                        disabled={batchBusy}
                        onClick={() => void handleRunAll()}
                        data-testid="task-run-all-button"
                        title={`Run ${runAllTargets.length} Task(s) in ${col.label}`}
                        className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-primary disabled:opacity-50"
                    >
                        {batchBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                            <Play className="w-3 h-3" />
                        )}
                        Run all
                    </button>
                )}
                <span
                    className={cn(
                        'min-w-5 text-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                        col.countClass,
                    )}
                >
                    {tasks.length}
                </span>
            </div>

            {batchSummary && (
                <p
                    className="px-3 py-1 text-[10px] text-text-muted border-x border-slate-200/60 dark:border-white/8"
                    role="status"
                >
                    {batchSummary}
                </p>
            )}

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
                            pickerOpen={pickerTaskId === task.id}
                            onPickerOpenChange={(open) => onPickerTaskChange(open ? task.id : null)}
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
    // Board dispatch (kanban M3) — at most ONE agent picker open at a
    // time, owned here so a drag-into-In-Progress can open the picker on
    // a card the user is not currently focused on.
    const [pickerTaskId, setPickerTaskId] = useState<string | null>(null);

    // `useState(initialTasks)` only seeds on the first render, so any later
    // change to the `tasks` prop (filter swap, parent refetch) would never
    // reach the board. Sync explicitly when the prop reference changes.
    useEffect(() => {
        setTasks(initialTasks);
    }, [initialTasks]);

    // Kanban run cockpit (Wave 2) — while any visible card carries a
    // queued/running run, poll for fresh run telemetry every 10s and merge
    // ONLY the run-related fields by task id (never status/title — those
    // may hold un-flushed optimistic updates from a drag in progress).
    const mergeRunData = useCallback((rows: Task[]) => {
        const freshById = new Map(rows.map((row) => [row.id, row]));
        setTasks((prev) =>
            prev.map((task) => {
                const fresh = freshById.get(task.id);
                if (!fresh) return task;
                return {
                    ...task,
                    run: fresh.run ?? null,
                    latestRunId: fresh.latestRunId ?? task.latestRunId,
                    latestRunStatus: fresh.latestRunStatus ?? task.latestRunStatus,
                };
            }),
        );
    }, []);
    useTaskRunPolling(tasks, mergeRunData);

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
                // Board dispatch (kanban M3) — a drag into In Progress
                // fans out to the Task's AGENT ASSIGNEES. With none, the
                // move used to be a silent no-op: the card changes column
                // and nothing runs. Open the picker instead so the drag
                // still ends in a running agent.
                if (to === 'in_progress') {
                    const candidates = await listTaskRunCandidatesAction(taskId).catch(() => []);
                    if (!candidates.some((agent) => agent.source === 'assignee')) {
                        setPickerTaskId(taskId);
                    }
                }
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
                        pickerTaskId={pickerTaskId}
                        onPickerTaskChange={setPickerTaskId}
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
