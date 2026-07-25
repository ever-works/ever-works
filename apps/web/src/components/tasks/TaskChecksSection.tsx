'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Pencil, ShieldCheck } from 'lucide-react';
import type { TaskAcceptanceCheck, TaskCheckResult } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils/cn';
import type { Task } from '@/lib/api/tasks';
import type { AgentRunSession } from '@/lib/api/agents.shared';
import { updateTaskAction } from '@/app/actions/tasks';
import { GateChip } from './GateChip';
import { ChecksEditor } from './ChecksEditor';

/**
 * Quality gates (Wave 3 M6) — the Task-detail "Checks" section.
 *
 * Shows the latest run's dispatch-frozen check set with per-check
 * verdicts (exit code, duration, collapsible output tail) plus the
 * gate chip and the attempt counter; falls back to the Task's declared
 * `acceptanceChecks` when no run has executed yet. Pre-dispatch the
 * check set is editable in place — saves ride the same task PATCH as
 * the sibling fields (`updateTaskAction`).
 *
 * `logTail` is untrusted subprocess output: rendered strictly as a
 * text node inside a <pre>, never as markup.
 */

const RESULT_TONES: Record<TaskCheckResult['status'], string> = {
    green: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    timeout: 'text-amber-600 dark:text-amber-400',
    error: 'text-amber-600 dark:text-amber-400',
};

/** Failed REQUIRED checks — what the red gate actually counts. */
export function countFailedRequired(
    resolvedChecks: TaskAcceptanceCheck[] | null | undefined,
    checkResults: TaskCheckResult[] | null | undefined,
): number {
    const requiredById = new Map((resolvedChecks ?? []).map((c) => [c.id, c.required !== false]));
    return (checkResults ?? []).filter(
        (r) => r.status !== 'green' && (requiredById.get(r.id) ?? true),
    ).length;
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function CheckRow({
    check,
    result,
}: {
    check: TaskAcceptanceCheck;
    result: TaskCheckResult | null;
}) {
    const t = useTranslations('dashboard.tasksPage.checks');
    const tEditor = useTranslations('dashboard.tasksPage.checksEditor');
    const [logOpen, setLogOpen] = useState(false);
    const hasLog = Boolean(result?.logTail);

    return (
        <li
            className="rounded-md border border-border/40 dark:border-border-dark/40 px-3 py-2"
            data-testid="task-check-row"
        >
            <div className="flex items-center gap-2 min-w-0">
                {hasLog ? (
                    <button
                        type="button"
                        onClick={() => setLogOpen((v) => !v)}
                        aria-expanded={logOpen}
                        className="shrink-0 text-text-muted hover:text-text dark:hover:text-text-dark"
                        data-testid="task-check-log-toggle"
                    >
                        {logOpen ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                        )}
                    </button>
                ) : (
                    <span className="w-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="text-xs font-medium text-text dark:text-text-dark truncate">
                    {check.name || check.id}
                </span>
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted shrink-0">
                    {tEditor(`kinds.${check.kind}`)}
                </span>
                {check.required === false && (
                    <span className="text-[10px] text-text-muted shrink-0">{t('optional')}</span>
                )}
                <span className="flex-1" />
                {result ? (
                    <>
                        <span
                            className={cn(
                                'text-[10px] font-semibold uppercase tracking-wide shrink-0',
                                RESULT_TONES[result.status] ?? 'text-text-muted',
                            )}
                        >
                            {t(`result.${result.status}`)}
                        </span>
                        <span className="text-[10px] font-mono text-text-muted shrink-0">
                            {t('exit', { code: result.exitCode ?? '—' })}
                        </span>
                        <span className="text-[10px] font-mono text-text-muted shrink-0">
                            {formatDuration(result.durationMs)}
                        </span>
                    </>
                ) : (
                    <span className="text-[10px] text-text-muted shrink-0">{t('notRun')}</span>
                )}
            </div>
            {hasLog && logOpen && (
                <pre
                    className="mt-2 max-h-64 overflow-auto rounded bg-surface-secondary dark:bg-black/40 p-2 text-[11px] font-mono leading-snug text-text-secondary dark:text-text-secondary-dark whitespace-pre-wrap break-all"
                    data-testid="task-check-log-tail"
                >
                    {result?.logTail}
                </pre>
            )}
        </li>
    );
}

export function TaskChecksSection({
    task,
    initialGateRun,
}: {
    task: Task;
    /** Latest AgentRun for this Task (gate columns included) — server-fetched. */
    initialGateRun: AgentRunSession | null;
}) {
    const t = useTranslations('dashboard.tasksPage.checks');
    const [editing, setEditing] = useState(false);
    const [declaredChecks, setDeclaredChecks] = useState<TaskAcceptanceCheck[] | null>(
        task.acceptanceChecks ?? null,
    );
    const [maxAttempts, setMaxAttempts] = useState<number | null>(task.maxGateAttempts ?? null);
    const [draftChecks, setDraftChecks] = useState<TaskAcceptanceCheck[]>([]);
    const [draftMaxAttempts, setDraftMaxAttempts] = useState<string>('inherit');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const run = initialGateRun;
    const resultsById = new Map((run?.checkResults ?? []).map((r) => [r.id, r]));
    // Prefer the dispatch-frozen set (what actually ran); fall back to the
    // Task's declared checks for the pre-dispatch view.
    const displayChecks: TaskAcceptanceCheck[] = (
        run?.resolvedChecks?.length ? run.resolvedChecks : (declaredChecks ?? [])
    ).filter((c) => !c.disabled);

    const startEditing = () => {
        setDraftChecks((declaredChecks ?? []).map((c) => ({ ...c })));
        setDraftMaxAttempts(maxAttempts == null ? 'inherit' : String(maxAttempts));
        setError(null);
        setEditing(true);
    };

    const save = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const nextMax =
                        draftMaxAttempts === 'inherit' ? null : parseInt(draftMaxAttempts, 10);
                    const updated = await updateTaskAction(task.id, {
                        acceptanceChecks: draftChecks.length > 0 ? draftChecks : null,
                        maxGateAttempts: nextMax,
                    });
                    setDeclaredChecks(updated.acceptanceChecks ?? null);
                    setMaxAttempts(updated.maxGateAttempts ?? null);
                    setEditing(false);
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('saveError'));
                }
            })();
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-checks-section"
        >
            <div className="flex items-center justify-between mb-3 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <ShieldCheck className="w-4 h-4 text-text-muted shrink-0" />
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    {run?.gateStatus && (
                        <GateChip
                            status={run.gateStatus}
                            failedCount={countFailedRequired(run.resolvedChecks, run.checkResults)}
                        />
                    )}
                    {run && run.gateAttempts > 0 && (
                        <span
                            className="text-[10px] text-text-muted shrink-0"
                            data-testid="task-gate-attempts"
                        >
                            {maxAttempts != null
                                ? t('attemptsOf', { count: run.gateAttempts, max: maxAttempts })
                                : t('attempts', { count: run.gateAttempts })}
                        </span>
                    )}
                </div>
                {!editing && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-xs gap-1.5"
                        onClick={startEditing}
                        data-testid="task-checks-edit"
                    >
                        <Pencil className="w-3.5 h-3.5" />
                        {t('edit')}
                    </Button>
                )}
            </div>

            {editing ? (
                <div className="space-y-3">
                    <ChecksEditor
                        value={draftChecks}
                        onChange={setDraftChecks}
                        disabled={pending}
                        testIdPrefix="task-checks-editor"
                    />
                    <div className="flex items-center justify-between gap-3">
                        <label className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('maxAttempts')}
                            <Select
                                value={draftMaxAttempts}
                                onValueChange={setDraftMaxAttempts}
                                disabled={pending}
                                size="sm"
                                data-testid="task-checks-max-attempts"
                            >
                                <option value="inherit">{t('maxAttemptsInherit')}</option>
                                {[1, 2, 3, 4, 5].map((n) => (
                                    <option key={n} value={String(n)}>
                                        {n}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={pending}
                                onClick={() => setEditing(false)}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                disabled={pending}
                                onClick={save}
                                data-testid="task-checks-save"
                            >
                                {pending ? '…' : t('save')}
                            </Button>
                        </div>
                    </div>
                    {error && (
                        <p className="text-xs text-danger" role="alert">
                            {error}
                        </p>
                    )}
                </div>
            ) : displayChecks.length === 0 ? (
                <p className="text-xs text-text-muted">{t('empty')}</p>
            ) : (
                <ul className="space-y-2">
                    {displayChecks.map((check) => (
                        <CheckRow
                            key={check.id}
                            check={check}
                            result={resultsById.get(check.id) ?? null}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}
