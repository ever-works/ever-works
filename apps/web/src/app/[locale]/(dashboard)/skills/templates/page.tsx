import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { listAstTemplates } from '@/lib/api/agent-templates';
import { AstTemplatesBrowser } from '@/components/templates/AstTemplatesBrowser';

export const metadata: Metadata = {
    title: 'Skill templates',
};

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.6 (scaffold).
 *
 * Templates browser for Skills. Catalog is currently the
 * hand-curated fallback; switches to the unified Workshop
 * Templates catalog (ADR-010) when that surface lands.
 */
export default async function SkillTemplatesPage() {
    const entries = await listAstTemplates('skill');
    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-5">
            <Link
                href={ROUTES.DASHBOARD_SKILLS}
                className="text-xs text-text-muted hover:text-text"
            >
                ← Skills
            </Link>
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-success/10 border border-success/20 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-success" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        Skill templates
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                        Reusable Skill bodies — conventions, references, style guides — your Agents
                        can pull in via bindings.
                    </p>
                </div>
            </div>
            <AstTemplatesBrowser entity="skill" entries={entries} />
        </div>
    );
}
