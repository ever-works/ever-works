'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, CheckCircle2, Circle, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { Task, TaskStatus, TaskSubtaskRow, TaskSubtasksMeta } from '@/lib/api/tasks';
import type { AgentPickerOption } from '@/lib/api/agents.shared';
import { listAgentOptionsAction } from '@/app/actions/agents';
import { createTaskAction } from '@/app/actions/tasks';

/**
 * Tasks upgrades — the Task-detail Subtasks checklist.
 *
 * Rows come from `GET /api/tasks/:id/subtasks`, which batches the two
 * side tables the checklist needs (agent assignees + approvers), so
 * this section never fans out one request per row. Adding a sub-task
 * reuses the ordinary create path with `parentTaskId` set and inherits
 * the parent's owner tuple — the API rejects a child whose scope
 * disagrees with its parent, so inheriting is the only shape that can
 * actually be written.
 */

const STATUS_TONES: Record<TaskStatus, string> = {
    backlog: 'text-text-muted',
    todo: 'text-info',
    in_progress: 'text-warning',
    in_review: 'text-violet-500',
    blocked: 'text-danger',
    done: 'text-success',
    cancelled: 'text-text-muted',
};

export function TaskSubtasksSection({
    task,
    initial = [],
    initialMeta = { total: 0, doneCount: 0 },
    initialError = null,
}: {
    task: Task;
    initial?: TaskSubtaskRow[];
    initialMeta?: TaskSubtasksMeta;
    initialError?: string | null;
}) {
    const t = useTranslations('dashboard.tasksPage.subtasks');
    const tStatus = useTranslations('dashboard.tasksPage.status');
    const router = useRouter();
    const [title, setTitle] = useState('');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [agents, setAgents] = useState<AgentPickerOption[]>([]);

    // Resolve agent chips to names. Only fetched when at least one row
    // actually carries an agent — an all-human checklist stays free.
    const hasAgentChips = initial.some((row) => row.agentAssigneeIds.length > 0);
    useEffect(() => {
        if (!hasAgentChips) return;
        let cancelled = false;
        void (async () => {
            try {
                const options = await listAgentOptionsAction();
                if (!cancelled) setAgents(options);
            } catch {
                // Best-effort: without names the chip falls back to the id.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [hasAgentChips]);

    const agentNameById = useMemo(
        () => new Map(agents.map((agent) => [agent.id, agent.name])),
        [agents],
    );

    const handleAdd = (e: React.FormEvent) => {
        e.preventDefault();
        const value = title.trim();
        if (!value) return;
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await createTaskAction({
                        title: value,
                        parentTaskId: task.id,
                        // A sub-task must agree with its parent on EVERY
                        // owner (API rule — `assertParentScopeMatches`
                        // compares the whole tuple, not just the three
                        // scope owners), so all six ride along. Dropping
                        // `agentId` here made "Add" fail with a
                        // scope-mismatch 400 on any Task that had an Agent
                        // picked on this same page.
                        workId: task.workId,
                        missionId: task.missionId,
                        ideaId: task.ideaId,
                        teamId: task.teamId ?? null,
                        agentId: task.agentId ?? null,
                        goalId: task.goalId ?? null,
                        priority: task.priority,
                    });
                    setTitle('');
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('addError'));
                }
            })();
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-subtasks-section"
        >
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('section')}
                </h2>
                <span
                    className="text-xs font-mono text-text-muted dark:text-text-muted-dark"
                    data-testid="task-subtasks-progress"
                >
                    {initialMeta.doneCount}/{initialMeta.total}
                </span>
            </div>

            {initialError && (
                <p className="text-xs text-danger mb-3" role="alert">
                    {initialError}
                </p>
            )}

            {initial.length === 0 ? (
                <p className="text-xs text-text-muted">{t('empty')}</p>
            ) : (
                <ul className="space-y-1.5" data-testid="task-subtasks-list">
                    {initial.map((row) => {
                        const isDone = row.status === 'done';
                        const StatusIcon = isDone ? CheckCircle2 : Circle;
                        return (
                            <li
                                key={row.id}
                                className="flex items-center gap-2 rounded-md border border-border/40 dark:border-border-dark/40 px-2.5 py-1.5"
                            >
                                <StatusIcon
                                    className={cn('w-3.5 h-3.5 shrink-0', STATUS_TONES[row.status])}
                                    aria-hidden
                                />
                                <Link
                                    href={ROUTES.DASHBOARD_TASK(row.id)}
                                    className={cn(
                                        'min-w-0 flex-1 truncate text-xs text-text dark:text-text-dark hover:underline',
                                        isDone && 'line-through text-text-muted',
                                    )}
                                >
                                    {row.title}
                                </Link>
                                {row.agentAssigneeIds.map((agentId) => (
                                    <span
                                        key={agentId}
                                        className="inline-flex items-center gap-1 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                                        data-testid="task-subtask-agent-chip"
                                    >
                                        <Bot className="w-3 h-3" aria-hidden />
                                        {agentNameById.get(agentId) ?? `${agentId.slice(0, 8)}…`}
                                    </span>
                                ))}
                                {row.requiresApproval && (
                                    <span
                                        className={cn(
                                            'inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                                            row.approvalCleared
                                                ? 'bg-success/10 text-success'
                                                : 'bg-warning/10 text-warning',
                                        )}
                                        title={t('approvalCount', {
                                            approved: row.approvedCount,
                                            total: row.approverCount,
                                        })}
                                        data-testid="task-subtask-approval-badge"
                                    >
                                        {row.approvalCleared ? (
                                            <ShieldCheck className="w-3 h-3" aria-hidden />
                                        ) : (
                                            <ShieldAlert className="w-3 h-3" aria-hidden />
                                        )}
                                        {row.approvalCleared
                                            ? t('approvalCleared')
                                            : t('approvalPending')}
                                    </span>
                                )}
                                <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                                    {tStatus(row.status)}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}

            <form onSubmit={handleAdd} className="mt-4 flex items-center gap-2">
                <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    placeholder={t('addPlaceholder')}
                    disabled={pending}
                    data-testid="task-subtask-input"
                    className="flex-1 rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-8 text-xs text-text dark:text-text-dark"
                />
                <Button type="submit" size="sm" disabled={pending || !title.trim()}>
                    {pending ? '…' : t('add')}
                </Button>
            </form>
            {error && (
                <p className="text-xs text-danger mt-2" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
