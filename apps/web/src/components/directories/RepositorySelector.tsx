'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
    Loader2,
    Search,
    FolderGit2,
    Lock,
    Globe,
    ChevronDown,
    ChevronUp,
    RefreshCw,
    Building2,
    User,
} from 'lucide-react';
import { getUserRepositories } from '@/app/actions/dashboard/directories';
import { getGitHubOrganizations } from '@/app/actions/dashboard/organizations';
import { GitHubOrganization } from '@/lib/api';

export interface GitHubRepo {
    id: number;
    name: string;
    full_name: string;
    owner: string;
    description: string | null;
    html_url: string;
    private: boolean;
    updated_at: string;
    default_branch: string;
}

interface RepositorySelectorProps {
    authId: string;
    onSelect: (repo: GitHubRepo) => void;
    selectedUrl?: string;
}

export function RepositorySelector({ onSelect, selectedUrl }: RepositorySelectorProps) {
    const [repositories, setRepositories] = useState<GitHubRepo[]>([]);
    const [organizations, setOrganizations] = useState<GitHubOrganization[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingOrgs, setLoadingOrgs] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [expanded, setExpanded] = useState(true);
    const [selectedOwner, setSelectedOwner] = useState<string>('');
    const [ownerType, setOwnerType] = useState<'user' | 'org'>('user');
    const t = useTranslations('dashboard.directoryCreation.import.repositorySelector');

    const perPage = 30;

    // Use ref to track the current owner for request cancellation
    const currentRequestRef = useRef<number>(0);

    // Fetch organizations on mount
    useEffect(() => {
        const loadOrganizations = async () => {
            setLoadingOrgs(true);
            try {
                const result = await getGitHubOrganizations();
                if (result.success && result.organizations) {
                    setOrganizations(result.organizations);
                }
            } catch (err) {
                console.error('Failed to load organizations:', err);
            } finally {
                setLoadingOrgs(false);
            }
        };
        loadOrganizations();
    }, []);

    // Fetch repositories with explicit owner/type parameters
    const fetchRepositories = useCallback(
        async (
            pageNum: number,
            searchQuery: string,
            owner: string,
            type: 'user' | 'org',
            append = false,
        ) => {
            const requestId = ++currentRequestRef.current;

            setLoading(true);
            setError(null);

            const params = {
                page: pageNum,
                perPage,
                search: searchQuery || undefined,
                owner: owner || undefined,
                type: type,
            };

            try {
                const result = await getUserRepositories(params);

                // Check if this request is still the current one
                if (requestId !== currentRequestRef.current) {
                    return;
                }

                if (result.success && result.data) {
                    if (append) {
                        setRepositories((prev) => [...prev, ...result.data!.repositories]);
                    } else {
                        setRepositories(result.data.repositories);
                    }
                    setHasMore(result.data.hasMore);
                } else {
                    setError(result.error || t('errors.fetchFailed'));
                }
            } catch (err) {
                if (requestId === currentRequestRef.current) {
                    setError(t('errors.fetchFailed'));
                }
            } finally {
                if (requestId === currentRequestRef.current) {
                    setLoading(false);
                }
            }
        },
        [t],
    );

    // Fetch repositories on mount and when owner changes
    useEffect(() => {
        setPage(1);
        setSearch('');
        fetchRepositories(1, '', selectedOwner, ownerType);
    }, [selectedOwner, ownerType, fetchRepositories]);

    const handleSearch = (value: string) => {
        setSearch(value);
        setPage(1);
        fetchRepositories(1, value, selectedOwner, ownerType);
    };

    const handleLoadMore = () => {
        const nextPage = page + 1;
        setPage(nextPage);
        fetchRepositories(nextPage, search, selectedOwner, ownerType, true);
    };

    const handleRefresh = () => {
        setPage(1);
        fetchRepositories(1, search, selectedOwner, ownerType);
    };

    const handleOwnerChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        if (value === '') {
            setSelectedOwner('');
            setOwnerType('user');
        } else {
            setSelectedOwner(value);
            setOwnerType('org');
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return t('today');
        if (diffDays === 1) return t('yesterday');
        if (diffDays < 7) return t('daysAgo', { days: diffDays });
        if (diffDays < 30) return t('weeksAgo', { weeks: Math.floor(diffDays / 7) });
        return date.toLocaleDateString();
    };

    const selectedRepo = repositories.find((r) => r.html_url === selectedUrl);

    return (
        <div
            className={cn(
                'rounded-lg',
                'border border-border dark:border-border-dark',
                'overflow-hidden',
            )}
        >
            {/* Header */}
            <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className={cn(
                    'w-full p-4 flex items-center justify-between',
                    'bg-surface dark:bg-surface-dark',
                    'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                    'transition-colors',
                )}
            >
                <div className="flex items-center gap-3">
                    <FolderGit2 className="w-5 h-5 text-primary" />
                    <div className="text-left">
                        <h4 className="font-medium text-text dark:text-text-dark">{t('title')}</h4>
                        {selectedRepo && (
                            <p className="text-sm text-primary">{selectedRepo.full_name}</p>
                        )}
                    </div>
                </div>
                {expanded ? (
                    <ChevronUp className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                ) : (
                    <ChevronDown className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                )}
            </button>

            {/* Content */}
            {expanded && (
                <div className="border-t border-border dark:border-border-dark">
                    {/* Owner Selector */}
                    <div className="p-3 border-b border-border dark:border-border-dark">
                        <label
                            htmlFor="repo-owner-select"
                            className="block text-xs font-medium text-text-secondary dark:text-text-secondary-dark mb-2"
                        >
                            {t('ownerLabel')}
                        </label>
                        <div className="flex items-center gap-2">
                            <select
                                id="repo-owner-select"
                                value={selectedOwner}
                                onChange={handleOwnerChange}
                                disabled={loadingOrgs}
                                className={cn(
                                    'flex-1 px-3 py-2 rounded-md text-sm',
                                    'bg-card dark:bg-card-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'focus:outline-none focus:ring-2 focus:ring-primary/50',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                <option value="">{t('personalAccount')}</option>
                                {organizations.length > 0 && (
                                    <optgroup label={t('organizations')}>
                                        {organizations.map((org) => (
                                            <option key={org.login} value={org.login}>
                                                {org.login}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                            {loadingOrgs && (
                                <Loader2 className="w-4 h-4 text-text-muted animate-spin" />
                            )}
                        </div>
                        {/* Visual indicator of current selection */}
                        <div
                            className={cn(
                                'flex items-center gap-2 px-2 py-1.5 mt-2 rounded',
                                'bg-surface-secondary dark:bg-surface-secondary-dark',
                            )}
                        >
                            {selectedOwner === '' ? (
                                <>
                                    <User className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                                    <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {t('showingPersonalRepos')}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <Building2 className="w-3.5 h-3.5 text-primary dark:text-primary-dark" />
                                    <span className="text-xs text-text dark:text-text-dark">
                                        {t('showingOrgRepos', { org: selectedOwner })}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Search and Refresh */}
                    <div className="p-3 flex gap-2 border-b border-border dark:border-border-dark">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => handleSearch(e.target.value)}
                                placeholder={t('searchPlaceholder')}
                                className={cn(
                                    'w-full pl-9 pr-3 py-2 rounded-md text-sm',
                                    'bg-card dark:bg-card-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                    'focus:outline-none focus:ring-2 focus:ring-primary/50',
                                )}
                            />
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handleRefresh}
                            disabled={loading}
                            className="px-2"
                        >
                            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                        </Button>
                    </div>

                    {/* Repository List */}
                    <div className="max-h-80 overflow-y-auto">
                        {loading && repositories.length === 0 ? (
                            <div className="flex items-center justify-center py-8">
                                <Loader2 className="w-6 h-6 text-primary animate-spin" />
                            </div>
                        ) : error ? (
                            <div className="p-4 text-center">
                                <p className="text-error text-sm">{error}</p>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleRefresh}
                                    className="mt-2"
                                >
                                    {t('tryAgain')}
                                </Button>
                            </div>
                        ) : repositories.length === 0 ? (
                            <div className="p-4 text-center text-text-secondary dark:text-text-secondary-dark">
                                {search ? t('noResults') : t('noRepositories')}
                            </div>
                        ) : (
                            <>
                                {repositories.map((repo) => (
                                    <button
                                        key={repo.id}
                                        type="button"
                                        onClick={() => onSelect(repo)}
                                        className={cn(
                                            'w-full p-3 text-left transition-colors',
                                            'hover:bg-surface dark:hover:bg-surface-dark',
                                            'border-b border-border dark:border-border-dark last:border-b-0',
                                            selectedUrl === repo.html_url && 'bg-primary/5',
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    {repo.private ? (
                                                        <Lock className="w-4 h-4 text-warning shrink-0" />
                                                    ) : (
                                                        <Globe className="w-4 h-4 text-success shrink-0" />
                                                    )}
                                                    <span className="font-medium text-text dark:text-text-dark">
                                                        <span className="text-text-muted dark:text-text-muted-dark">
                                                            {repo.owner}/
                                                        </span>
                                                        {repo.name}
                                                    </span>
                                                </div>
                                                {repo.description && (
                                                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-1">
                                                        {repo.description}
                                                    </p>
                                                )}
                                            </div>
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                                                {formatDate(repo.updated_at)}
                                            </span>
                                        </div>
                                    </button>
                                ))}

                                {/* Load More */}
                                {hasMore && (
                                    <div className="p-3">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={handleLoadMore}
                                            disabled={loading}
                                            fullWidth
                                        >
                                            {loading ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                t('loadMore')
                                            )}
                                        </Button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    {repositories.length > 0 && (
                        <div className="p-2 text-center border-t border-border dark:border-border-dark">
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {repositories.length} {t('repositoriesLoaded')}
                                {selectedOwner && ` from ${selectedOwner}`}
                                {hasMore && ` (${t('moreAvailable')})`}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
