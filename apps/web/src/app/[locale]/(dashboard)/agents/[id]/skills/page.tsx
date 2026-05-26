/**
 * Agents/Skills/Tasks PR #1017 — Phase 5 placeholder. The Skills
 * tab lists installed bindings (`SkillBinding`) for this Agent
 * and lets the user attach/detach skills. Wires up once the
 * Skills feature ships in Phase 9.
 */
export default function AgentSkillsPage() {
    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-2">Skills</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    Per-Agent skill bindings ship with the Skills feature in a later phase.
                </p>
            </section>
        </div>
    );
}
