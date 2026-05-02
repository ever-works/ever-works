'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
    Combobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
} from '@headlessui/react';
import { AlertTriangle, Check, ChevronDown, FolderOpen, LoaderCircle, Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter as useTopLoaderRouter } from 'nextjs-toploader/app';
import { toast } from 'sonner';
import { getWorks, getWorkForStatusRefresh } from '@/app/actions/dashboard/works';
import { Work } from '@/lib/api/work';
import { GenerateStatusType } from '@/lib/api/enums';
import { getPathname, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import {
    getWorkIdFromPath,
    isWorkDetailPath,
    replaceWorkIdInPath,
} from '@/lib/utils/work-route';
import { ShinyText } from '@/components/ui/ShinyText';
import { useDashboardCurrentWork } from '@/lib/hooks/use-dashboard-current-work';

const WORK_SWITCHER_LIMIT = 1000;

const matchesWorkQuery = (work: Work, query: string): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return true;
    }

    return (
        work.name.toLowerCase().includes(normalizedQuery) ||
        work.slug.toLowerCase().includes(normalizedQuery)
    );
};

function upsertWork(works: Work[], nextWork: Work): Work[] {
    const existingIndex = works.findIndex((work) => work.id === nextWork.id);
    if (existingIndex === -1) {
        return [nextWork, ...works];
    }

    return works.map((work) =>
        work.id === nextWork.id ? nextWork : work,
    );
}

function mergeWorks(
    currentWorks: Work[],
    nextWorks: Work[],
): Work[] {
    const workById = new Map(currentWorks.map((work) => [work.id, work]));

    for (const work of nextWorks) {
        workById.set(work.id, work);
    }

    return Array.from(workById.values());
}

export function WorkSwitcher() {
    const pathname = usePathname();
    const router = useTopLoaderRouter();
    const searchParams = useSearchParams();
    const locale = useLocale();
    const t = useTranslations('dashboard.works');
    const tStatus = useTranslations('dashboard.workDetail.status');
    const [isNavigating, startNavigation] = useTransition();
    const [works, setWorks] = useState<Work[]>([]);
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const hasLoadedRef = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const routedWork = useDashboardCurrentWork();
    const deferredQuery = useDeferredValue(query);
    const isVisible = isWorkDetailPath(pathname);
    const currentWorkId = getWorkIdFromPath(pathname);

    const currentWork = useMemo(() => {
        const listedWork =
            works.find((work) => work.id === currentWorkId) ?? null;
        if (listedWork) {
            return listedWork;
        }

        return routedWork?.id === currentWorkId ? routedWork : null;
    }, [currentWorkId, works, routedWork]);

    const filteredWorks = useMemo(
        () => works.filter((work) => matchesWorkQuery(work, deferredQuery)),
        [deferredQuery, works],
    );
    const currentWorkStatus = useMemo(() => {
        if (!currentWork) {
            return null;
        }

        const hasWarnings = !!currentWork.generateStatus?.warnings?.length;
        const statusStyle = getGenerationStatusConfig(currentWork.generateStatus?.status, {
            hasWarnings,
        });
        const isGenerating = statusStyle.labelKey === 'generating';
        const isGeneratedWithWarnings = statusStyle.labelKey === 'generatedWithWarnings';
        const label = isGeneratedWithWarnings
            ? tStatus('generated')
            : tStatus(statusStyle.labelKey);

        return {
            ...statusStyle,
            label,
            isGenerating,
            isGeneratedWithWarnings,
        };
    }, [currentWork, tStatus]);

    useEffect(() => {
        inputRef.current?.blur();
    }, [currentWorkId]);

    useEffect(() => {
        if (!routedWork || routedWork.id !== currentWorkId) {
            return;
        }

        setWorks((currentWorks) =>
            upsertWork(currentWorks, routedWork),
        );
    }, [currentWorkId, routedWork]);

    useEffect(() => {
        if (!isVisible || !currentWorkId || currentWork) {
            return;
        }

        let isCancelled = false;

        const loadCurrentWork = async () => {
            try {
                const refreshedWork = await getWorkForStatusRefresh(currentWorkId);
                if (isCancelled || !refreshedWork) {
                    return;
                }

                setWorks((currentWorks) =>
                    upsertWork(currentWorks, refreshedWork),
                );
            } catch (error) {
                if (!isCancelled) {
                    console.error('Failed to load current Work for switcher:', error);
                }
            }
        };

        void loadCurrentWork();

        return () => {
            isCancelled = true;
        };
    }, [currentWork, currentWorkId, isVisible]);

    useEffect(() => {
        if (
            !isVisible ||
            !currentWorkId ||
            currentWork?.generateStatus?.status !== GenerateStatusType.GENERATING
        ) {
            return;
        }

        let isCancelled = false;
        let isRefreshing = false;

        const refreshCurrentWork = async () => {
            if (isRefreshing) {
                return;
            }

            isRefreshing = true;
            try {
                const refreshedWork = await getWorkForStatusRefresh(currentWorkId);
                if (isCancelled || !refreshedWork) {
                    return;
                }

                setWorks((currentWorks) =>
                    upsertWork(currentWorks, refreshedWork),
                );
            } finally {
                isRefreshing = false;
            }
        };

        void refreshCurrentWork();
        const interval = window.setInterval(refreshCurrentWork, 5_000);

        return () => {
            isCancelled = true;
            window.clearInterval(interval);
        };
    }, [currentWork?.generateStatus?.status, currentWorkId, isVisible]);

    useEffect(() => {
        if (!isVisible || hasLoadedRef.current) {
            return;
        }

        let isCancelled = false;

        const loadWorks = async () => {
            setIsLoading(true);

            try {
                const response = await getWorks({ limit: WORK_SWITCHER_LIMIT });
                if (isCancelled) {
                    return;
                }

                if (!response.success) {
                    toast.error(response.error || t('searchFailed'));
                    return;
                }

                setWorks((currentWorks) =>
                    mergeWorks(currentWorks, response.works),
                );
                hasLoadedRef.current = true;
            } catch (error) {
                if (!isCancelled) {
                    console.error('Failed to load Works for switcher:', error);
                    toast.error(t('searchFailed'));
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadWorks();

        return () => {
            isCancelled = true;
        };
    }, [isVisible, t]);

    if (!isVisible || !currentWorkId) {
        return null;
    }

    const handleWorkChange = (work: Work | null) => {
        if (!work || work.id === currentWorkId) {
            setQuery('');
            return;
        }

        const nextPathname = replaceWorkIdInPath(pathname, work.id);
        if (!nextPathname) {
            return;
        }

        const currentSearch = searchParams.toString();
        const nextUrl = currentSearch ? `${nextPathname}?${currentSearch}` : nextPathname;
        const localizedUrl = getPathname({ href: nextUrl, locale });

        setQuery('');
        inputRef.current?.blur();
        startNavigation(() => {
            router.replace(localizedUrl, { scroll: false });
        });
    };

    return (
        <div className="min-w-0 flex-1 max-w-xs sm:max-w-sm lg:max-w-md">
            <Combobox
                value={currentWork}
                onChange={handleWorkChange}
                disabled={isLoading}
            >
                <div className="relative">
                    <div
                        className={cn(
                            'flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2',
                            'border-border dark:border-border-dark',
                            'bg-surface dark:bg-surface-dark',
                            'transition-colors',
                            'focus-within:border-primary dark:focus-within:border-primary-dark',
                            'focus-within:ring-2 focus-within:ring-primary/15',
                            (isLoading || isNavigating) && 'opacity-80',
                        )}
                    >
                        {isLoading ? (
                            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-text-muted dark:text-text-muted-dark" />
                        ) : (
                            <Search className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark" />
                        )}

                        <ComboboxInput
                            ref={inputRef}
                            aria-label={t('search')}
                            className={cn(
                                'min-w-0 flex-1 bg-transparent text-xs outline-none',
                                'text-text dark:text-text-dark',
                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                            )}
                            displayValue={(work: Work | null) => work?.name ?? ''}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t('search')}
                        />

                        {currentWorkStatus && (
                            <WorkStatusBadge
                                className="shrink-0"
                                label={currentWorkStatus.label}
                                badgeClassName={currentWorkStatus.badge}
                                isGenerating={currentWorkStatus.isGenerating}
                                showWarningIcon={currentWorkStatus.isGeneratedWithWarnings}
                            />
                        )}

                        <ComboboxButton
                            className={cn(
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                                'text-text-muted dark:text-text-muted-dark',
                                'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                            )}
                        >
                            <ChevronDown className="h-4 w-4" />
                        </ComboboxButton>
                    </div>

                    <ComboboxOptions
                        className={cn(
                            'absolute left-0 top-full z-50 mt-2 w-full overflow-hidden rounded-xl border shadow-xl',
                            'border-border dark:border-border-dark',
                            'bg-white dark:bg-surface-dark',
                            'max-h-80 p-1',
                            'empty:invisible',
                        )}
                    >
                        <div className="max-h-78 overflow-y-auto">
                            {isLoading ? (
                                <div className="flex items-center gap-2 px-3 py-3 text-sm text-text-muted dark:text-text-muted-dark">
                                    <LoaderCircle className="h-4 w-4 animate-spin" />
                                    <span>{t('search')}</span>
                                </div>
                            ) : filteredWorks.length === 0 ? (
                                <div className="px-3 py-3 text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('empty.notFound.withSearch')}
                                </div>
                            ) : (
                                filteredWorks.map((work) => {
                                    const isCurrentWork = work.id === currentWorkId;
                                    const hasWarnings =
                                        !!work.generateStatus?.warnings?.length;
                                    const statusStyle = getGenerationStatusConfig(
                                        work.generateStatus?.status,
                                        { hasWarnings },
                                    );
                                    const statusLabel = tStatus(statusStyle.labelKey);

                                    const isItemGenerating = statusStyle.labelKey === 'generating';
                                    const isItemGeneratedWithWarnings =
                                        statusStyle.labelKey === 'generatedWithWarnings';
                                    const displayLabel = isItemGeneratedWithWarnings
                                        ? tStatus('generated')
                                        : statusLabel;

                                    return (
                                        <ComboboxOption
                                            key={work.id}
                                            value={work}
                                            disabled={isCurrentWork || isNavigating}
                                            className={({ active, disabled }) =>
                                                cn(
                                                    'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm',
                                                    'text-text dark:text-text-dark',
                                                    active &&
                                                        'bg-surface-hover dark:bg-surface-hover-dark',
                                                    disabled && 'cursor-default opacity-60',
                                                )
                                            }
                                        >
                                            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex min-w-0 items-center gap-2">
                                                        <FolderOpen className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark" />
                                                        <span className="truncate font-medium">
                                                            {work.name}
                                                        </span>
                                                    </div>
                                                    <div className="truncate pl-6 text-xs text-text-muted dark:text-text-muted-dark">
                                                        {work.slug}
                                                    </div>
                                                </div>

                                                <div className="flex shrink-0 items-center gap-2 self-center">
                                                    <WorkStatusBadge
                                                        label={displayLabel}
                                                        badgeClassName={statusStyle.badge}
                                                        isGenerating={isItemGenerating}
                                                        showWarningIcon={
                                                            isItemGeneratedWithWarnings
                                                        }
                                                    />

                                                    {isCurrentWork && (
                                                        <Check className="h-4 w-4 shrink-0 text-primary dark:text-primary-dark" />
                                                    )}
                                                </div>
                                            </div>
                                        </ComboboxOption>
                                    );
                                })
                            )}
                        </div>
                    </ComboboxOptions>
                </div>
            </Combobox>
        </div>
    );
}

function WorkStatusBadge({
    label,
    badgeClassName,
    isGenerating,
    showWarningIcon,
    className,
}: {
    label: string;
    badgeClassName: string;
    isGenerating: boolean;
    showWarningIcon: boolean;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-normal whitespace-nowrap',
                badgeClassName,
                isGenerating && 'animate-pulse',
                className,
            )}
        >
            {isGenerating ? <ShinyText text={label} /> : label}
            {showWarningIcon && <AlertTriangle className="h-3 w-3" />}
        </span>
    );
}
