/**
 * Agents/Skills/Tasks PR #1017 — Phase 5 placeholder. The real
 * Activity tab wires the ActivityLog filtered to subjectType=Agent
 * + subjectId=this Agent's id. Lands once the per-Agent activity
 * filter ships alongside the heartbeat dispatcher.
 */
export default function AgentActivityPage() {
    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-2">Activity</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    Per-Agent activity feed is coming in a later phase.
                </p>
            </section>
        </div>
    );
}
