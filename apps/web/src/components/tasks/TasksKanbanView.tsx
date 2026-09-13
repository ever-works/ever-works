'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { compareTaskBoardCards, TASK_BOARD_TRANSITIONS } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskStatus, TaskPriority } from '@/lib/api/tasks';
import {
    listTaskRunCandidatesAction,
    runTasksBatchAction,
    transitionTaskBoardAction,
} from '@/app/actions/tasks';
import { useTaskRunPolling } from '@/lib/hooks/use-task-run-polling';
import { TaskBranchChip } from './TaskBranchChip';
import { TaskRunChip } from './TaskRunChip';
import { GateChip } from './GateChip';
import { TaskPrPill } from './TaskPrPill';
import { TaskDiffSheet } from './TaskDiffSheet';
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
    AlertTriangle,
    ListChecks,
    Plus,
    RotateCw,
    type LucideIcon,
} from 'lucide-react';

/**
 * Cards revealed per "show more" when the board is handed a plain list with
 * no column read behind it (the scoped Mission / Work / Idea Task lists). The
 * `/tasks` board pages each column on the server instead.
 */
const MAX_VISIBLE = 15;

/**
 * Board dispatch (kanban M4) — hard cap on the column "Run all" action,
 * mirroring the API's `RUN_BATCH_MAX_TASKS`. The button labels itself
 * with the real count so a 40-card column never silently runs 20.
 */
const RUN_ALL_MAX = 20;

// ─── Column definitions ────────────────────────────────────────────────────

/**
 * How a column LOOKS. Its name is not here: every column is named from the
 * already-translated `dashboard.tasksPage.status.*` catalogue.
 */
interface ColumnDef {
    key: TaskStatus;
    icon: LucideIcon;
    spinning?: boolean;
    dotClass: string;
    headerClass: string;
    countClass: string;
    cardBorderClass: string;
    iconBgClass: string;
    iconColorClass: string;
    /** `dashboard.tasksPage.board.*` leaf for the column's empty copy. */
    emptyKey:
        | 'emptyBacklog'
        | 'emptyTodo'
        | 'emptyInProgress'
        | 'emptyInReview'
        | 'emptyBlocked'
        | 'emptyDone'
        | 'emptyCancelled';
}

const COLUMNS: ColumnDef[] = [
    {
        key: 'backlog',
        icon: Inbox,
        dotClass: 'bg-slate-400',
        headerClass: 'bg-slate-50 dark:bg-slate-950/20 border-slate-200 dark:border-slate-700/40',
        countClass: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
        cardBorderClass:
            'border-slate-200/60 dark:border-slate-700/30 hover:border-slate-300 dark:hover:border-slate-600/50',
        iconBgClass: 'bg-slate-50 dark:bg-slate-800/20',
        iconColorClass: 'text-slate-500 dark:text-slate-400',
        emptyKey: 'emptyBacklog',
    },
    {
        key: 'todo',
        icon: Circle,
        dotClass: 'bg-info',
        headerClass: 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800/40',
        countClass: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
        cardBorderClass:
            'border-blue-200/60 dark:border-blue-800/30 hover:border-blue-300 dark:hover:border-blue-700/50',
        iconBgClass: 'bg-blue-50 dark:bg-blue-900/20',
        iconColorClass: 'text-info dark:text-blue-400',
        emptyKey: 'emptyTodo',
    },
    {
        key: 'in_progress',
        icon: Loader2,
        spinning: true,
        dotClass: 'bg-warning animate-pulse',
        headerClass: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/40',
        countClass: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
        cardBorderClass:
            'border-amber-200/60 dark:border-amber-800/30 hover:border-amber-300 dark:hover:border-amber-700/50',
        iconBgClass: 'bg-amber-50 dark:bg-amber-900/20',
        iconColorClass: 'text-warning dark:text-amber-400',
        emptyKey: 'emptyInProgress',
    },
    {
        key: 'in_review',
        icon: Eye,
        dotClass: 'bg-violet-500',
        headerClass:
            'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800/40',
        countClass: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300',
        cardBorderClass:
            'border-violet-200/60 dark:border-violet-800/30 hover:border-violet-300 dark:hover:border-violet-700/50',
        iconBgClass: 'bg-violet-50 dark:bg-violet-900/20',
        iconColorClass: 'text-violet-600 dark:text-violet-400',
        emptyKey: 'emptyInReview',
    },
    {
        key: 'blocked',
        icon: Ban,
        dotClass: 'bg-danger',
        headerClass: 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800/40',
        countClass: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
        cardBorderClass:
            'border-red-200/60 dark:border-red-800/30 hover:border-red-300 dark:hover:border-red-700/50',
        iconBgClass: 'bg-red-50 dark:bg-red-900/20',
        iconColorClass: 'text-danger dark:text-red-400',
        emptyKey: 'emptyBlocked',
    },
    {
        key: 'done',
        icon: CheckCircle2,
        dotClass: 'bg-success',
        headerClass:
            'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/40',
        countClass: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
        cardBorderClass:
            'border-emerald-200/60 dark:border-emerald-800/30 hover:border-emerald-300 dark:hover:border-emerald-700/50',
        iconBgClass: 'bg-emerald-50 dark:bg-emerald-900/20',
        iconColorClass: 'text-success dark:text-emerald-400',
        emptyKey: 'emptyDone',
    },
    {
        key: 'cancelled',
        icon: XCircle,
        dotClass: 'bg-text-muted',
        headerClass: 'bg-slate-50 dark:bg-slate-950/20 border-slate-200 dark:border-slate-700/40',
        countClass: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
        cardBorderClass:
            'border-slate-200/60 dark:border-slate-700/30 hover:border-slate-300 dark:hover:border-slate-600/50',
        iconBgClass: 'bg-slate-50 dark:bg-slate-800/20',
        iconColorClass: 'text-text-muted dark:text-slate-500',
        emptyKey: 'emptyCancelled',
    },
];

// Mirror of TaskTransitionService.canTransition() lattice (client-side
// for the move-menu affordance). Server still authoritative. The table
// itself is the shared `@ever-works/contracts` one, which an agent-package
// spec pins to the real lattice so the two cannot drift.
const NEXT_STATUS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = TASK_BOARD_TRANSITIONS;

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
    const t = useTranslations('dashboard.tasksPage');
    const [menuOpen, setMenuOpen] = useState(false);
    const [pending, startTransition] = useTransition();
    const [dragging, setDragging] = useState(false);
    // Kanban M6 — diff sheet, one per card, opened from the ± affordance.
    const [diffOpen, setDiffOpen] = useState(false);
    const targets = NEXT_STATUS[task.status] ?? [];
    const runButtonRef = useRef<HTMLDivElement | null>(null);
    const changedFiles = task.run?.changedFilesCount ?? null;

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
            data-task-id={task.id}
            onKeyDown={(e) => {
                // `r` runs the focused card. Ignore it while a modifier
                // is held (browser shortcuts) or while focus sits in a
                // text field, and ignore repeats from a held key.
                if (e.key !== 'r' && e.key !== 'R') return;
                if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
                // The diff sheet is a modal over this card — while it is
                // open the board's shortcuts belong to the sheet.
                if (diffOpen) return;
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
                    title={t('board.priorityTooltip', { label: t(`priority.${task.priority}`) })}
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
                gate verdict · kanban M5 — PR review pill with the CI dot,
                the one chip that answers "is this reviewable right now?".
                */}
            {(task.branchRef || task.run || task.prNumber != null) && (
                <div className="flex flex-wrap gap-1">
                    {task.branchRef && <TaskBranchChip task={task} />}
                    {task.prNumber != null && <TaskPrPill task={task} />}
                    {task.run && <TaskRunChip task={task} />}
                    {task.run?.gateStatus && <GateChip status={task.run.gateStatus} />}
                </div>
            )}

            {/* Kanban M6 — diff affordance. Rendered off the run's
                `changedFilesCount` telemetry, or whenever the Task has a
                branch/PR at all (a re-run may have reset the counter but
                the change is still on the branch). */}
            {(changedFiles != null || task.branchRef || task.prNumber != null) && (
                <button
                    type="button"
                    onClick={() => setDiffOpen(true)}
                    data-testid="task-diff-button"
                    title={t('board.diffTooltip')}
                    className="self-start text-[10px] font-mono text-text-muted hover:text-primary underline decoration-dotted"
                >
                    {changedFiles != null
                        ? t('board.diffFiles', { count: changedFiles })
                        : t('board.diffUnknown')}
                </button>
            )}
            <TaskDiffSheet taskId={task.id} open={diffOpen} onClose={() => setDiffOpen(false)} />

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
                            {t('board.moveTo')}
                        </button>
                        {menuOpen && (
                            <ul className="absolute bottom-full left-0 mb-1 flex flex-col gap-0.5 z-10 bg-card dark:bg-card-primary-dark border border-border/60 dark:border-border-dark/60 rounded-md p-1 shadow-sm min-w-[110px]">
                                {targets.map((to) => (
                                    <li key={to}>
                                        <button
                                            type="button"
                                            disabled={pending}
                                            data-status={to}
                                            onClick={() => {
                                                startTransition(() => onMove(to));
                                                setMenuOpen(false);
                                            }}
                                            className="w-full text-left text-[10px] px-2 py-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary disabled:opacity-50"
                                        >
                                            {t(`status.${to}`)}
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
    total,
    failed = false,
    terminalWindowDays,
    pageSize = 50,
    onLoadMore,
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
    /**
     * The number in the header. With a column read behind the board it is
     * the column's TRUE total under the active filters; handed a plain list
     * it is the number of cards the column holds, as it always was.
     */
    total: number;
    /** This column's read failed; the rest of the board still rendered. */
    failed?: boolean;
    /** Bound on done / cancelled, stated in those columns' header and empty copy. */
    terminalWindowDays?: number | null;
    /** Cards one server page returns — what "show N more" can promise. */
    pageSize?: number;
    /**
     * Fetch the next page of THIS column. Resolves `false` when the read
     * failed. Omitted = no column read; "show more" reveals locally.
     */
    onLoadMore?: (offset: number) => Promise<boolean>;
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
    const t = useTranslations('dashboard.tasksPage');
    const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);
    const [batchBusy, setBatchBusy] = useState(false);
    const [batchSummary, setBatchSummary] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreFailed, setLoadMoreFailed] = useState(false);
    const Icon = col.icon;
    const label = t(`status.${col.key}`);
    const isTerminal = col.key === 'done' || col.key === 'cancelled';
    const windowDays = isTerminal && terminalWindowDays ? terminalWindowDays : null;

    const serverPaged = Boolean(onLoadMore);
    const visibleTasks = serverPaged ? tasks : tasks.slice(0, visibleCount);
    const remaining = serverPaged
        ? Math.max(0, total - tasks.length)
        : Math.max(0, tasks.length - visibleCount);
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
            setBatchSummary(t('board.runAllSummary', { started, total: results.length }));
        } finally {
            setBatchBusy(false);
        }
    };

    const handleShowMore = async () => {
        if (!onLoadMore) {
            setVisibleCount((v) => v + MAX_VISIBLE);
            return;
        }
        setLoadingMore(true);
        setLoadMoreFailed(false);
        try {
            const ok = await onLoadMore(tasks.length);
            if (!ok) setLoadMoreFailed(true);
        } finally {
            setLoadingMore(false);
        }
    };

    const nextStep = Math.min(remaining, serverPaged ? pageSize : MAX_VISIBLE);
    // A windowed done / cancelled column says which window it is empty for;
    // an unwindowed one (a plain list handed to the board) must not claim one.
    const emptyCopy =
        isTerminal && !windowDays
            ? t(col.key === 'done' ? 'board.emptyDoneAll' : 'board.emptyCancelledAll')
            : t(`board.${col.emptyKey}`, { days: windowDays ?? 0 });

    return (
        <div
            role="region"
            aria-label={t('board.columnLabel', { column: label, count: total })}
            data-testid="task-board-column"
            data-status={col.key}
            className="flex flex-col min-w-[220px] w-full flex-1"
        >
            {/* Column header */}
            <div
                title={t('board.sortTooltip')}
                className={cn(
                    'flex items-center gap-2 px-3 py-2.5 rounded-t-lg border border-b-0',
                    col.headerClass,
                )}
            >
                <span className={cn('w-2 h-2 rounded-full shrink-0', col.dotClass)} />
                <Icon className={cn('w-3.5 h-3.5 shrink-0', col.iconColorClass)} />
                <span className="text-xs font-semibold text-text dark:text-text-dark flex-1 truncate">
                    {label}
                </span>
                {runAllEligible && runAllTargets.length > 0 && (
                    <button
                        type="button"
                        disabled={batchBusy}
                        onClick={() => void handleRunAll()}
                        data-testid="task-run-all-button"
                        title={t('board.runAllTitle', {
                            count: runAllTargets.length,
                            column: label,
                        })}
                        className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-primary disabled:opacity-50"
                    >
                        {batchBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                            <Play className="w-3 h-3" />
                        )}
                        {t('board.runAll')}
                    </button>
                )}
                <span
                    data-testid="task-board-column-count"
                    aria-live="polite"
                    className={cn(
                        'min-w-5 text-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                        col.countClass,
                    )}
                >
                    {total}
                </span>
            </div>

            {windowDays && (
                <p className="px-3 py-1 text-[10px] text-text-muted border-x border-slate-200/60 dark:border-white/8">
                    {t('board.terminalWindow', { days: windowDays })}
                </p>
            )}

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
                data-testid="task-board-column-cards"
                className={cn(
                    'flex flex-col gap-2 p-2 overflow-y-auto border border-t-0',
                    'border-slate-200/60 dark:border-white/8',
                    'bg-slate-50/50 dark:bg-white/1.5',
                    'min-h-[120px] h-[600px]',
                    !hasMore && 'rounded-b-lg',
                    isDropActive && 'ring-2 ring-inset ring-primary/40',
                )}
            >
                {failed ? (
                    <div
                        role="alert"
                        data-testid="task-board-column-error"
                        className="flex-1 flex flex-col items-center justify-center gap-1 py-6 text-center"
                    >
                        <AlertTriangle className="w-4 h-4 text-warning" />
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            {t('board.columnErrorTitle')}
                        </p>
                    </div>
                ) : tasks.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-6">
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark text-center italic">
                            {emptyCopy}
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
            {hasMore && !failed && (
                <div
                    className={cn(
                        'flex flex-col items-center gap-1 w-full px-3 py-2 rounded-b-lg border border-t-0',
                        'border-slate-200/60 dark:border-white/8',
                        'bg-slate-50 dark:bg-white/2',
                    )}
                >
                    {serverPaged && (
                        <span
                            data-testid="task-board-column-showing"
                            className="text-[10px] text-text-muted dark:text-text-muted-dark"
                        >
                            {t('board.showingOf', { shown: tasks.length, total })}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => void handleShowMore()}
                        disabled={loadingMore}
                        data-testid="task-board-show-more"
                        className={cn(
                            'flex items-center justify-center gap-1.5 w-full',
                            'text-[11px] font-medium text-text-muted dark:text-text-muted-dark',
                            'hover:text-text-secondary dark:hover:text-text-secondary-dark',
                            'transition-colors disabled:opacity-50',
                        )}
                    >
                        {loadingMore ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                            <ChevronDown className="w-3 h-3" />
                        )}
                        {t('board.showMore', { count: nextStep })}
                    </button>
                    {loadMoreFailed && (
                        <p role="alert" className="text-[10px] text-danger">
                            {t('board.loadMoreFailed')}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Main export ───────────────────────────────────────────────────────────

/** Per-status header totals the server computed under the active filters. */
export type TasksKanbanTotals = Partial<Record<TaskStatus, number>>;

export interface TasksKanbanViewProps {
    /** Every card the board currently holds, across all columns. */
    tasks: Task[];
    /**
     * TRUE per-column totals from the board read (`GET /api/tasks/board`).
     * Omitted = the board was handed a plain list, and each header counts
     * the cards it holds, as it always has.
     */
    totals?: TasksKanbanTotals;
    /** Columns whose server read failed; each shows its own error panel. */
    failedStatuses?: TaskStatus[];
    /** The done / cancelled window the server applied, stated on those columns. */
    terminalWindowDays?: number | null;
    /** Cards one server column page holds. */
    pageSize?: number;
    /**
     * Fetch the next page of one column. Resolves `null` when the read
     * failed. Omitted = no column read; "show more" reveals locally.
     */
    loadColumn?: (
        status: TaskStatus,
        offset: number,
    ) => Promise<{ total: number; cards: Task[] } | null>;
}

/**
 * The Task board — one column per status you can drag between.
 *
 * Every existing caller passes only `tasks` and gets the board it always
 * had. The `/tasks` page also passes the server's per-column read, and the
 * board then shows each column's TRUE total (kept honest across optimistic
 * moves and replaced by the server's own number whenever a column page
 * arrives) and pages each column on its own. Either way, cards inside a
 * column are ordered the way the board read orders them — stalled first,
 * then Urgent → Low, then the oldest update first — a refused move shows
 * the server's reason, and a drag out of Cancelled explains why it cannot
 * land.
 */
export function TasksKanbanView({
    tasks: initialTasks,
    totals: initialTotals,
    failedStatuses,
    terminalWindowDays,
    pageSize,
    loadColumn,
}: TasksKanbanViewProps) {
    const t = useTranslations('dashboard.tasksPage');
    const [tasks, setTasks] = useState(initialTasks);
    const [totals, setTotals] = useState<TasksKanbanTotals | undefined>(initialTotals);
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
    const [dropTargetStatus, setDropTargetStatus] = useState<TaskStatus | null>(null);
    // Board dispatch (kanban M3) — at most ONE agent picker open at a
    // time, owned here so a drag-into-In-Progress can open the picker on
    // a card the user is not currently focused on.
    const [pickerTaskId, setPickerTaskId] = useState<string | null>(null);
    // One explanation per drag, not one per `dragover` event.
    const refusalExplainedRef = useRef(false);
    // The instant the stall rule is measured from, fixed per mount so the
    // order does not reshuffle between renders.
    const [orderedAt] = useState(() => new Date());

    // `useState(initialTasks)` only seeds on the first render, so any later
    // change to the `tasks` prop (filter swap, parent refetch) would never
    // reach the board. Sync explicitly when the prop reference changes.
    useEffect(() => {
        setTasks(initialTasks);
    }, [initialTasks]);
    useEffect(() => {
        setTotals(initialTotals);
    }, [initialTotals]);

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
                    // Kanban M5 — the CI dot rides the same poll. The
                    // `task-pr-status-sync` cron owns the refresh; the
                    // board just re-reads the cached verdict, so a check
                    // going red reaches the card without its own request.
                    prState: fresh.prState ?? task.prState,
                    ciState: fresh.ciState ?? task.ciState,
                    ciCheckedAt: fresh.ciCheckedAt ?? task.ciCheckedAt,
                    prChecks: fresh.prChecks ?? task.prChecks,
                    prNumber: fresh.prNumber ?? task.prNumber,
                    prUrl: fresh.prUrl ?? task.prUrl,
                };
            }),
        );
    }, []);
    useTaskRunPolling(tasks, mergeRunData);

    const grouped = useMemo(() => {
        const map = new Map<TaskStatus, Task[]>(COLUMNS.map((c) => [c.key, []]));
        for (const t of tasks) map.get(t.status)?.push(t);
        // Priority orders the board: the same comparator the board read's
        // SQL mirrors, so a moved or paged-in card lands where the server
        // would have put it, and a plain list is ordered the same way.
        for (const column of map.values()) {
            column.sort((a, b) => compareTaskBoardCards(a, b, orderedAt));
        }
        return map;
    }, [tasks, orderedAt]);

    /** Keep a server total honest across an optimistic move (and its rollback). */
    const shiftTotals = (from: TaskStatus, to: TaskStatus) => {
        setTotals((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                [from]: Math.max(0, (prev[from] ?? 0) - 1),
                [to]: (prev[to] ?? 0) + 1,
            };
        });
    };

    const handleMove = (taskId: string, to: TaskStatus) => {
        const before = tasks.find((t) => t.id === taskId);
        if (!before) return;
        const from = before.status;
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: to } : t)));
        shiftTotals(from, to);
        setErrors((e) => ({ ...e, [taskId]: null }));
        void (async () => {
            const result = await transitionTaskBoardAction(taskId, to).catch(() => null);
            if (!result || !result.ok) {
                setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: from } : t)));
                shiftTotals(to, from);
                setErrors((e) => ({
                    ...e,
                    // The server's own reason when it gave one (an open
                    // blocker, an unmet approval) — never a generic "failed".
                    [taskId]: result?.message || t('board.transitionFailed'),
                }));
                return;
            }
            setTasks((prev) =>
                prev.map((t) => (t.id === taskId ? { ...t, status: result.task.status } : t)),
            );
            // Board dispatch (kanban M3) — a drag into In Progress
            // fans out to the Task's AGENT ASSIGNEES. With none, the
            // move used to be a silent no-op: the card changes column
            // and nothing runs. Open the picker instead so the drag
            // still ends in a running agent.
            if (to === 'in_progress') {
                const candidates = await listTaskRunCandidatesAction(taskId).catch(() => []);
                // 'assignee' = a task_assignees row; 'task' = the Task's own
                // agentId column, which is what the detail page's Agent
                // picker writes. Both dispatch server-side (the transition
                // falls back to task.agentId when there are no assignee
                // rows), so both mean "this Task already has its agent" —
                // checking only 'assignee' opened the picker on top of every
                // detail-page-assigned Task, asking the user to re-choose an
                // agent they had already chosen.
                const hasAgent = candidates.some(
                    (agent) => agent.source === 'assignee' || agent.source === 'task',
                );
                if (!hasAgent) {
                    setPickerTaskId(taskId);
                }
            }
        })();
    };

    const handleDragOver = (e: React.DragEvent, status: TaskStatus) => {
        if (!draggingTaskId) return;
        const src = tasks.find((t) => t.id === draggingTaskId);
        if (!src || src.status === status) return;
        if (!(NEXT_STATUS[src.status] ?? []).includes(status)) {
            // A cancelled Task has no legal move at all. The drop is refused
            // either way; say why once, instead of letting it silently fail.
            if (src.status === 'cancelled' && !refusalExplainedRef.current) {
                refusalExplainedRef.current = true;
                toast.error(t('board.dropRefusedCancelled'));
            }
            return;
        }
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

    const handleLoadMore = loadColumn
        ? async (status: TaskStatus, offset: number): Promise<boolean> => {
              const page = await loadColumn(status, offset).catch(() => null);
              if (!page) return false;
              setTasks((prev) => {
                  const known = new Set(prev.map((task) => task.id));
                  return [...prev, ...page.cards.filter((card) => !known.has(card.id))];
              });
              setTotals((prev) => ({ ...(prev ?? {}), [status]: page.total }));
              return true;
          }
        : undefined;

    return (
        <div className="w-full overflow-x-auto pb-2" data-testid="task-board">
            <div className="flex gap-3 min-w-[900px]">
                {COLUMNS.map((col) => {
                    const columnTasks = grouped.get(col.key)!;
                    return (
                        <TaskKanbanColumn
                            key={col.key}
                            col={col}
                            tasks={columnTasks}
                            total={totals ? (totals[col.key] ?? 0) : columnTasks.length}
                            failed={failedStatuses?.includes(col.key) ?? false}
                            terminalWindowDays={terminalWindowDays}
                            pageSize={pageSize}
                            onLoadMore={
                                handleLoadMore
                                    ? (offset) => handleLoadMore(col.key, offset)
                                    : undefined
                            }
                            errors={errors}
                            draggingTaskId={draggingTaskId}
                            dropTargetStatus={dropTargetStatus}
                            pickerTaskId={pickerTaskId}
                            onPickerTaskChange={setPickerTaskId}
                            onMove={handleMove}
                            onDragStart={(taskId) => {
                                refusalExplainedRef.current = false;
                                setDraggingTaskId(taskId);
                            }}
                            onDragEnd={() => {
                                setDraggingTaskId(null);
                                setDropTargetStatus(null);
                            }}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop}
                        />
                    );
                })}
            </div>
        </div>
    );
}

// ─── Board states (the `/tasks` board read) ───────────────────────────────

/**
 * The board read failed as a whole. Rendered inside the board area, under
 * the still-usable tab strip, filters and view switcher — never a blank
 * page and never an empty board presented as "no Tasks".
 */
export function TasksKanbanErrorPanel({ tableHref }: { tableHref: string }) {
    const t = useTranslations('dashboard.tasksPage.board');
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    return (
        <div
            role="alert"
            data-testid="task-board-error"
            className="rounded-xl border border-warning/40 bg-warning/5 p-5 flex items-start gap-3"
        >
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('errorTitle')}
                </p>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('errorBody')}
                </p>
                <div className="flex flex-wrap items-center gap-3 pt-2">
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => startTransition(() => router.refresh())}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border dark:border-border-dark px-3 py-1.5 text-xs font-medium text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark disabled:opacity-50"
                    >
                        {pending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <RotateCw className="w-3.5 h-3.5" />
                        )}
                        {t('errorRetry')}
                    </button>
                    <Link href={tableHref} className="text-xs text-primary hover:underline">
                        {t('errorOpenTable')}
                    </Link>
                </div>
            </div>
        </div>
    );
}

/**
 * First-run notice: the user has no Tasks at all (and no filter is hiding
 * any). Shown ABOVE the column frames rather than instead of them, so the
 * board keeps its shape and its drop targets the moment a Task lands.
 */
export function TasksKanbanEmptyNotice() {
    const t = useTranslations('dashboard.tasksPage');

    return (
        <div
            data-testid="task-board-empty"
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-center"
        >
            <ListChecks className="mx-auto w-5 h-5 text-text-muted" />
            <p className="mt-2 text-sm font-semibold text-text dark:text-text-dark">
                {t('board.emptyBoardTitle')}
            </p>
            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark max-w-md mx-auto">
                {t('board.emptyBoardBody')}
            </p>
            <div className="mt-3 flex items-center justify-center gap-3">
                <Link
                    href={ROUTES.DASHBOARD_TASK_NEW}
                    className="inline-flex items-center gap-1.5 rounded-md bg-button-primary dark:bg-button-primary-dark px-3 py-1.5 text-xs font-medium text-button-primary-foreground dark:text-button-primary-foreground-dark"
                >
                    <Plus className="w-3.5 h-3.5" />
                    {t('list.newTask')}
                </Link>
                <Link
                    href={ROUTES.DASHBOARD_TASK_TEMPLATES}
                    className="text-xs text-primary hover:underline"
                >
                    {t('list.browseTemplates')}
                </Link>
            </div>
        </div>
    );
}

/** Column frames with placeholder cards, while a board read is on its way. */
export function TasksKanbanSkeleton() {
    const t = useTranslations('dashboard.tasksPage');

    return (
        <div
            className="w-full overflow-x-auto pb-2"
            aria-busy="true"
            data-testid="task-board-skeleton"
        >
            <div className="flex gap-3 min-w-[900px]">
                {COLUMNS.map((col, index) => (
                    <div key={col.key} className="flex flex-col min-w-[220px] w-full flex-1">
                        <div
                            className={cn(
                                'flex items-center gap-2 px-3 py-2.5 rounded-t-lg border border-b-0',
                                col.headerClass,
                            )}
                        >
                            <span className={cn('w-2 h-2 rounded-full shrink-0', col.dotClass)} />
                            <span className="text-xs font-semibold text-text dark:text-text-dark flex-1 truncate">
                                {t(`status.${col.key}`)}
                            </span>
                            <span className="h-3 w-5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark animate-pulse" />
                        </div>
                        <div className="flex flex-col gap-2 p-2 border border-t-0 rounded-b-lg border-slate-200/60 dark:border-white/8 min-h-[120px] h-[600px]">
                            {Array.from({ length: index < 3 ? 2 : 1 }).map((_, card) => (
                                <div
                                    key={card}
                                    className="h-16 rounded-lg bg-surface-secondary/60 dark:bg-surface-secondary-dark/40 animate-pulse"
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
