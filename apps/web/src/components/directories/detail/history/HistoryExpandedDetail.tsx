'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { TerminalLogViewer } from '../shared/TerminalLogViewer';
import type { DirectoryGenerationHistoryEntry } from '@/lib/api/types-only';

interface ChangeEntry {
    action: string;
    name: string;
    slug?: string;
    fieldsChanged?: string[];
}

interface HistoryExpandedDetailProps {
    entry: DirectoryGenerationHistoryEntry;
    addedEntries: ChangeEntry[];
    updatedEntries: ChangeEntry[];
    removedEntries: ChangeEntry[];
}

export function HistoryExpandedDetail({
    entry,
    addedEntries,
    updatedEntries,
    removedEntries,
}: HistoryExpandedDetailProps) {
    const t = useTranslations('dashboard.directoryDetail.history');
    const hasLogs = (entry.logs?.length ?? 0) > 0;
    const hasChanges =
        addedEntries.length > 0 || updatedEntries.length > 0 || removedEntries.length > 0;
    const totalChanges = addedEntries.length + updatedEntries.length + removedEntries.length;
    const [activeTab, setActiveTab] = useState<'logs' | 'changes'>(hasLogs ? 'logs' : 'changes');

    const tabs: Array<{ id: 'logs' | 'changes'; label: string }> = [];
    if (hasLogs) tabs.push({ id: 'logs', label: t('detail.stepLogs') });
    if (hasChanges) tabs.push({ id: 'changes', label: `${t('detail.changes')} (${totalChanges})` });

    if (tabs.length === 0) return null;

    return (
        <div>
            {tabs.length > 1 && (
                <div className="flex gap-1 mb-3">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
                                activeTab === tab.id
                                    ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                                    : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            )}

            {activeTab === 'logs' && hasLogs && (
                <TerminalLogViewer
                    logs={entry.logs!}
                    title={t('detail.stepLogs')}
                    maxHeight="max-h-60"
                />
            )}

            {activeTab === 'changes' && hasChanges && (
                <div className="grid gap-4 @lg/main:grid-cols-3">
                    <ChangeSection
                        label={t('detail.added')}
                        entries={addedEntries}
                        headingColor="text-success"
                        prefixColor="text-success"
                        prefix="+"
                    />
                    <ChangeSection
                        label={t('detail.updated')}
                        entries={updatedEntries}
                        headingColor="text-primary"
                        prefixColor="text-primary"
                        prefix="~"
                    />
                    <ChangeSection
                        label={t('detail.removed')}
                        entries={removedEntries}
                        headingColor="text-danger"
                        prefixColor="text-danger"
                        prefix="−"
                    />
                </div>
            )}
        </div>
    );
}

function ChangeSection({
    label,
    entries,
    headingColor,
    prefixColor,
    prefix,
}: {
    label: string;
    entries: ChangeEntry[];
    headingColor: string;
    prefixColor: string;
    prefix: string;
}) {
    const t = useTranslations('dashboard.directoryDetail.history');

    if (entries.length === 0) return null;

    return (
        <div>
            <p className={cn('mb-2 text-xs font-semibold uppercase tracking-wide', headingColor)}>
                {label} ({entries.length})
            </p>
            <ul className="space-y-1.5">
                {entries.map((change) => (
                    <li
                        key={`${change.action}-${change.slug ?? change.name}`}
                        className="flex items-baseline gap-1.5 text-xs"
                    >
                        <span className={cn('shrink-0 font-bold leading-none', prefixColor)}>
                            {prefix}
                        </span>
                        <span className="min-w-0">
                            <span className="font-medium text-text dark:text-text-dark">
                                {change.name}
                            </span>
                            {change.slug && (
                                <span className="ml-1 text-text-muted dark:text-text-muted-dark">
                                    /{change.slug}
                                </span>
                            )}
                            {change.fieldsChanged?.length ? (
                                <span className="ml-1 text-text-secondary dark:text-text-secondary-dark">
                                    — {change.fieldsChanged.join(', ')}
                                </span>
                            ) : null}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
