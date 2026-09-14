'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    Archive,
    Building2,
    Download,
    ExternalLink,
    FileText,
    FolderClosed,
    FolderInput,
    MoreHorizontal,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { formatFolderPath, type KbLibraryDocumentDto } from '@/lib/api/knowledge-library-types';

export interface LibraryDocumentRowProps {
    document: KbLibraryDocumentDto;
    selected: boolean;
    onToggleSelect: (docId: string) => void;
    onFile: (document: KbLibraryDocumentDto) => void;
    onArchive: (document: KbLibraryDocumentDto) => void;
    onExport: (document: KbLibraryDocumentDto) => void;
    /** An action on this row is in flight. */
    busy?: boolean;
}

/** Workbench route of a Work document; organization documents have none. */
export function libraryDocumentHref(document: KbLibraryDocumentDto): string | null {
    return document.workId ? `${ROUTES.DASHBOARD_WORK_KB(document.workId)}/${document.path}` : null;
}

export function formatLibraryDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One document on the shelf: selection box, title (linked to its workbench),
 * class, folder breadcrumb, Work, a one-line description and when it last
 * changed substantively. The File button and the overflow menu (Open, Export
 * as Markdown, Archive) sit at the end of the row.
 *
 * A member without edit access sees File and Archive disabled with the reason
 * as their tooltip — never hidden, so the shelf reads the same to everyone.
 *
 * Keyboard, on the focused row: `f` files, `a` archives, Enter opens.
 */
export function LibraryDocumentRow({
    document,
    selected,
    onToggleSelect,
    onFile,
    onArchive,
    onExport,
    busy = false,
}: LibraryDocumentRowProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const href = libraryDocumentHref(document);
    const folder = formatFolderPath(document.folderPath) ?? t('unfiled');
    const changed = formatLibraryDate(document.revisionAt ?? document.updatedAt);
    const fileBlocked = !document.canEdit;
    const archiveBlocked = !document.canEdit;

    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (event: MouseEvent) => {
            if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
            setMenuOpen(false);
        };
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setMenuOpen(false);
        };
        globalThis.document.addEventListener('mousedown', onDown);
        globalThis.document.addEventListener('keydown', onKey);
        return () => {
            globalThis.document.removeEventListener('mousedown', onDown);
            globalThis.document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
        if (event.key === 'f' && !fileBlocked && !busy) {
            event.preventDefault();
            onFile(document);
        } else if (event.key === 'a' && !archiveBlocked && !busy) {
            event.preventDefault();
            onArchive(document);
        } else if (event.key === 'Enter' && href) {
            const link = event.currentTarget.querySelector<HTMLAnchorElement>('a[data-row-link]');
            link?.click();
        }
    };

    return (
        <div
            data-testid={`library-doc-${document.id}`}
            data-selected={selected ? 'true' : 'false'}
            tabIndex={0}
            onKeyDown={onRowKeyDown}
            className={cn(
                'group flex items-start gap-3 rounded-lg border p-3 transition-colors outline-none',
                'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                'hover:border-border-secondary dark:hover:border-white/20',
                'focus-visible:ring-2 focus-visible:ring-primary/40',
                selected && 'border-primary/50 dark:border-primary/50',
            )}
        >
            <input
                type="checkbox"
                data-testid={`library-doc-select-${document.id}`}
                checked={selected}
                onChange={() => onToggleSelect(document.id)}
                aria-label={t('selectDocument', { title: document.title })}
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-secondary dark:bg-white/5">
                <FileText
                    className="h-4 w-4 text-text-muted dark:text-text-muted-dark"
                    strokeWidth={1.5}
                    aria-hidden="true"
                />
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    {href ? (
                        <Link
                            href={href}
                            data-row-link
                            data-testid={`library-doc-title-${document.id}`}
                            className="truncate text-sm font-medium text-text hover:underline dark:text-text-dark"
                        >
                            {document.title}
                        </Link>
                    ) : (
                        <span
                            data-testid={`library-doc-title-${document.id}`}
                            className="truncate text-sm font-medium text-text dark:text-text-dark"
                        >
                            {document.title}
                        </span>
                    )}
                    <span className="inline-flex items-center rounded border border-card-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted dark:border-white/9 dark:text-text-muted-dark">
                        {document.class}
                    </span>
                </div>
                {document.description ? (
                    <p className="mt-0.5 line-clamp-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {document.description}
                    </p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    <span
                        data-testid={`library-doc-folder-${document.id}`}
                        className="inline-flex items-center gap-1"
                    >
                        <FolderClosed className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                        <span className="max-w-[14rem] truncate">{folder}</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                        <span className="max-w-[14rem] truncate">
                            {document.workName ?? t('orgScoped')}
                        </span>
                    </span>
                    {changed ? <span>{t('changedAt', { date: changed })}</span> : null}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
                <button
                    type="button"
                    data-testid={`library-doc-file-${document.id}`}
                    aria-label={t('fileInto')}
                    aria-disabled={fileBlocked || busy}
                    title={fileBlocked ? t('noEditAccessFile') : t('fileInto')}
                    onClick={() => {
                        if (!fileBlocked && !busy) onFile(document);
                    }}
                    className={cn(
                        'inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted dark:text-text-muted-dark',
                        'hover:bg-surface-secondary hover:text-text dark:hover:bg-white/5 dark:hover:text-text-dark',
                        (fileBlocked || busy) && 'cursor-not-allowed opacity-50',
                    )}
                >
                    <FolderInput className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                </button>
                <div ref={menuRef} className="relative">
                    <button
                        type="button"
                        data-testid={`library-doc-menu-${document.id}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-label={t('moreActions', { title: document.title })}
                        onClick={() => setMenuOpen((open) => !open)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-secondary hover:text-text dark:text-text-muted-dark dark:hover:bg-white/5 dark:hover:text-text-dark"
                    >
                        <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                    </button>
                    {menuOpen ? (
                        <div
                            role="menu"
                            data-testid={`library-doc-menu-panel-${document.id}`}
                            className="absolute right-0 top-9 z-20 min-w-[13rem] rounded-md border border-border bg-surface p-1 text-sm shadow-lg dark:border-border-dark dark:bg-surface-dark"
                        >
                            {href ? (
                                <Link
                                    href={href}
                                    role="menuitem"
                                    data-testid={`library-doc-open-${document.id}`}
                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-text hover:bg-surface-hover dark:text-text-dark dark:hover:bg-surface-hover-dark"
                                >
                                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('open')}
                                </Link>
                            ) : null}
                            <RowMenuItem
                                testId={`library-doc-export-${document.id}`}
                                icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                                label={t('exportMarkdown')}
                                disabled={busy}
                                onClick={() => {
                                    setMenuOpen(false);
                                    onExport(document);
                                }}
                            />
                            <RowMenuItem
                                testId={`library-doc-archive-${document.id}`}
                                icon={<Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                                label={t('archive')}
                                disabled={archiveBlocked || busy}
                                disabledReason={
                                    archiveBlocked ? t('noEditAccessArchive') : undefined
                                }
                                onClick={() => {
                                    setMenuOpen(false);
                                    onArchive(document);
                                }}
                            />
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

export function RowMenuItem({
    testId,
    icon,
    label,
    disabled,
    disabledReason,
    onClick,
}: {
    testId: string;
    icon: ReactNode;
    label: string;
    disabled?: boolean;
    disabledReason?: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="menuitem"
            data-testid={testId}
            aria-disabled={disabled ? true : undefined}
            title={disabled ? disabledReason : undefined}
            onClick={() => {
                if (!disabled) onClick();
            }}
            className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-text dark:text-text-dark',
                'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                disabled && 'cursor-not-allowed opacity-50',
            )}
        >
            {icon}
            <span className="flex-1">{label}</span>
        </button>
    );
}
