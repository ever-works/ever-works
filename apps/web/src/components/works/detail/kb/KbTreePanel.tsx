import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { KB_DOCUMENT_CLASSES } from '@ever-works/contracts';
import type { KbDocumentClass, KbDocumentDto } from '@ever-works/contracts';

interface KbTreePanelProps {
    workId: string;
    documents: KbDocumentDto[];
    /**
     * EW-641 Phase 2/e row 38a — inherited org-overlay documents that
     * this Work's organization owns. Rendered as a distinct "Inherited
     * from organization" section ABOVE the per-class groups so operators
     * can tell at-a-glance which docs are owned locally vs which come
     * from the org tier. Each row gets a lock-overlay marker so the
     * read-only nature is visually obvious before the user navigates.
     *
     * The actual API wire-up (`kbAPI.listInheritableDocuments` +
     * passing it down from the KB page server component) lands in row
     * 38b — until then the parent passes `[]` and the section is a
     * no-op. Defaulting to `[]` here keeps the prop optional + back-compat
     * with every existing call site (KbShell.tsx, KbTreePanel.unit.spec).
     */
    inheritedDocuments?: KbDocumentDto[];
    /** When non-null, highlights the matching row. */
    activePath?: string | null;
}

/**
 * EW-641 Phase 1B/d row 3 — read-only Knowledge Base tree panel.
 *
 * Server component. The parent page does a `kbAPI.listDocuments(workId)`
 * fetch and hands the result in as `documents`. We group by
 * `kbDocumentClass` in the canonical order from
 * `@ever-works/contracts.KB_DOCUMENT_CLASSES` so the panel layout is
 * stable across sessions and predictable for Playwright selectors
 * (A12-A17 acceptance suite locks onto `data-testid="kb-tree-*"`).
 *
 * Click handlers come in row 4 (`works/[id]/kb/[...path]/page.tsx`);
 * for now each row is a `next/link` pointing at the future detail
 * route so navigation works the moment that PR lands.
 *
 * The empty-state mirrors the placeholder copy used by `KbShell` so
 * "no documents yet" still reads naturally — operators land on the
 * page right after enabling KB and see the same explanation regardless
 * of whether the fetch ran or not.
 *
 * EW-641 Phase 2/e row 38a — also renders an "Inherited from
 * organization" section above the per-class groups when
 * `inheritedDocuments` is non-empty. Inherited rows are scoped to
 * `kb-tree-inherited-{cls}-{slug}` data-testids + carry a lock-overlay
 * marker so the read-only nature is visible without navigating. The
 * empty-state placeholder is only shown when BOTH the Work-owned and
 * the inherited lists are empty (otherwise the inherited section
 * itself is meaningful content even with no Work-owned docs).
 */
export async function KbTreePanel({
    workId,
    documents,
    inheritedDocuments = [],
    activePath = null,
}: KbTreePanelProps) {
    const t = await getTranslations('dashboard.workDetail.kb');

    if (documents.length === 0 && inheritedDocuments.length === 0) {
        return (
            <section
                data-testid="kb-tree"
                aria-label={t('panes.tree.title')}
                className={cn(
                    'rounded-lg border border-dashed border-border dark:border-border-dark',
                    'bg-card/30 dark:bg-card-primary-dark/20',
                    'p-4 flex flex-col gap-2',
                )}
            >
                <h2 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('panes.tree.title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark/60">
                    {t('panes.tree.empty')}
                </p>
            </section>
        );
    }

    const grouped = groupByClass(documents);

    return (
        <section
            data-testid="kb-tree"
            aria-label={t('panes.tree.title')}
            className={cn(
                'rounded-lg border border-border dark:border-border-dark',
                'bg-card/50 dark:bg-card-primary-dark/30',
                'p-3 flex flex-col gap-3 overflow-y-auto',
            )}
        >
            <header className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('panes.tree.title')}
                </h2>
                <span
                    className="text-xs text-text-muted dark:text-text-muted-dark/60"
                    data-testid="kb-tree-count"
                >
                    {documents.length}
                </span>
            </header>

            <nav aria-label={t('panes.tree.title')} className="flex flex-col gap-3">
                {inheritedDocuments.length > 0 ? (
                    <KbInheritedSection
                        workId={workId}
                        documents={inheritedDocuments}
                        sectionTitle={t('panes.tree.inheritedSection.title')}
                        sectionEmptyDescription={t('panes.tree.inheritedSection.description')}
                        lockedLabel={t('panes.tree.inheritedSection.lockedLabel')}
                    />
                ) : null}
                {KB_DOCUMENT_CLASSES.map((cls) => {
                    const docs = grouped.get(cls);
                    if (!docs || docs.length === 0) return null;
                    return (
                        <KbTreeGroup
                            key={cls}
                            workId={workId}
                            kbClass={cls}
                            label={t(`classes.${cls}`)}
                            docs={docs}
                            activePath={activePath}
                        />
                    );
                })}
            </nav>
        </section>
    );
}

interface KbTreeGroupProps {
    workId: string;
    kbClass: KbDocumentClass;
    label: string;
    docs: KbDocumentDto[];
    activePath: string | null;
}

function KbTreeGroup({ workId, kbClass, label, docs, activePath }: KbTreeGroupProps) {
    return (
        <div data-testid={`kb-tree-group-${kbClass}`} className="flex flex-col gap-1">
            <h3
                className={cn(
                    'text-[11px] font-semibold uppercase tracking-wider',
                    'text-text-muted dark:text-text-muted-dark/70',
                )}
            >
                {label}
                <span className="ml-1 text-text-muted/60">({docs.length})</span>
            </h3>
            <ul className="flex flex-col gap-0.5">
                {docs.map((doc) => {
                    const isActive = activePath !== null && activePath === doc.path;
                    return (
                        <li key={doc.id}>
                            <Link
                                href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`}
                                data-testid="kb-tree-item"
                                data-doc-path={doc.path}
                                data-locked={doc.locked ? 'true' : undefined}
                                aria-current={isActive ? 'page' : undefined}
                                className={cn(
                                    'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                                    isActive
                                        ? 'bg-primary/10 text-primary dark:bg-primary/20'
                                        : 'text-text-secondary dark:text-text-secondary-dark/80 hover:bg-card-hover dark:hover:bg-card-primary-dark/40 hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                <span className="truncate">{doc.title || doc.path}</span>
                                {doc.locked ? (
                                    <span
                                        aria-label="locked"
                                        className="ml-auto text-xs text-text-muted dark:text-text-muted-dark/60"
                                    >
                                        🔒
                                    </span>
                                ) : null}
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

interface KbInheritedSectionProps {
    workId: string;
    documents: KbDocumentDto[];
    sectionTitle: string;
    sectionEmptyDescription: string;
    lockedLabel: string;
}

/**
 * EW-641 Phase 2/e row 38a — "Inherited from organization" section
 * rendered above the Work-owned per-class groups. Rows are sorted
 * (class ASC, then title ASC case-insensitive) for deterministic
 * Playwright assertions. Each row uses
 * `data-testid="kb-tree-inherited-<class>-<slug>"` selectors so the
 * upcoming A19/A20 e2e (row 38e) can target exactly one inherited
 * doc by class + slug without race-prone position math.
 *
 * The lock-overlay marker (🔒) is rendered ALWAYS on inherited rows
 * — these docs are read-only at the tier level (the user's Work can't
 * mutate the org doc directly). Row 38d adds the "Override locally"
 * CTA on the detail page; the lock here is the at-a-glance affordance.
 *
 * Link targets the same `[...path]` route as Work-owned docs; row 38c
 * teaches the detail page to detect inherited rows (no Work-owned
 * override at the same path) and switch to read-only mode.
 */
function KbInheritedSection({
    workId,
    documents,
    sectionTitle,
    sectionEmptyDescription,
    lockedLabel,
}: KbInheritedSectionProps) {
    const sorted = sortInherited(documents);

    return (
        <div data-testid="kb-tree-inherited" className="flex flex-col gap-1">
            <h3
                className={cn(
                    'text-[11px] font-semibold uppercase tracking-wider',
                    'text-text-muted dark:text-text-muted-dark/70',
                )}
            >
                {sectionTitle}
                <span className="ml-1 text-text-muted/60">({sorted.length})</span>
            </h3>
            <p
                className="text-[11px] text-text-muted dark:text-text-muted-dark/60"
                data-testid="kb-tree-inherited-description"
            >
                {sectionEmptyDescription}
            </p>
            <ul className="flex flex-col gap-0.5">
                {sorted.map((doc) => (
                    <li key={doc.id}>
                        <Link
                            href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`}
                            data-testid={`kb-tree-inherited-${doc.class}-${doc.slug}`}
                            data-doc-path={doc.path}
                            data-doc-class={doc.class}
                            data-source="inherited"
                            className={cn(
                                'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                                'text-text-secondary dark:text-text-secondary-dark/80',
                                'hover:bg-card-hover dark:hover:bg-card-primary-dark/40',
                                'hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            <span className="truncate">{doc.title || doc.path}</span>
                            <span
                                aria-label={lockedLabel}
                                title={lockedLabel}
                                className="ml-auto text-xs text-text-muted dark:text-text-muted-dark/60"
                            >
                                🔒
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function groupByClass(documents: KbDocumentDto[]): Map<KbDocumentClass, KbDocumentDto[]> {
    const map = new Map<KbDocumentClass, KbDocumentDto[]>();
    for (const doc of documents) {
        const bucket = map.get(doc.class);
        if (bucket) {
            bucket.push(doc);
        } else {
            map.set(doc.class, [doc]);
        }
    }
    // Sort each bucket by title (case-insensitive) so the panel layout
    // is deterministic — matters for Playwright assertions and visual
    // diffing alike.
    for (const docs of map.values()) {
        docs.sort((a, b) =>
            (a.title || a.path).localeCompare(b.title || b.path, undefined, {
                sensitivity: 'base',
            }),
        );
    }
    return map;
}

function sortInherited(documents: KbDocumentDto[]): KbDocumentDto[] {
    return [...documents].sort((a, b) => {
        // Primary: canonical class order from KB_DOCUMENT_CLASSES so
        // `brand` shows before `legal` shows before `seo`. Falls back
        // to lexicographic-by-class if the class isn't in the canonical
        // list (defensive — KbDocumentClass is closed at the contract
        // layer but the runtime can drift).
        const aIdx = KB_DOCUMENT_CLASSES.indexOf(a.class);
        const bIdx = KB_DOCUMENT_CLASSES.indexOf(b.class);
        const aRank = aIdx === -1 ? KB_DOCUMENT_CLASSES.length : aIdx;
        const bRank = bIdx === -1 ? KB_DOCUMENT_CLASSES.length : bIdx;
        if (aRank !== bRank) return aRank - bRank;
        return (a.title || a.path).localeCompare(b.title || b.path, undefined, {
            sensitivity: 'base',
        });
    });
}
