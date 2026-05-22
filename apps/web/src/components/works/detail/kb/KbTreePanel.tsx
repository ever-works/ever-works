import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { KB_DOCUMENT_CLASSES } from '@ever-works/contracts';
import type { KbDocumentClass, KbDocumentDto } from '@ever-works/contracts';

interface KbTreePanelProps {
    workId: string;
    documents: KbDocumentDto[];
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
 */
export async function KbTreePanel({ workId, documents, activePath = null }: KbTreePanelProps) {
    const t = await getTranslations('dashboard.workDetail.kb');

    if (documents.length === 0) {
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
