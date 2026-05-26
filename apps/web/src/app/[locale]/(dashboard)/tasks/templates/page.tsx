import type { Metadata } from 'next';
import { ListChecks } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { listAstTemplates } from '@/lib/api/agent-templates';
import { AstTemplatesBrowser } from '@/components/templates/AstTemplatesBrowser';

export const metadata: Metadata = {
    title: 'Task templates',
};

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.6 (scaffold).
 *
 * Templates browser for Tasks. Catalog is currently the
 * hand-curated fallback; switches to the unified Workshop
 * Templates catalog (ADR-010) when that surface lands.
 */
export default async function TaskTemplatesPage() {
    const entries = await listAstTemplates('task');
    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-5">
            <Link
                href={ROUTES.DASHBOARD_TASKS}
                className="text-xs text-text-muted hover:text-text"
            >
                ← Tasks
            </Link>
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center">
                    <ListChecks className="w-4 h-4 text-warning" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        Task templates
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                        Pre-built Task shapes — bug triage, weekly review, release checklist —
                        with status / labels / sub-tasks already wired up.
                    </p>
                </div>
            </div>
            <AstTemplatesBrowser entity="task" entries={entries} />
        </div>
    );
}
