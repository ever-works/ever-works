'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Directory } from '@/lib/api/directory';
import { DirectoryList } from '@/components/directories/DirectoryList';
import { EmptyState } from '@/components/common/EmptyState';
import { ROUTES } from '@/lib/constants';
import { Link, useRouter } from '@/i18n/navigation';
import { getDirectories } from '@/app/actions/dashboard/directories';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface DirectoriesClientProps {
    initialDirectories: Directory[];
    totalDirectories: number;
}

export default function DirectoriesClient({
    initialDirectories,
    totalDirectories,
}: DirectoriesClientProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const t = useTranslations('dashboard.directories');
    const [directories, setDirectories] = useState<Directory[]>(initialDirectories);
    const [total, setTotal] = useState(totalDirectories);
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [page, setPage] = useState(1);
    const itemsPerPage = 20;
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Focus search input when navigating with ?focus=search
    useEffect(() => {
        if (searchParams.get('focus') === 'search' && searchInputRef.current) {
            searchInputRef.current.focus();
            // Clean up the URL without the focus param
            const url = new URL(window.location.href);
            url.searchParams.delete('focus');
            window.history.replaceState({}, '', url.toString());
        }
    }, [searchParams]);

    const handleSearch = async () => {
        setLoading(true);
        try {
            const response = await getDirectories({
                search: searchQuery,
                limit: itemsPerPage,
                offset: (page - 1) * itemsPerPage,
            });
            if (response.success) {
                setDirectories(response.directories);
                setTotal(response.total);
            }
        } catch (error) {
            console.error('Failed to search directories:', error);
        } finally {
            setLoading(false);
        }
    };

    const handlePageChange = async (newPage: number) => {
        setPage(newPage);
        setLoading(true);
        try {
            const response = await getDirectories({
                search: searchQuery,
                limit: itemsPerPage,
                offset: (newPage - 1) * itemsPerPage,
            });
            if (response.success) {
                setDirectories(response.directories);
                setTotal(response.total);
            }
        } catch (error) {
            console.error('Failed to fetch directories:', error);
        } finally {
            setLoading(false);
        }
    };

    const totalPages = Math.ceil(total / itemsPerPage);
    const hasDirectories = directories.length > 0;

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                    {t('subtitle')}
                </p>
            </div>

            {/* Search and Actions Bar */}
            <div className="flex flex-col sm:flex-row gap-4 mb-8">
                <div className="flex-1">
                    <div className="relative">
                        <input
                            ref={searchInputRef}
                            type="text"
                            placeholder={t('search')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                            className={cn(
                                'w-full px-4 py-2 pl-10 rounded-lg',
                                'bg-surface dark:bg-surface-dark',
                                'border border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                'focus:outline-none focus:ring-2 focus:ring-primary',
                            )}
                        />
                        <svg
                            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted dark:text-text-muted-dark"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                            />
                        </svg>
                    </div>
                </div>

                <Link
                    href={ROUTES.DASHBOARD_DIRECTORIES_NEW}
                    className={cn(
                        'px-6 py-2 rounded-lg font-medium transition-colors inline-flex items-center gap-2',
                        'bg-primary hover:bg-primary-hover text-white',
                    )}
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4v16m8-8H4"
                        />
                    </svg>
                    {t('create')}
                </Link>
            </div>

            {/* Directory Count */}
            {total > 0 && (
                <div className="mb-4 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('showing', { current: directories.length, total })}
                </div>
            )}

            {/* Directories List */}
            {loading ? (
                <div className="flex justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
            ) : hasDirectories ? (
                <>
                    <DirectoryList
                        initialDirectories={directories}
                        onUpdate={(updatedDirectories) => setDirectories(updatedDirectories)}
                    />

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="mt-8 flex justify-center">
                            <nav className="flex gap-2">
                                <button
                                    onClick={() => handlePageChange(page - 1)}
                                    disabled={page === 1}
                                    className={cn(
                                        'px-4 py-2 rounded-lg transition-colors',
                                        'border border-border dark:border-border-dark',
                                        page === 1
                                            ? 'text-text-muted dark:text-text-muted-dark cursor-not-allowed'
                                            : 'text-text dark:text-text-dark hover:bg-surface dark:hover:bg-surface-dark',
                                    )}
                                >
                                    {t('pagination.previous')}
                                </button>

                                {/* Page Numbers */}
                                <div className="flex gap-1">
                                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                        let pageNum;
                                        if (totalPages <= 5) {
                                            pageNum = i + 1;
                                        } else if (page <= 3) {
                                            pageNum = i + 1;
                                        } else if (page >= totalPages - 2) {
                                            pageNum = totalPages - 4 + i;
                                        } else {
                                            pageNum = page - 2 + i;
                                        }

                                        return (
                                            <button
                                                key={pageNum}
                                                onClick={() => handlePageChange(pageNum)}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg transition-colors',
                                                    pageNum === page
                                                        ? 'bg-primary text-white'
                                                        : 'text-text dark:text-text-dark hover:bg-surface dark:hover:bg-surface-dark',
                                                )}
                                            >
                                                {pageNum}
                                            </button>
                                        );
                                    })}
                                </div>

                                <button
                                    onClick={() => handlePageChange(page + 1)}
                                    disabled={page === totalPages}
                                    className={cn(
                                        'px-4 py-2 rounded-lg transition-colors',
                                        'border border-border dark:border-border-dark',
                                        page === totalPages
                                            ? 'text-text-muted dark:text-text-muted-dark cursor-not-allowed'
                                            : 'text-text dark:text-text-dark hover:bg-surface dark:hover:bg-surface-dark',
                                    )}
                                >
                                    {t('pagination.next')}
                                </button>
                            </nav>
                        </div>
                    )}
                </>
            ) : (
                <EmptyState
                    title={t('empty.notFound.title')}
                    description={
                        searchQuery
                            ? t('empty.notFound.withSearch')
                            : t('empty.notFound.withoutSearch')
                    }
                    action={{
                        label: t('empty.action'),
                        onClick: () => {
                            router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
                        },
                    }}
                />
            )}
        </div>
    );
}
