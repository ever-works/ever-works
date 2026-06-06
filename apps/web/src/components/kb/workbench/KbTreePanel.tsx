'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    BookOpen,
    Building2,
    Database,
    FileText,
    Gavel,
    Globe2,
    Lightbulb,
    Lock,
    Palette,
    Search,
    Sparkles,
    UploadCloud,
    Users,
    Library,
    ChevronDown,
    ChevronRight,
    type LucideIcon,
} from 'lucide-react';
import { KB_DOCUMENT_CLASSES } from '@ever-works/contracts';
import type { KbDocumentClass, KbDocumentDto, KbDocumentStatus } from '@ever-works/contracts';

/**
 * EW-641 slice A — workbench tree panel.
 *
 * Client component because the tab toggle (KB / Originals) is local
 * UI state and we fetch the doc metadata in-component (the workbench
 * page hands us a `workId` and we hit the same `/api/works/:id/kb/documents`
 * endpoint the server-side index page uses, but through the user's
 * session cookie via a relative `fetch`). Keeps the panel self-contained
 * — the parent route only needs to render `<KbTreePanel workId=… />`.
 *
 * Each class group is collapsible. Groups are collapsed by default with
 * the one exception of the group that contains `currentDocPath` (we
 * keep that one open so the active row is visible on first render).
 *
 * Drag-and-drop / right-click / inline rename are intentionally OUT of
 * scope here — slices C and E own those affordances.
 */

export interface KbTreePanelProps {
    workId: string;
    currentDocPath?: string;
}

type Tab = 'kb' | 'originals';

interface ListResponse {
    items: KbDocumentDto[];
    total: number;
}

const CLASS_ICONS: Record<KbDocumentClass, LucideIcon> = {
    brand: Sparkles,
    legal: Gavel,
    seo: Globe2,
    style: Palette,
    glossary: BookOpen,
    competitors: Building2,
    personas: Users,
    research: Search,
    output: FileText,
    freeform: Lightbulb,
};

export function KbTreePanel({ workId, currentDocPath }: KbTreePanelProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const [tab, setTab] = useState<Tab>('kb');
    const [documents, setDocuments] = useState<KbDocumentDto[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetch(`/api/works/${encodeURIComponent(workId)}/kb/documents`, {
            cache: 'no-store',
        })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as ListResponse;
            })
            .then((data) => {
                if (cancelled) return;
                setDocuments(data.items ?? []);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [workId]);

    const grouped = useMemo(() => groupByClass(documents), [documents]);
    // Pre-compute which class contains the active doc so it opens by
    // default on first render (without overriding subsequent user
    // toggles — see `expandedDefaults`).
    const activeClass = useMemo<KbDocumentClass | null>(() => {
        if (!currentDocPath) return null;
        const hit = documents.find((doc) => doc.path === currentDocPath);
        return hit?.class ?? null;
    }, [documents, currentDocPath]);

    return (
        <div data-testid="kb-workbench-tree" className="flex h-full flex-col" data-work-id={workId}>
            <header className="flex items-center gap-1 border-b border-border px-3 py-2 dark:border-border-dark">
                <h2 className="sr-only">{t('workbench.title')}</h2>
                <TreeTab
                    label={t('workbench.tab.kb')}
                    active={tab === 'kb'}
                    onClick={() => setTab('kb')}
                    testId="kb-workbench-tab-kb"
                />
                <TreeTab
                    label={t('workbench.tab.originals')}
                    active={tab === 'originals'}
                    onClick={() => setTab('originals')}
                    testId="kb-workbench-tab-originals"
                />
            </header>

            <div className="flex-1 overflow-y-auto p-2">
                {tab === 'kb' ? (
                    <KbTab
                        workId={workId}
                        loading={loading}
                        error={error}
                        grouped={grouped}
                        currentDocPath={currentDocPath ?? null}
                        activeClass={activeClass}
                        labels={{
                            empty: t('panes.tree.empty'),
                            classLabel: (cls: KbDocumentClass) => t(`classes.${cls}`),
                            statusLabel: (status: KbDocumentStatus) => t(`status.${status}`),
                            lockedLabel: t('lock.full'),
                        }}
                    />
                ) : (
                    <OriginalsPlaceholder message={t('workbench.originals.placeholder')} />
                )}
            </div>
        </div>
    );
}

interface KbTabProps {
    workId: string;
    loading: boolean;
    error: string | null;
    grouped: Map<KbDocumentClass, KbDocumentDto[]>;
    currentDocPath: string | null;
    activeClass: KbDocumentClass | null;
    labels: {
        empty: string;
        classLabel: (cls: KbDocumentClass) => string;
        statusLabel: (status: KbDocumentStatus) => string;
        lockedLabel: string;
    };
}

function KbTab({
    workId,
    loading,
    error,
    grouped,
    currentDocPath,
    activeClass,
    labels,
}: KbTabProps) {
    if (loading) {
        return (
            <p
                data-testid="kb-workbench-tree-loading"
                className="px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark/60"
            >
                …
            </p>
        );
    }
    if (error) {
        return (
            <p
                data-testid="kb-workbench-tree-error"
                className="px-2 py-1 text-xs text-red-600 dark:text-red-400"
            >
                {error}
            </p>
        );
    }
    if (grouped.size === 0) {
        return (
            <p
                data-testid="kb-workbench-tree-empty"
                className="px-2 py-1 text-sm text-text-muted dark:text-text-muted-dark/60"
            >
                {labels.empty}
            </p>
        );
    }

    return (
        <nav aria-label="Knowledge Base" className="flex flex-col gap-1">
            {KB_DOCUMENT_CLASSES.map((cls) => {
                const docs = grouped.get(cls);
                if (!docs || docs.length === 0) return null;
                return (
                    <KbTreeGroup
                        key={cls}
                        workId={workId}
                        cls={cls}
                        label={labels.classLabel(cls)}
                        docs={docs}
                        defaultOpen={cls === activeClass}
                        currentDocPath={currentDocPath}
                        statusLabel={labels.statusLabel}
                        lockedLabel={labels.lockedLabel}
                    />
                );
            })}
        </nav>
    );
}

interface KbTreeGroupProps {
    workId: string;
    cls: KbDocumentClass;
    label: string;
    docs: KbDocumentDto[];
    defaultOpen: boolean;
    currentDocPath: string | null;
    statusLabel: (status: KbDocumentStatus) => string;
    lockedLabel: string;
}

function KbTreeGroup({
    workId,
    cls,
    label,
    docs,
    defaultOpen,
    currentDocPath,
    statusLabel,
    lockedLabel,
}: KbTreeGroupProps) {
    const [open, setOpen] = useState(defaultOpen);
    const Icon = CLASS_ICONS[cls] ?? FileText;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <div data-testid={`kb-workbench-group-${cls}`} className="flex flex-col">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                aria-expanded={open}
                data-testid={`kb-workbench-group-toggle-${cls}`}
                className={cn(
                    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left',
                    'text-[11px] font-semibold uppercase tracking-wider',
                    'text-text-muted hover:bg-card-hover dark:text-text-muted-dark/70',
                    'dark:hover:bg-card-primary-dark/40',
                )}
            >
                <Chevron className="h-3 w-3" aria-hidden="true" />
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{label}</span>
                <span className="ml-auto text-text-muted/60">({docs.length})</span>
            </button>
            {open ? (
                <ul className="ml-2 flex flex-col gap-0.5 border-l border-border/60 pl-2 dark:border-border-dark/60">
                    {docs.map((doc) => {
                        const isActive = currentDocPath === doc.path;
                        return (
                            <li key={doc.id}>
                                <Link
                                    href={`${ROUTES.DASHBOARD_WORK_KB(workId)}/${doc.path}`}
                                    data-testid={`kb-workbench-row-${doc.id}`}
                                    data-doc-path={doc.path}
                                    aria-current={isActive ? 'page' : undefined}
                                    className={cn(
                                        'flex items-center gap-2 rounded px-2 py-1 text-sm transition-colors',
                                        isActive
                                            ? 'bg-primary/10 text-text dark:bg-primary/20 dark:text-text-dark'
                                            : 'text-text-secondary hover:bg-card-hover hover:text-text dark:text-text-secondary-dark/80 dark:hover:bg-card-primary-dark/40 dark:hover:text-text-dark',
                                    )}
                                >
                                    <FileText
                                        className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark/60"
                                        aria-hidden="true"
                                    />
                                    <span className="truncate">{doc.title || doc.path}</span>
                                    {doc.locked ? (
                                        <Lock
                                            data-testid={`kb-workbench-row-${doc.id}-lock`}
                                            aria-label={lockedLabel}
                                            className="ml-auto h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300"
                                        />
                                    ) : null}
                                    {doc.status !== 'active' ? (
                                        <span
                                            data-testid={`kb-workbench-row-${doc.id}-status`}
                                            className={cn(
                                                'rounded-full px-1.5 py-0.5 text-[10px] uppercase',
                                                doc.locked ? 'ml-1' : 'ml-auto',
                                                doc.status === 'draft'
                                                    ? 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70'
                                                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                                            )}
                                        >
                                            {statusLabel(doc.status)}
                                        </span>
                                    ) : null}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}

interface TreeTabProps {
    label: string;
    active: boolean;
    onClick: () => void;
    testId: string;
}

function TreeTab({ label, active, onClick, testId }: TreeTabProps) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={testId}
            onClick={onClick}
            className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active
                    ? 'bg-primary/10 text-text dark:bg-primary/20 dark:text-text-dark'
                    : 'text-text-muted hover:bg-card-hover hover:text-text dark:text-text-muted-dark/70 dark:hover:bg-card-primary-dark/40 dark:hover:text-text-dark',
            )}
        >
            {label}
        </button>
    );
}

interface OriginalsPlaceholderProps {
    message: string;
}

function OriginalsPlaceholder({ message }: OriginalsPlaceholderProps) {
    return (
        <div
            data-testid="kb-workbench-originals-placeholder"
            className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed',
                'border-border px-4 py-6 text-center text-xs text-text-muted',
                'dark:border-border-dark dark:text-text-muted-dark/60',
            )}
        >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-card-hover dark:bg-card-primary-dark/40">
                <UploadCloud className="h-4 w-4" aria-hidden="true" />
            </span>
            <p>{message}</p>
            <Database className="hidden h-3 w-3" aria-hidden="true" />
            <Library className="hidden h-3 w-3" aria-hidden="true" />
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
    for (const docs of map.values()) {
        docs.sort((a, b) =>
            (a.title || a.path).localeCompare(b.title || b.path, undefined, {
                sensitivity: 'base',
            }),
        );
    }
    return map;
}
