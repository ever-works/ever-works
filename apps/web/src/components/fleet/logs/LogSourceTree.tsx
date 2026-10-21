'use client';

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Lock } from 'lucide-react';
import type { FleetLogSource } from '@ever-works/contracts';
import { relativeTime } from '../fleet-hub.shared';
import { groupLogSources, typedPathSourceId } from './logs.shared';

/**
 * Logs on computers (FL-08, spec §5.1, FR-1 … FR-10) — the source list: four
 * groups with their counts (System, Files by root, Containers, Services —
 * failed first), each source a button; a source that cannot be opened is
 * listed with its reason (`root only`, `needs administrator`) and is not a
 * button; under Files, **Open a file…** takes a typed path (FR-7: the machine
 * decides whether it is under a shared folder). A tree with arrow-key
 * movement between the buttons (spec §5.12).
 */
export function LogSourceTree({
    sources,
    selected,
    disabled,
    onSelect,
}: {
    sources: readonly FleetLogSource[];
    /** The open source(s) — one, or a merged set (P2). */
    selected: readonly string[];
    /** Permission denied (U4): every source greyed. */
    disabled?: boolean;
    /** `additive`: ctrl/cmd-click — add the source to (or remove it from) the merged view. */
    onSelect(id: string, additive: boolean): void;
}) {
    const t = useTranslations('fleet.logs');
    const locale = useLocale();
    const groups = groupLogSources(sources);
    const [closed, setClosed] = useState<Record<string, boolean>>({});
    const [typed, setTyped] = useState('');
    const [typedError, setTypedError] = useState(false);
    const now = new Date();

    const toggle = (group: string) => setClosed((value) => ({ ...value, [group]: !value[group] }));

    const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-log-source]:not([disabled])'),
        );
        const index = items.findIndex((item) => item === document.activeElement);
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        if (items[next]) {
            event.preventDefault();
            items[next].focus();
        }
    };

    const item = (source: FleetLogSource) => {
        const isSelected = selected.includes(source.id);
        const reason =
            source.unreadableReason === 'root-only'
                ? t('sources.rootOnly')
                : source.unreadableReason === 'needs-admin'
                  ? t('sources.needsAdmin')
                  : source.unreadableReason === 'gone'
                    ? t('sources.gone')
                    : null;
        const meta =
            source.kind === 'file'
                ? relativeTime(source.lastWrittenAt ?? null, now, locale)
                : source.state
                  ? source.state
                  : null;
        if (!source.readable || disabled) {
            return (
                <li key={source.id}>
                    <div
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded text-xs text-text-muted dark:text-text-muted-dark opacity-70"
                        title={source.hint ?? undefined}
                        data-testid="fleet-logs-source"
                        data-source={source.id}
                        aria-disabled="true"
                    >
                        <span className="truncate">{source.label}</span>
                        {reason && (
                            <span className="inline-flex items-center gap-1 shrink-0">
                                <Lock className="w-3 h-3" aria-hidden="true" />
                                {reason}
                            </span>
                        )}
                    </div>
                </li>
            );
        }
        return (
            <li key={source.id}>
                <button
                    type="button"
                    data-log-source
                    data-testid="fleet-logs-source"
                    data-source={source.id}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={(event) => onSelect(source.id, event.ctrlKey || event.metaKey)}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-xs transition-colors ${
                        isSelected
                            ? 'bg-primary/10 text-primary dark:text-primary-dark'
                            : 'text-text dark:text-text-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark'
                    }`}
                >
                    <span className="truncate font-mono">{source.label}</span>
                    <span
                        className={`shrink-0 ${
                            source.failed ? 'text-danger font-medium' : 'text-text-muted dark:text-text-muted-dark'
                        }`}
                    >
                        {source.failed ? `${meta ?? t('sources.failed')} ▲` : meta}
                    </span>
                </button>
            </li>
        );
    };

    const group = (id: string, label: string, count: number, body: ReactNode) => (
        <div key={id} className="space-y-1">
            <button
                type="button"
                onClick={() => toggle(id)}
                aria-expanded={!closed[id]}
                className="w-full flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
            >
                {closed[id] ? (
                    <ChevronRight className="w-3 h-3" aria-hidden="true" />
                ) : (
                    <ChevronDown className="w-3 h-3" aria-hidden="true" />
                )}
                {t('groups.withCount', { group: label, count })}
            </button>
            {!closed[id] && body}
        </div>
    );

    const openTyped = () => {
        const id = typedPathSourceId(typed);
        if (!id) {
            setTypedError(true);
            return;
        }
        setTypedError(false);
        onSelect(id, false);
    };

    return (
        <div
            role="group"
            aria-label={t('a11y.sources')}
            className="space-y-3"
            onKeyDown={onTreeKey}
            data-testid="fleet-logs-sources"
        >
            {group(
                'system',
                t('groups.system'),
                groups.system.length,
                <ul className="space-y-0.5">{groups.system.map(item)}</ul>,
            )}
            {group(
                'files',
                t('groups.files'),
                groups.fileCount,
                <div className="space-y-2">
                    {groups.files.map((root) => (
                        <div key={root.root} className="space-y-0.5">
                            <p className="px-2 text-[11px] text-text-muted dark:text-text-muted-dark truncate font-mono">
                                {root.root}
                            </p>
                            <ul className="space-y-0.5">{root.sources.map(item)}</ul>
                        </div>
                    ))}
                    {!disabled && (
                        <form
                            className="px-2 space-y-1"
                            onSubmit={(event) => {
                                event.preventDefault();
                                openTyped();
                            }}
                        >
                            <label className="sr-only" htmlFor="fleet-logs-open-path">
                                {t('sources.openFile')}
                            </label>
                            <input
                                id="fleet-logs-open-path"
                                value={typed}
                                onChange={(event) => {
                                    setTyped(event.target.value);
                                    setTypedError(false);
                                }}
                                placeholder={t('sources.openFilePlaceholder')}
                                className="w-full rounded border border-border dark:border-border-dark bg-transparent px-2 py-1 text-xs font-mono"
                                data-testid="fleet-logs-open-path"
                            />
                            {typedError && (
                                <p className="text-[11px] text-danger" role="alert">
                                    {t('sources.openFileNotAbsolute')}
                                </p>
                            )}
                        </form>
                    )}
                </div>,
            )}
            {group(
                'containers',
                t('groups.containers'),
                groups.containers.length,
                <ul className="space-y-0.5">{groups.containers.map(item)}</ul>,
            )}
            {group(
                'services',
                t('groups.services'),
                groups.services.length,
                <ul className="space-y-0.5">{groups.services.map(item)}</ul>,
            )}
        </div>
    );
}
