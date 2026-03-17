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
<<<<<<< feature/directory-details-ui
import { Select } from '@/components/ui/select';
=======
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
>>>>>>> develop
import { fetchDirectoryGenerationHistory } from '@/app/actions/dashboard/directories';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface DirectoryHistoryPageClientProps {
    directoryId: string;
    initialHistory: DirectoryGenerationHistoryResponse | null;
}

type HistoryActivityFilter =
    | 'all'
    | 'generation'
    | 'items'
    | 'comparisons'
    | 'taxonomy'
    | 'community_pr';

type CachedHistoryPage = {
    entries: DirectoryGenerationHistoryEntry[];
    total: number;
    limit: number;
};

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
    const [limit, setLimit] = useState(initialHistory?.limit ?? 10);
    const [currentPage, setCurrentPage] = useState(1);
    const [activityFilter, setActivityFilter] = useState<HistoryActivityFilter>('all');
    const [pageCache, setPageCache] = useState<Record<string, CachedHistoryPage>>(
        initialHistory?.history
            ? {
                  'all:1': {
                      entries: initialHistory.history,
                      total: initialHistory.total,
                      limit: initialHistory.limit,
                  },
              }
            : {},
    );
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        if (initialHistory) {
            setEntries(initialHistory.history);
            setTotal(initialHistory.total);
            setLimit(initialHistory.limit);
            setCurrentPage(1);
            setActivityFilter('all');
            setPageCache(
                initialHistory.history
                    ? {
                          'all:1': {
                              entries: initialHistory.history,
                              total: initialHistory.total,
                              limit: initialHistory.limit,
                          },
                      }
                    : {},
            );
        }
    }, [initialHistory]);

    const totalPages = useMemo(() => {
        if (total <= 0) {
            return 1;
        }

        return Math.max(1, Math.ceil(total / limit));
    }, [limit, total]);

    const getCacheKey = (filter: HistoryActivityFilter, page: number) => `${filter}:${page}`;

    const loadPage = (page: number, filter: HistoryActivityFilter = activityFilter) => {
        if (page < 1 || page > totalPages || isPending) {
            return;
        }

        const cacheKey = getCacheKey(filter, page);
        const cachedPage = pageCache[cacheKey];
        if (cachedPage) {
            setCurrentPage(page);
            setEntries(cachedPage.entries);
            setTotal(cachedPage.total);
            setLimit(cachedPage.limit);
            return;
        }

        startTransition(async () => {
            const result = await fetchDirectoryGenerationHistory(directoryId, {
                limit,
                offset: (page - 1) * limit,
                activityType: filter === 'all' ? undefined : filter,
            });

            if (!result.success || !result.data?.history) {
                console.error('Failed to load history page', result.error);
                toast.error(t('error') ?? 'Failed to load history');
                return;
            }

            const payload = result.data;
            const nextEntries = payload.history ?? [];

            setEntries(nextEntries);
            setTotal(payload.total ?? 0);
            setLimit(payload.limit ?? limit);
            setCurrentPage(page);
            setPageCache((prev) => ({
                ...prev,
                [cacheKey]: {
                    entries: nextEntries,
                    total: payload.total ?? 0,
                    limit: payload.limit ?? limit,
                },
            }));
        });
    };

    const handleFilterChange = (value: string) => {
        const nextFilter = value as HistoryActivityFilter;
        setActivityFilter(nextFilter);
        setCurrentPage(1);

        const cacheKey = getCacheKey(nextFilter, 1);
        const cachedPage = pageCache[cacheKey];
        if (cachedPage) {
            setEntries(cachedPage.entries);
            setTotal(cachedPage.total);
            setLimit(cachedPage.limit);
            return;
        }

        startTransition(async () => {
            const result = await fetchDirectoryGenerationHistory(directoryId, {
                limit,
                offset: 0,
                activityType: nextFilter === 'all' ? undefined : nextFilter,
            });

            if (!result.success || !result.data?.history) {
                console.error('Failed to load filtered history', result.error);
                toast.error(t('error') ?? 'Failed to load history');
                return;
            }

            const payload = result.data;
            const nextEntries = payload.history ?? [];

            setEntries(nextEntries);
            setTotal(payload.total ?? 0);
            setLimit(payload.limit ?? limit);
            setPageCache((prev) => ({
                ...prev,
                [cacheKey]: {
                    entries: nextEntries,
                    total: payload.total ?? 0,
                    limit: payload.limit ?? limit,
                },
            }));
        });
    };

    const showingFrom = entries.length === 0 ? 0 : (currentPage - 1) * limit + 1;
    const showingTo = entries.length === 0 ? 0 : (currentPage - 1) * limit + entries.length;

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

            <div className="max-w-xs">
                <select
                    value={activityFilter}
                    onChange={(e) => handleFilterChange(e.target.value)}
                    aria-label={t('filters.label')}
                >
                    <option value="all">{t('filters.all')}</option>
                    <option value="generation">{t('filters.generation')}</option>
                    <option value="items">{t('filters.items')}</option>
                    <option value="comparisons">{t('filters.comparisons')}</option>
                    <option value="taxonomy">{t('filters.taxonomy')}</option>
                    <option value="community_pr">{t('filters.community_pr')}</option>
                </select>
            </div>

            {entries.length === 0 ? (
                <HistoryEmptyState />
            ) : (
                <>
                    <HistoryTable entries={entries} locale={locale} />
                    {total > limit && (
                        <div className="flex items-center justify-between">
                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {t('pagination.showing', {
                                    from: showingFrom,
                                    to: showingTo,
                                    total,
                                })}
                            </p>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => loadPage(currentPage - 1)}
                                    disabled={currentPage <= 1 || isPending}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {currentPage} / {totalPages}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => loadPage(currentPage + 1)}
                                    disabled={currentPage >= totalPages || isPending}
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
