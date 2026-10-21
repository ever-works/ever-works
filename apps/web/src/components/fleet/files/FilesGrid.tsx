'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CornerLeftUp, File, FileQuestion, Folder, Link2, Lock } from 'lucide-react';
import type { FleetFileEntryView } from '@ever-works/contracts';
import { formatFileBytes, opensAsFolder } from './files.shared';

/**
 * Files on computers (FL-11, FR-41, T-11) — the folder's entries as a
 * keyboard-navigable grid (`role="grid"`): ↑/↓ (Home/End) move between rows,
 * `Space` selects the focused row, `Enter` opens a folder, `Backspace` goes
 * one folder up; every action stays reachable by `Tab`. A credential-shaped
 * name carries a lock and its label (FR-8); a link says whether it stays inside
 * the root, and only an inside folder link opens (U4).
 */
export function FilesGrid({
    entries,
    selected,
    folderLabel,
    canGoUp,
    disabled,
    onToggle,
    onToggleAll,
    onOpen,
    onUp,
}: {
    entries: readonly FleetFileEntryView[];
    selected: ReadonlySet<string>;
    folderLabel: string;
    canGoUp: boolean;
    disabled: boolean;
    onToggle(name: string): void;
    onToggleAll(): void;
    onOpen(entry: FleetFileEntryView): void;
    onUp(): void;
}) {
    const t = useTranslations('fleet.files.grid');
    const locale = useLocale();
    const offset = canGoUp ? 1 : 0;
    const rows = entries.length + offset;
    const [focus, setFocus] = useState(0);
    const refs = useRef<Array<HTMLDivElement | null>>([]);

    useEffect(() => {
        setFocus((current) => Math.min(current, Math.max(0, rows - 1)));
    }, [rows]);

    const moveTo = useCallback(
        (index: number) => {
            const next = Math.max(0, Math.min(rows - 1, index));
            setFocus(next);
            refs.current[next]?.focus();
        },
        [rows],
    );

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
        if (disabled) return;
        const entry = index >= offset ? entries[index - offset] : null;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                moveTo(index + 1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                moveTo(index - 1);
                break;
            case 'Home':
                event.preventDefault();
                moveTo(0);
                break;
            case 'End':
                event.preventDefault();
                moveTo(rows - 1);
                break;
            case ' ':
                event.preventDefault();
                if (entry) onToggle(entry.name);
                break;
            case 'Enter':
                event.preventDefault();
                if (!entry) onUp();
                else if (opensAsFolder(entry)) onOpen(entry);
                break;
            case 'Backspace':
                if (canGoUp) {
                    event.preventDefault();
                    onUp();
                }
                break;
            default:
        }
    };

    const formatWhen = (iso: string | null) => {
        if (!iso) return '';
        const when = new Date(iso);
        const sameDay = when.toDateString() === new Date().toDateString();
        return new Intl.DateTimeFormat(
            locale,
            sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium' },
        ).format(when);
    };

    const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.name));

    return (
        <div
            role="grid"
            aria-label={t('label', { folder: folderLabel })}
            aria-multiselectable="true"
            aria-rowcount={rows + 1}
            className="rounded-xl border border-border dark:border-border-dark overflow-hidden text-sm"
            data-testid="fleet-files-grid"
        >
            <div
                role="row"
                className="grid grid-cols-[2rem_minmax(0,1fr)_6rem_8rem_8rem] items-center gap-2 px-3 py-2 bg-black/[0.03] dark:bg-white/[0.04] text-xs font-semibold text-text-muted dark:text-text-muted-dark"
            >
                <div role="columnheader">
                    <input
                        type="checkbox"
                        aria-label={t('selectAll')}
                        checked={allSelected}
                        disabled={disabled || entries.length === 0}
                        onChange={onToggleAll}
                    />
                </div>
                <div role="columnheader">{t('name')}</div>
                <div role="columnheader" className="text-right">
                    {t('size')}
                </div>
                <div role="columnheader">{t('modified')}</div>
                <div role="columnheader">{t('kind')}</div>
            </div>
            {canGoUp && (
                <div
                    role="row"
                    ref={(element) => {
                        refs.current[0] = element;
                    }}
                    tabIndex={focus === 0 ? 0 : -1}
                    onKeyDown={(event) => onKeyDown(event, 0)}
                    onFocus={() => setFocus(0)}
                    onDoubleClick={onUp}
                    className="grid grid-cols-[2rem_minmax(0,1fr)_6rem_8rem_8rem] items-center gap-2 px-3 py-1.5 border-t border-border dark:border-border-dark focus:outline-none focus-visible:bg-primary/10 cursor-pointer"
                    data-testid="fleet-files-up"
                >
                    <div role="gridcell" />
                    <div role="gridcell">
                        <button
                            type="button"
                            onClick={onUp}
                            className="inline-flex items-center gap-2 text-text dark:text-text-dark hover:underline"
                            aria-label={t('parent')}
                            tabIndex={-1}
                        >
                            <CornerLeftUp className="w-4 h-4" aria-hidden="true" />
                            ..
                        </button>
                    </div>
                    <div role="gridcell" />
                    <div role="gridcell" />
                    <div role="gridcell" />
                </div>
            )}
            {entries.map((entry, i) => {
                const index = i + offset;
                const isSelected = selected.has(entry.name);
                const folder = opensAsFolder(entry);
                const icon = entry.credentialShaped ? (
                    <Lock className="w-4 h-4 text-warning" aria-hidden="true" />
                ) : entry.kind === 'folder' ? (
                    <Folder className="w-4 h-4 text-primary" aria-hidden="true" />
                ) : entry.kind === 'link' ? (
                    <Link2
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                        aria-hidden="true"
                    />
                ) : entry.kind === 'other' ? (
                    <FileQuestion
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                        aria-hidden="true"
                    />
                ) : (
                    <File
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                        aria-hidden="true"
                    />
                );
                const kind =
                    entry.kind === 'link'
                        ? entry.linkInsideRoot === true
                            ? t('flags.linkInside')
                            : entry.linkInsideRoot === false
                              ? t('flags.linkOutside')
                              : t('flags.linkBroken')
                        : t(`kinds.${entry.kind}`);
                return (
                    <div
                        key={entry.name}
                        role="row"
                        aria-selected={isSelected}
                        ref={(element) => {
                            refs.current[index] = element;
                        }}
                        tabIndex={focus === index ? 0 : -1}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        onFocus={() => setFocus(index)}
                        onDoubleClick={() => folder && !disabled && onOpen(entry)}
                        className={`grid grid-cols-[2rem_minmax(0,1fr)_6rem_8rem_8rem] items-center gap-2 px-3 py-1.5 border-t border-border dark:border-border-dark focus:outline-none focus-visible:bg-primary/10 ${
                            isSelected ? 'bg-primary/5' : ''
                        }`}
                        data-testid="fleet-files-row"
                        data-name={entry.name}
                    >
                        <div role="gridcell">
                            <input
                                type="checkbox"
                                tabIndex={-1}
                                aria-label={t('select', { name: entry.name })}
                                checked={isSelected}
                                disabled={disabled}
                                onChange={() => onToggle(entry.name)}
                            />
                        </div>
                        <div role="gridcell" className="min-w-0">
                            {folder ? (
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    disabled={disabled}
                                    onClick={() => onOpen(entry)}
                                    className="inline-flex items-center gap-2 min-w-0 text-text dark:text-text-dark hover:underline"
                                    aria-label={t('open', { name: entry.name })}
                                >
                                    {icon}
                                    <span className="truncate">{entry.name}</span>
                                </button>
                            ) : (
                                <span className="inline-flex items-center gap-2 min-w-0 text-text dark:text-text-dark">
                                    {icon}
                                    <span className="truncate">{entry.name}</span>
                                </span>
                            )}
                        </div>
                        <div
                            role="gridcell"
                            className="text-right tabular-nums text-text-muted dark:text-text-muted-dark"
                        >
                            {entry.kind === 'file' ? formatFileBytes(entry.size) : ''}
                        </div>
                        <div
                            role="gridcell"
                            className="text-text-muted dark:text-text-muted-dark truncate"
                        >
                            {formatWhen(entry.modifiedAt)}
                        </div>
                        <div
                            role="gridcell"
                            className="text-text-muted dark:text-text-muted-dark truncate"
                        >
                            {kind}
                            {entry.credentialShaped ? ` · ${t('flags.credential')}` : ''}
                        </div>
                    </div>
                );
            })}
            {entries.length === 0 && (
                <div
                    role="row"
                    className="px-3 py-6 text-center text-text-muted dark:text-text-muted-dark border-t border-border dark:border-border-dark"
                >
                    <div role="gridcell">{t('empty')}</div>
                </div>
            )}
        </div>
    );
}
