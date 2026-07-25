'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TerminalPane } from './TerminalPane';

interface RunRow {
    id: string;
    status: string;
    triggerKind: string;
    createdAt: string;
    summary: string | null;
}

/**
 * Terminal tab client (streaming-terminal M7): a recent-run picker +
 * the live pane for the selected run. Runs are the session identity —
 * the run id IS the relay channel id, so picking a run attaches to
 * exactly that session (live) or its pinned exit state (dead).
 */
export function AgentTerminalClient({
    agentId,
    runs,
    initialRunId,
}: {
    agentId: string;
    runs: RunRow[];
    initialRunId: string | null;
}) {
    const t = useTranslations('dashboard.terminal');
    const defaultRun = useMemo(() => {
        if (initialRunId && runs.some((r) => r.id === initialRunId)) return initialRunId;
        return runs[0]?.id ?? null;
    }, [initialRunId, runs]);
    const [selected, setSelected] = useState<string | null>(defaultRun);

    if (runs.length === 0) {
        return (
            <div className="p-8 text-center text-sm text-text-muted dark:text-text-muted-dark">
                {t('noRuns')}
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-0 p-4 gap-3">
            <div className="flex items-center gap-2">
                <label
                    htmlFor="terminal-run-picker"
                    className="text-xs text-text-secondary dark:text-text-secondary-dark"
                >
                    {t('runPickerLabel')}
                </label>
                <select
                    id="terminal-run-picker"
                    data-testid="terminal-run-picker"
                    value={selected ?? ''}
                    onChange={(e) => setSelected(e.target.value || null)}
                    className="rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs text-text dark:text-text-dark max-w-md"
                >
                    {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                            {new Date(run.createdAt).toLocaleString()} · {run.triggerKind} ·{' '}
                            {run.status}
                        </option>
                    ))}
                </select>
            </div>
            {selected && (
                <div className="flex-1 min-h-0">
                    <TerminalPane key={selected} agentId={agentId} runId={selected} />
                </div>
            )}
        </div>
    );
}
