'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
    Combobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
} from '@headlessui/react';
import { Check, ChevronDown, FolderOpen, LoaderCircle, Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter as useTopLoaderRouter } from 'nextjs-toploader/app';
import { toast } from 'sonner';
import { getDirectories } from '@/app/actions/dashboard/directories';
import { Directory } from '@/lib/api/directory';
import { getPathname, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import {
    getDirectoryIdFromPath,
    isDirectoryDetailPath,
    replaceDirectoryIdInPath,
} from '@/lib/utils/directory-route';

const DIRECTORY_SWITCHER_LIMIT = 1000;

const matchesDirectoryQuery = (directory: Directory, query: string): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return true;
    }

    return (
        directory.name.toLowerCase().includes(normalizedQuery) ||
        directory.slug.toLowerCase().includes(normalizedQuery)
    );
};

export function DirectorySwitcher() {
    const pathname = usePathname();
    const router = useTopLoaderRouter();
    const searchParams = useSearchParams();
    const locale = useLocale();
    const t = useTranslations('dashboard.directories');
    const [isNavigating, startNavigation] = useTransition();
    const [directories, setDirectories] = useState<Directory[]>([]);
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const hasLoadedRef = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const deferredQuery = useDeferredValue(query);
    const isVisible = isDirectoryDetailPath(pathname);
    const currentDirectoryId = getDirectoryIdFromPath(pathname);

    const currentDirectory = useMemo(
        () => directories.find((directory) => directory.id === currentDirectoryId) ?? null,
        [currentDirectoryId, directories],
    );

    const filteredDirectories = useMemo(
        () => directories.filter((directory) => matchesDirectoryQuery(directory, deferredQuery)),
        [deferredQuery, directories],
    );

    useEffect(() => {
        inputRef.current?.blur();
    }, [currentDirectoryId]);

    useEffect(() => {
        if (!isVisible || hasLoadedRef.current) {
            return;
        }

        let isCancelled = false;

        const loadDirectories = async () => {
            setIsLoading(true);

            try {
                const response = await getDirectories({ limit: DIRECTORY_SWITCHER_LIMIT });
                if (isCancelled) {
                    return;
                }

                if (!response.success) {
                    toast.error(response.error || t('searchFailed'));
                    return;
                }

                setDirectories(response.directories);
                hasLoadedRef.current = true;
            } catch (error) {
                if (!isCancelled) {
                    console.error('Failed to load directories for switcher:', error);
                    toast.error(t('searchFailed'));
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadDirectories();

        return () => {
            isCancelled = true;
        };
    }, [isVisible, t]);

    if (!isVisible || !currentDirectoryId) {
        return null;
    }

    const handleDirectoryChange = (directory: Directory | null) => {
        if (!directory || directory.id === currentDirectoryId) {
            setQuery('');
            return;
        }

        const nextPathname = replaceDirectoryIdInPath(pathname, directory.id);
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
                value={currentDirectory}
                onChange={handleDirectoryChange}
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
                                'min-w-0 flex-1 bg-transparent text-sm outline-none',
                                'text-text dark:text-text-dark',
                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                            )}
                            displayValue={(directory: Directory | null) =>
                                directory?.name ?? currentDirectoryId.slice(0, 8)
                            }
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t('search')}
                        />

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
                            ) : filteredDirectories.length === 0 ? (
                                <div className="px-3 py-3 text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('empty.notFound.withSearch')}
                                </div>
                            ) : (
                                filteredDirectories.map((directory) => {
                                    const isCurrentDirectory = directory.id === currentDirectoryId;

                                    return (
                                        <ComboboxOption
                                            key={directory.id}
                                            value={directory}
                                            disabled={isCurrentDirectory || isNavigating}
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
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <FolderOpen className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark" />
                                                    <span className="truncate font-medium">
                                                        {directory.name}
                                                    </span>
                                                </div>
                                                <div className="truncate pl-6 text-xs text-text-muted dark:text-text-muted-dark">
                                                    {directory.slug}
                                                </div>
                                            </div>

                                            {isCurrentDirectory && (
                                                <Check className="h-4 w-4 shrink-0 text-primary dark:text-primary-dark" />
                                            )}
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
