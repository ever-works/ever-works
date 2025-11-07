'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
    DirectoryGenerationHistoryEntry,
    DirectoryGenerationHistoryResponse,
} from '@/lib/api/types-only';
import { HistoryTable } from './HistoryTable';
import { HistoryEmptyState } from './HistoryEmptyState';
import { Button } from '@/components/ui/button';
import { fetchDirectoryGenerationHistory } from '@/app/actions/dashboard/directories';
import { toast } from 'sonner';

interface DirectoryHistoryPageClientProps {
    directoryId: string;
    initialHistory: DirectoryGenerationHistoryResponse | null;
}

export function DirectoryHistoryPageClient({
    directoryId,
    initialHistory,
}: DirectoryHistoryPageClientProps) {
    const t = useTranslations('dashboard.directoryDetail.history');
    const locale = useLocale();

    const [entries, setEntries] = useState<DirectoryGenerationHistoryEntry[]>(
        initialHistory?.history ?? [],
    );
    const [total, setTotal] = useState(initialHistory?.total ?? 0);
    const [limit, setLimit] = useState(initialHistory?.limit ?? 20);
    const [offset, setOffset] = useState(
        (initialHistory?.offset ?? 0) + (initialHistory?.history?.length ?? 0),
    );
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        if (initialHistory) {
            setEntries(initialHistory.history);
            setTotal(initialHistory.total);
            setLimit(initialHistory.limit);
            setOffset((initialHistory.offset ?? 0) + (initialHistory.history?.length ?? 0));
        }
    }, [initialHistory]);

    const hasMore = useMemo(() => entries.length < total, [entries.length, total]);

    const loadMore = () => {
        if (!hasMore || isPending) {
            return;
        }

        startTransition(async () => {
            const result = await fetchDirectoryGenerationHistory(directoryId, {
                limit,
                offset,
            });

            if (!result.success || !result.data?.history) {
                console.error('Failed to load more history entries', result.error);
                toast.error(t('error') ?? 'Failed to load history');
                return;
            }

            const payload = result.data;

            setEntries((prev) => [...prev, ...(payload.history ?? [])]);
            setTotal(payload.total ?? 0);
            setLimit(payload.limit ?? limit);
            setOffset((prev) => prev + (payload.history?.length ?? 0));
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
                <p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                    {t('subtitle')}
                </p>
            </div>

            {entries.length === 0 ? (
                <HistoryEmptyState />
            ) : (
                <HistoryTable entries={entries} locale={locale} />
            )}

            {hasMore && entries.length > 0 && (
                <div className="flex justify-center">
                    <Button onClick={loadMore} disabled={isPending} variant="secondary">
                        {isPending ? `${t('loadMore')}…` : t('loadMore')}
                    </Button>
                </div>
            )}
        </div>
    );
}
