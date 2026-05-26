'use client';

import { useMemo, useState, useTransition } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';
import { installCatalogSkillAction } from '@/app/actions/skills';

type Section = 'installed' | 'available' | 'custom';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9. Three-section Skills hub
 * client. Section toggle (Installed / Available / Custom) per
 * `features/skills/plan.md §6` table row.
 *
 * "Available" = catalog union from enabled skills-provider plugins.
 * "Custom" = user's installed Skills that have no sourceCatalogSlug
 * (hand-written, not catalog-derived).
 *
 * Install action installs the catalog entry at tenant scope
 * (ownerType=tenant, ownerId=userId). Picking a non-tenant target
 * happens from the per-target Skills tab (Phase 14 surface).
 */
export function SkillsPageClient({
    installed,
    catalog,
}: {
    installed: Skill[];
    catalog: SkillCatalogEntry[];
}) {
    const [section, setSection] = useState<Section>('installed');

    const installedSlugs = useMemo(() => new Set(installed.map((s) => s.slug)), [installed]);
    const customSkills = useMemo(
        () => installed.filter((s) => !s.sourceCatalogSlug),
        [installed],
    );

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
                {(['installed', 'available', 'custom'] as Section[]).map((s) => (
                    <button
                        key={s}
                        type="button"
                        onClick={() => setSection(s)}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-colors capitalize ${
                            section === s
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark'
                        }`}
                    >
                        {s}
                    </button>
                ))}
            </div>

            {section === 'installed' && <InstalledList installed={installed} />}
            {section === 'available' && (
                <CatalogList entries={catalog} installedSlugs={installedSlugs} />
            )}
            {section === 'custom' && <InstalledList installed={customSkills} />}
        </div>
    );
}

function InstalledList({ installed }: { installed: Skill[] }) {
    if (installed.length === 0) {
        return (
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                No Skills installed at this scope yet.
            </div>
        );
    }
    return (
        <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
            {installed.map((s) => (
                <Link
                    key={s.id}
                    href={ROUTES.DASHBOARD_SKILL(s.id)}
                    className="block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-border dark:hover:border-border-dark transition-colors"
                >
                    <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                            {s.title}
                        </h3>
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark">
                            {s.ownerType}
                        </span>
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {s.description}
                    </p>
                    <div className="flex items-center gap-2 mt-3 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                        <span className="font-mono">{s.slug}</span>
                        <span>v{s.version}</span>
                        {s.sourceCatalogSlug && <span>· from catalog</span>}
                    </div>
                </Link>
            ))}
        </div>
    );
}

function CatalogList({
    entries,
    installedSlugs,
}: {
    entries: SkillCatalogEntry[];
    installedSlugs: Set<string>;
}) {
    if (entries.length === 0) {
        return (
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6 text-sm text-text-muted dark:text-text-muted-dark">
                No Skills available — install or enable a skills-provider plugin.
            </div>
        );
    }
    return (
        <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
            {entries.map((e) => (
                <CatalogCard key={e.slug} entry={e} alreadyInstalled={installedSlugs.has(e.slug)} />
            ))}
        </div>
    );
}

function CatalogCard({
    entry,
    alreadyInstalled,
}: {
    entry: SkillCatalogEntry;
    alreadyInstalled: boolean;
}) {
    const [pending, startTransition] = useTransition();
    const [done, setDone] = useState(alreadyInstalled);
    const [error, setError] = useState<string | null>(null);

    const handleInstall = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await installCatalogSkillAction({ slug: entry.slug });
                    setDone(true);
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Install failed');
                }
            })();
        });
    };

    return (
        <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
            <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                    {entry.title}
                </h3>
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark">
                    v{entry.version}
                </span>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                {entry.description}
            </p>
            <div className="flex items-center justify-between gap-2 mt-3 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                <span className="font-mono truncate">{entry.slug}</span>
                <Button
                    size="sm"
                    variant={done ? 'ghost' : 'primary'}
                    onClick={handleInstall}
                    disabled={pending || done}
                    className="gap-1.5"
                >
                    <Download className="w-3.5 h-3.5" />
                    {done ? 'Installed' : pending ? '…' : 'Install'}
                </Button>
            </div>
            {error && (
                <p className="text-xs text-danger mt-2" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
