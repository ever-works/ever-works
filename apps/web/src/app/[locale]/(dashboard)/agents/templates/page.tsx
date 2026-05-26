import type { Metadata } from 'next';
import { Bot } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { listAstTemplates } from '@/lib/api/agent-templates';
import { AstTemplatesBrowser } from '@/components/templates/AstTemplatesBrowser';

export const metadata: Metadata = {
    title: 'Agent templates',
};

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.6 (scaffold).
 *
 * Templates browser for Agents. Catalog is currently the
 * hand-curated fallback in `lib/api/agent-templates.ts`; switches
 * to the unified Workshop Templates catalog (ADR-010) when that
 * surface lands on develop.
 */
export default async function AgentTemplatesPage() {
    const entries = await listAstTemplates('agent');
    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-5">
            <Link
                href={ROUTES.DASHBOARD_AGENTS}
                className="text-xs text-text-muted hover:text-text"
            >
                ← Agents
            </Link>
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-info/10 border border-info/20 flex items-center justify-center">
                    <Bot className="w-4 h-4 text-info" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        Agent templates
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                        Pre-built Agent shapes you can spin up in a click. Click &ldquo;Use
                        template&rdquo; to open the New flow with the body pre-filled.
                    </p>
                </div>
            </div>
            <AstTemplatesBrowser entity="agent" entries={entries} />
        </div>
    );
}
