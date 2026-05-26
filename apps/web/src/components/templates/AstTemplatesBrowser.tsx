'use client';

import { useMemo, useState } from 'react';
import { BookOpen, ClipboardList, Code2, FileText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { AstTemplateEntry, AstTemplateEntityType } from '@/lib/api/agent-templates';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.6 (scaffold).
 *
 * Shared templates-browser surface used by `/agents/templates`,
 * `/skills/templates`, and `/tasks/templates`. Three-column card
 * grid + left-side category filter. Clicking a card opens the
 * matching New flow with `?from=<slug>` so the platform's existing
 * Create handler can pre-fill from the template body once ADR-010
 * lands.
 *
 * Current behaviour: the catalog comes from `listAstTemplates(entity)`
 * which returns hand-curated fallback rows. When ADR-010 (the
 * unified Workshop Templates catalog) ships, the same component
 * gets real platform-managed templates with zero code changes.
 */
export function AstTemplatesBrowser({
    entity,
    entries,
}: {
    entity: AstTemplateEntityType;
    entries: AstTemplateEntry[];
}) {
    const [filter, setFilter] = useState<string | null>(null);

    const categories = useMemo(() => {
        const set = new Set<string>();
        for (const e of entries) {
            if (e.category) set.add(e.category);
        }
        return Array.from(set).sort();
    }, [entries]);

    const visible = useMemo(() => {
        if (!filter) return entries;
        return entries.filter((e) => e.category === filter);
    }, [entries, filter]);

    if (entries.length === 0) {
        return (
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                <p>
                    No templates available for {entity}s yet. The unified Workshop Templates catalog
                    (ADR-010) is still on a separate branch — once it merges, this page will
                    populate automatically.
                </p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 @lg/main:grid-cols-[180px_1fr] gap-4">
            <aside className="space-y-1">
                <button
                    type="button"
                    onClick={() => setFilter(null)}
                    className={`block w-full text-left text-xs px-2 py-1.5 rounded ${
                        !filter
                            ? 'bg-primary/10 text-primary'
                            : 'text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark'
                    }`}
                >
                    All ({entries.length})
                </button>
                {categories.map((cat) => {
                    const count = entries.filter((e) => e.category === cat).length;
                    return (
                        <button
                            key={cat}
                            type="button"
                            onClick={() => setFilter(cat)}
                            className={`block w-full text-left text-xs px-2 py-1.5 rounded ${
                                filter === cat
                                    ? 'bg-primary/10 text-primary'
                                    : 'text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark'
                            }`}
                        >
                            {cat} ({count})
                        </button>
                    );
                })}
            </aside>

            <div className="grid grid-cols-1 @md/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                {visible.map((entry) => (
                    <TemplateCard key={entry.slug} entry={entry} entity={entity} />
                ))}
            </div>
        </div>
    );
}

function TemplateCard({
    entry,
    entity,
}: {
    entry: AstTemplateEntry;
    entity: AstTemplateEntityType;
}) {
    // Post-rebase lint fix: `react-hooks/no-component-creation-during-render`
    // doesn't like capturing a component constructor into a local var via
    // a switch and then rendering it as JSX. Render the icon inline via
    // a small switch expression instead.
    const newHref = newRouteFor(entity, entry.slug);
    const iconClass = 'w-4 h-4 text-text-secondary dark:text-text-secondary-dark';
    const iconNode = (() => {
        switch (entry.iconName) {
            case 'ClipboardList':
                return <ClipboardList className={iconClass} />;
            case 'Code2':
                return <Code2 className={iconClass} />;
            case 'BookOpen':
                return <BookOpen className={iconClass} />;
            case 'Sparkles':
                return <Sparkles className={iconClass} />;
            default:
                return <FileText className={iconClass} />;
        }
    })();
    return (
        <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 flex flex-col h-full">
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border/40 flex items-center justify-center">
                    {iconNode}
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                        {entry.title}
                    </h3>
                    {entry.category && (
                        <span className="text-[10px] uppercase tracking-wide text-text-muted">
                            {entry.category}
                        </span>
                    )}
                </div>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2 leading-relaxed flex-1">
                {entry.description}
            </p>
            {entry.tags && entry.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                    {entry.tags.slice(0, 4).map((tag) => (
                        <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted"
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}
            <div className="mt-3 flex items-center justify-between text-[11px] text-text-secondary dark:text-text-secondary-dark">
                <span className="font-mono truncate">{entry.slug}</span>
                {newHref ? (
                    <Link href={newHref}>
                        <Button size="sm" variant="primary">
                            Use template
                        </Button>
                    </Link>
                ) : (
                    <Button size="sm" variant="ghost" disabled title="Not yet wired">
                        Use template
                    </Button>
                )}
            </div>
        </div>
    );
}

function newRouteFor(entity: AstTemplateEntityType, slug: string): string | null {
    switch (entity) {
        case 'agent':
            return `${ROUTES.DASHBOARD_AGENT_NEW}?from=${encodeURIComponent(slug)}`;
        case 'task':
            return `${ROUTES.DASHBOARD_TASK_NEW}?from=${encodeURIComponent(slug)}`;
        case 'skill':
            // Skills don't yet have a /new route — Phase 9 creates via
            // the catalog install button + a "+ New Skill" inline form
            // on /skills. Templates land on /skills with the slug
            // pre-selected once that form gets a `?from=` handler.
            return `${ROUTES.DASHBOARD_SKILLS}?from=${encodeURIComponent(slug)}`;
        default:
            return null;
    }
}
