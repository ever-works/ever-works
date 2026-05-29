'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    BookOpen,
    Bot,
    ClipboardList,
    Code2,
    Cpu,
    Crown,
    LayoutGrid,
    PenLine,
    Sparkles,
    TrendingUp,
    Wrench,
    type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { PromptChipsRow, type PromptChip } from '@/components/common/PromptChipsRow';
import { ROUTES } from '@/lib/constants';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';

/**
 * Agent-template quick-pick chips + `View All` catalog, rendered below
 * the prompt composer on `/agents` (spec FR-10…FR-19). The first chip
 * is `View All`, which toggles an inline catalog of every repo template
 * (`ever-works/agents`, ADR-011) plus the user's own templates. Every
 * other chip is a template name (CEO, CTO, …); clicking one seeds the
 * prompt via `onPick` so the user can elaborate, rather than creating
 * an Agent immediately.
 */

/** Sentinel chip value for the `View All` toggle (never a real slug). */
const VIEW_ALL = '__view_all__';

/**
 * Curated lucide icons referenced by the built-in fallback catalog +
 * repo `agent.yml` `icon` fields. Imported explicitly (not via a
 * dynamic barrel) to keep the bundle lean. Unknown names fall back to
 * `Bot`.
 */
const ICON_BY_NAME: Record<string, LucideIcon> = {
    Crown,
    Cpu,
    Wrench,
    PenLine,
    TrendingUp,
    Sparkles,
    ClipboardList,
    Code2,
    BookOpen,
};

function resolveIcon(name?: string): LucideIcon {
    return (name && ICON_BY_NAME[name]) || Bot;
}

export interface AgentTemplateChipsProps {
    /** Catalog templates (repo or built-in fallback). */
    readonly templates: ReadonlyArray<AstTemplateEntry>;
    /** The signed-in user's own templates ("Your templates" section). */
    readonly userTemplates?: ReadonlyArray<AstTemplateEntry>;
    /** Called when the user picks a template (chip or catalog card). */
    readonly onPick: (template: AstTemplateEntry) => void;
    readonly className?: string;
}

export function AgentTemplateChips({
    templates,
    userTemplates = [],
    onPick,
    className,
}: AgentTemplateChipsProps) {
    const t = useTranslations('dashboard.agentsPage');
    const [expanded, setExpanded] = useState(false);

    const chips = useMemo<ReadonlyArray<PromptChip<string>>>(
        () => [
            { value: VIEW_ALL, label: t('chips.viewAll'), Icon: LayoutGrid },
            ...templates.map((tpl) => ({
                value: tpl.slug,
                label: tpl.title,
                Icon: resolveIcon(tpl.iconName),
            })),
        ],
        [t, templates],
    );

    const findBySlug = useCallback(
        (slug: string) =>
            templates.find((x) => x.slug === slug) ?? userTemplates.find((x) => x.slug === slug),
        [templates, userTemplates],
    );

    const handleChange = useCallback(
        (next: string | null) => {
            // `View All` clicked while inactive → open. The row emits
            // `null` when the active chip is re-clicked, which for us
            // means `View All` was toggled off → collapse.
            if (next === VIEW_ALL) {
                setExpanded(true);
                return;
            }
            if (next === null) {
                setExpanded(false);
                return;
            }
            const tpl = findBySlug(next);
            if (tpl) onPick(tpl);
        },
        [findBySlug, onPick],
    );

    // Esc collapses the catalog panel (FR-19).
    useEffect(() => {
        if (!expanded) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExpanded(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [expanded]);

    const pickAndCollapse = useCallback(
        (tpl: AstTemplateEntry) => {
            onPick(tpl);
            setExpanded(false);
        },
        [onPick],
    );

    return (
        <div className={cn('space-y-3', className)}>
            <PromptChipsRow
                chips={chips}
                value={expanded ? VIEW_ALL : null}
                onChange={handleChange}
                ariaLabel={t('chips.ariaLabel')}
                testIdPrefix="agent-template-chip"
            />

            {expanded && (
                <div
                    className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card/60 dark:bg-card-primary-dark/40 p-4 space-y-5"
                    data-testid="agent-template-catalog"
                >
                    <CatalogSection
                        title={t('catalog.allTemplates')}
                        openInWizardLabel={t('catalog.openInWizard')}
                        entries={templates}
                        onPick={pickAndCollapse}
                    />
                    <CatalogSection
                        title={t('catalog.yourTemplates')}
                        openInWizardLabel={t('catalog.openInWizard')}
                        entries={userTemplates}
                        emptyHint={t('catalog.yourTemplatesEmpty')}
                        onPick={pickAndCollapse}
                    />
                </div>
            )}
        </div>
    );
}

interface CatalogSectionProps {
    readonly title: string;
    readonly openInWizardLabel: string;
    readonly entries: ReadonlyArray<AstTemplateEntry>;
    readonly emptyHint?: string;
    readonly onPick: (template: AstTemplateEntry) => void;
}

function CatalogSection({
    title,
    openInWizardLabel,
    entries,
    emptyHint,
    onPick,
}: CatalogSectionProps) {
    return (
        <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                {title}
            </h3>
            {entries.length === 0 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{emptyHint}</p>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-3">
                    {entries.map((tpl) => {
                        const Icon = resolveIcon(tpl.iconName);
                        return (
                            <div
                                key={tpl.slug}
                                className="group flex flex-col gap-2 rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3"
                            >
                                <button
                                    type="button"
                                    onClick={() => onPick(tpl)}
                                    className="flex flex-col gap-1 text-left"
                                    data-testid={`agent-template-card-${tpl.slug}`}
                                >
                                    <span className="flex items-center gap-2">
                                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                                            <Icon className="size-4" aria-hidden="true" />
                                        </span>
                                        <span className="text-sm font-medium text-text dark:text-text-dark">
                                            {tpl.title}
                                        </span>
                                        {tpl.category && (
                                            <span className="ml-auto rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] text-text-muted dark:bg-white/10 dark:text-text-muted-dark">
                                                {tpl.category}
                                            </span>
                                        )}
                                    </span>
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark line-clamp-2">
                                        {tpl.description}
                                    </span>
                                </button>
                                <Button
                                    href={`${ROUTES.DASHBOARD_AGENT_NEW}?from=${encodeURIComponent(tpl.slug)}`}
                                    variant="ghost"
                                    size="sm"
                                    className="self-start text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                                >
                                    {openInWizardLabel}
                                </Button>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
