/**
 * Agents/Skills/Tasks PR #1017 — Phase 5 placeholder. Budgets tab
 * lists this Agent's per-interval `AgentBudget` rows (hour / day
 * / week / month / unlimited per N6 override). Wires up once the
 * multi-interval BudgetService aggregator ships in Phase 7.6.
 */
export default function AgentBudgetsPage() {
    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-2">Budgets</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    Per-Agent budget rollup ships with the AgentRunService in a later phase.
                </p>
            </section>
        </div>
    );
}
