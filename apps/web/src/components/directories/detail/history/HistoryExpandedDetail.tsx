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
                        color="text-success"
                    />
                    <ChangeSection
                        label={t('detail.updated')}
                        entries={updatedEntries}
                        color="text-primary"
                    />
                    <ChangeSection
                        label={t('detail.removed')}
                        entries={removedEntries}
                        color="text-danger"
                    />
                </div>
            )}
        </div>
    );
}

function ChangeSection({
    label,
    entries,
    color,
}: {
    label: string;
    entries: ChangeEntry[];
    color: string;
}) {
    const t = useTranslations('dashboard.directoryDetail.history');

    if (entries.length === 0) return null;

    return (
        <div>
            <p className={cn('mb-2 text-xs font-semibold uppercase tracking-wide', color)}>
                {label} ({entries.length})
            </p>
            <div className="space-y-1">
                {entries.map((change) => (
                    <div
                        key={`${change.action}-${change.slug ?? change.name}`}
                        className="rounded-md border border-border bg-background px-3 py-2 text-sm dark:border-border-dark dark:bg-background-dark"
                    >
                        <div className="font-medium text-text dark:text-text-dark">
                            {change.name}
                        </div>
                        {change.slug && (
                            <div className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {change.slug}
                            </div>
                        )}
                        {change.fieldsChanged?.length ? (
                            <div className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('detail.fields')}: {change.fieldsChanged.join(', ')}
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
