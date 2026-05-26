import { Bot } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.1. Dashboard tile
 * showing the user's Agent count + a tap-to-go-to-/agents shortcut.
 * Counts come from the server via /api/agents?limit=1 (returns
 * `meta.total`). Keeps the tile cheap to render — no full list
 * load.
 */
export function AgentsCountTile({ total, active }: { total: number; active: number }) {
    return (
        <Link
            href={ROUTES.DASHBOARD_AGENTS}
            className="group block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-primary/40 transition-colors"
        >
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Bot className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-xs text-text-secondary dark:text-text-secondary-dark uppercase tracking-wide">
                        Agents
                    </h3>
                    <p className="text-2xl font-semibold text-text dark:text-text-dark mt-1">
                        {total}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {active} active
                    </p>
                </div>
            </div>
        </Link>
    );
}
