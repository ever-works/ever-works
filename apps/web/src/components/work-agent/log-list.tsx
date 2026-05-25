import type { WorkAgentRunLog } from '@/lib/api/work-agent';

/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx. Renders
 * up to the last 6 log entries; shared by the global Work Agent
 * settings page LiveRun and (Phase 6 PR R) the Mission detail
 * page LiveRun (which lists multiple in-flight runs per Decision
 * A15 — each one shows its own LogList). Byte-identical to the
 * inline definition.
 */
export function LogList({ logs, emptyText }: { logs: WorkAgentRunLog[]; emptyText: string }) {
    if (logs.length === 0) {
        return <p className="text-xs text-text-muted dark:text-text-muted-dark">{emptyText}</p>;
    }

    return (
        <div className="space-y-2">
            {logs.slice(-6).map((log) => (
                <div key={log.id} className="rounded-lg bg-surface dark:bg-surface-dark px-3 py-2">
                    <div className="text-[11px] uppercase text-text-muted dark:text-text-muted-dark">
                        {log.step}
                    </div>
                    <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {log.message}
                    </div>
                </div>
            ))}
        </div>
    );
}
