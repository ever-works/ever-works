'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Select } from '@/components/ui/select';
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
} from 'lucide-react';
import { getUserRepositories } from '@/app/actions/dashboard/directories';
import { getGitProviderOrganizations } from '@/app/actions/dashboard/organizations';

interface Organization {
    id: string;
    login: string;
    name?: string;
    avatarUrl?: string;
}

export interface GitRepo {
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
    providerId: string;
    onSelect: (repo: GitRepo) => void;
    selectedUrl?: string;
}

// --- Sub-components ---

function OwnerFilter({
    selectedOwner,
    organizations,
    orgsLoading,
    onChange,
    t,
}: {
    selectedOwner: string | null;
    organizations: Organization[];
    orgsLoading: boolean;
    onChange: (owner: string | null) => void;
    t: ReturnType<typeof useTranslations>;
}) {
    return (
        <div className="p-3 border-b border-border dark:border-border-dark">
            <label className="block text-xs font-medium text-text-secondary dark:text-text-secondary-dark mb-1.5">
                {t('ownerLabel')}
            </label>
            <Select
                value={selectedOwner ?? '__personal__'}
                onValueChange={(val) => onChange(val === '__personal__' ? null : val)}
                disabled={orgsLoading}
                size="sm"
            >
                <option value="__personal__">{t('personalAccount')}</option>
                {organizations.length > 0 && (
                    <optgroup label={t('organizations')}>
                        {organizations.map((org) => (
                            <option key={org.id} value={org.login}>
                                {org.login}
                            </option>
                        ))}
                    </optgroup>
                )}
            </Select>
        </div>
    );
}

function SearchBar({
    search,
    loading,
    onSearch,
    onRefresh,
    t,
}: {
    search: string;
    loading: boolean;
    onSearch: (value: string) => void;
    onRefresh: () => void;
    t: ReturnType<typeof useTranslations>;
}) {
    return (
        <div className="p-3 flex gap-2 border-b border-border dark:border-border-dark">
            <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                    className={cn(
                        'w-full pl-9 pr-3 py-2 rounded-md text-sm',
                        'bg-white dark:bg-card-primary-dark',
                        'border border-card-border dark:border-white/9',
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
                onClick={onRefresh}
                disabled={loading}
                className="px-2"
            >
                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
        </div>
    );
}

function RepoItem({
    repo,
    isSelected,
    onSelect,
    formatDate,
}: {
    repo: GitRepo;
    isSelected: boolean;
    onSelect: () => void;
    formatDate: (dateStr: string) => string;
}) {
    return (
        <button
            key={`${repo.owner}/${repo.name}`}
            type="button"
            onClick={onSelect}
            className={cn(
                'w-full p-3 text-left transition-colors',
                'hover:bg-surface dark:hover:bg-surface-dark',
                'border-b border-border dark:border-border-dark last:border-b-0',
                isSelected && 'bg-primary/5',
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
                            {repo.full_name}
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
    );
}

function RepoList({
    repositories,
    loading,
    error,
    search,
    hasMore,
    selectedUrl,
    onSelect,
    onRefresh,
    onLoadMore,
    formatDate,
    t,
}: {
    repositories: GitRepo[];
    loading: boolean;
    error: string | null;
    search: string;
    hasMore: boolean;
    selectedUrl?: string;
    onSelect: (repo: GitRepo) => void;
    onRefresh: () => void;
    onLoadMore: () => void;
    formatDate: (dateStr: string) => string;
    t: ReturnType<typeof useTranslations>;
}) {
    if (loading && repositories.length === 0) {
        return (
            <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 text-center">
                <p className="text-error text-sm">{error}</p>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onRefresh}
                    className="mt-2"
                >
                    {t('tryAgain')}
                </Button>
            </div>
        );
    }

    if (repositories.length === 0) {
        return (
            <div className="p-4 text-center text-text-secondary dark:text-text-secondary-dark">
                {search ? t('noResults') : t('noRepositories')}
            </div>
        );
    }

    return (
        <>
            {repositories.map((repo) => (
                <RepoItem
                    key={`${repo.owner}/${repo.name}`}
                    repo={repo}
                    isSelected={selectedUrl === repo.html_url}
                    onSelect={() => onSelect(repo)}
                    formatDate={formatDate}
                />
            ))}
            {hasMore && (
                <div className="p-3">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onLoadMore}
                        disabled={loading}
                        fullWidth
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('loadMore')}
                    </Button>
                </div>
            )}
        </>
    );
}

// --- Main component ---

export function RepositorySelector({ providerId, onSelect, selectedUrl }: RepositorySelectorProps) {
    const [repositories, setRepositories] = useState<GitRepo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [expanded, setExpanded] = useState(true);
    const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [orgsLoading, setOrgsLoading] = useState(true);
    const requestIdRef = useRef(0);
    const t = useTranslations('dashboard.directoryCreation.import.repositorySelector');

    const perPage = 30;

    const fetchRepositories = useCallback(
        async (pageNum: number, searchQuery: string, owner: string | null, append = false) => {
            const currentRequestId = ++requestIdRef.current;
            setLoading(true);
            setError(null);

            try {
                const result = await getUserRepositories({
                    gitProvider: providerId,
                    page: pageNum,
                    perPage,
                    search: searchQuery || undefined,
                    owner: owner || undefined,
                    type: owner ? 'org' : 'user',
                });

                if (currentRequestId !== requestIdRef.current) return;

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
            } catch {
                if (currentRequestId !== requestIdRef.current) return;
                setError(t('errors.fetchFailed'));
            } finally {
                if (currentRequestId === requestIdRef.current) {
                    setLoading(false);
                }
            }
        },
        [providerId, t],
    );

    useEffect(() => {
        async function loadOrganizations() {
            setOrgsLoading(true);
            try {
                const result = await getGitProviderOrganizations(providerId);
                if (result.success) {
                    const orgs = result.organizations as Organization[];
                    setOrganizations(orgs);
                    // Default to first organization if available
                    if (orgs.length > 0) {
                        const firstOrg = orgs[0].login;
                        setSelectedOwner(firstOrg);
                        fetchRepositories(1, '', firstOrg);
                        return;
                    }
                }
            } catch {
                // Silently fail - user can still use personal repos
            } finally {
                setOrgsLoading(false);
            }
            // Fallback: fetch personal repos if no orgs
            fetchRepositories(1, '', null);
        }
        loadOrganizations();
    }, [providerId, fetchRepositories]);

    const handleSearch = (value: string) => {
        setSearch(value);
        setPage(1);
        fetchRepositories(1, value, selectedOwner);
    };

    const handleOwnerChange = (owner: string | null) => {
        setSelectedOwner(owner);
        setSearch('');
        setPage(1);
        setRepositories([]);
        fetchRepositories(1, '', owner);
    };

    const handleLoadMore = () => {
        const nextPage = page + 1;
        setPage(nextPage);
        fetchRepositories(nextPage, search, selectedOwner, true);
    };

    const handleRefresh = () => {
        setPage(1);
        fetchRepositories(1, search, selectedOwner);
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

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

            {expanded && (
                <div className="border-t border-border dark:border-border-dark">
                    <OwnerFilter
                        selectedOwner={selectedOwner}
                        organizations={organizations}
                        orgsLoading={orgsLoading}
                        onChange={handleOwnerChange}
                        t={t}
                    />

                    <SearchBar
                        search={search}
                        loading={loading}
                        onSearch={handleSearch}
                        onRefresh={handleRefresh}
                        t={t}
                    />

                    <div className="max-h-80 overflow-y-auto">
                        <RepoList
                            repositories={repositories}
                            loading={loading}
                            error={error}
                            search={search}
                            hasMore={hasMore}
                            selectedUrl={selectedUrl}
                            onSelect={onSelect}
                            onRefresh={handleRefresh}
                            onLoadMore={handleLoadMore}
                            formatDate={formatDate}
                            t={t}
                        />
                    </div>

                    {repositories.length > 0 && (
                        <div className="p-2 text-center border-t border-border dark:border-border-dark">
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {selectedOwner
                                    ? t('showingOrgRepos', { org: selectedOwner })
                                    : t('showingPersonalRepos')}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
