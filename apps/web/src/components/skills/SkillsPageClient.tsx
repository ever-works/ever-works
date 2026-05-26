'use client';

import { useMemo, useState, useTransition } from 'react';
import { Download, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';
import { createCustomSkillAction, installCatalogSkillAction } from '@/app/actions/skills';

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
            {section === 'custom' && (
                <CustomSection skills={customSkills} userIdHintAvailable={false} />
            )}
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

/**
 * PASS-4 review fix (CRITICAL UX): the Custom section was previously
 * unreachable — InstalledList just showed "No Skills installed at
 * this scope yet" with no CTA. Now exposes an inline "+ New Skill"
 * form that creates a hand-authored Skill at tenant scope. Body is
 * a tiny starter Markdown; the user can flesh it out via the
 * detail-page autosave editor (`/skills/[id]`).
 */
function CustomSection({
    skills,
    userIdHintAvailable: _,
}: {
    skills: Skill[];
    userIdHintAvailable: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();

    const handleCreate = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) {
            setError('Title is required.');
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    // Tenant-scope by default. The action's getCurrentUserId
                    // helper reads the auth cookie and supplies ownerId.
                    const created = await createCustomSkillAction({
                        ownerType: 'tenant',
                        ownerId: '', // server-side action resolves via getAuthFromCookie
                        title: title.trim(),
                        description: description.trim() || `Custom Skill: ${title.trim()}`,
                        instructionsMd: `# ${title.trim()}\n\n${description.trim() || '_Describe what this Skill teaches your Agent..._'}\n`,
                    });
                    router.push(ROUTES.DASHBOARD_SKILL(created.id));
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to create Skill');
                }
            })();
        });
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    Hand-authored Skills you wrote yourself — not installed from a plugin
                    catalog. {skills.length} {skills.length === 1 ? 'Skill' : 'Skills'}.
                </p>
                {!open && (
                    <Button size="sm" variant="primary" onClick={() => setOpen(true)} className="gap-1.5">
                        <Plus className="w-3.5 h-3.5" />
                        New Skill
                    </Button>
                )}
            </div>

            {open && (
                <form
                    onSubmit={handleCreate}
                    className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-3"
                >
                    <h3 className="text-sm font-medium text-text dark:text-text-dark">
                        New custom Skill
                    </h3>
                    <div>
                        <label className="block text-[10px] text-text-muted mb-1">Title</label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g. Code review checklist"
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] text-text-muted mb-1">
                            Description (optional)
                        </label>
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="One-liner. Body goes on the detail page."
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Button type="submit" size="sm" disabled={pending}>
                            {pending ? '…' : 'Create'}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setOpen(false)}
                            disabled={pending}
                        >
                            Cancel
                        </Button>
                    </div>
                    {error && (
                        <p className="text-xs text-danger" role="alert">
                            {error}
                        </p>
                    )}
                </form>
            )}

            <InstalledList installed={skills} />
        </div>
    );
}
