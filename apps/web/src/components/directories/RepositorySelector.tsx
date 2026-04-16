'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Loader2, Search, FolderGit2, Lock, RefreshCw } from 'lucide-react';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';
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
        <div className="flex items-center gap-2.5 px-3 py-3 border-b border-border dark:border-border-dark">
            <span className="text-[11px] text-text-muted dark:text-text-muted-dark shrink-0 select-none">
                {t('ownerLabel')}
            </span>
            <div className="h-3 w-px bg-border dark:bg-border-dark shrink-0" />
            <div className="flex-1">
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
        <div className="flex items-center gap-1.5 px-3 py-3 border-b border-border dark:border-border-dark">
            <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-text-muted dark:text-text-muted-dark pointer-events-none" />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                    className={cn(
                        'w-full pl-7 pr-3 py-2.5 rounded-lg text-xs',
                        'bg-surface/50 dark:bg-white/3',
                        'border border-border dark:border-border-dark',
                        'text-text dark:text-text-dark',
                        'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                        'focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40',
                        'transition-colors',
                    )}
                />
            </div>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                disabled={loading}
                className="w-7 h-7 p-0 shrink-0"
            >
                <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
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
    const slash = repo.full_name.indexOf('/');
    const ownerDisplay = slash >= 0 ? repo.full_name.slice(0, slash + 1) : '';
    const nameDisplay = slash >= 0 ? repo.full_name.slice(slash + 1) : repo.full_name;

    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'w-full cursor-pointer text-left transition-colors duration-100',
                'px-3 py-3 border-l-2',
                'border-b border-border dark:border-border-dark last:border-b-0',
                isSelected
                    ? 'border-l-primary bg-primary/6 dark:bg-white/6'
                    : 'border-l-transparent hover:bg-primary/4 dark:hover:bg-white/4',
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        {repo.private && (
                            <Lock className="w-3 h-3 text-text-muted dark:text-text-muted-dark shrink-0 mt-px" />
                        )}
                        <span className="text-xs truncate">
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {ownerDisplay}
                            </span>
                            <span className="font-medium text-text dark:text-text-dark">
                                {nameDisplay}
                            </span>
                        </span>
                    </div>
                    <p
                        className={cn(
                            'mt-1 text-[11px] leading-relaxed truncate',
                            repo.description
                                ? 'text-text-secondary dark:text-text-secondary-dark'
                                : 'italic text-text-muted/50 dark:text-text-muted-dark/40',
                        )}
                    >
                        {repo.description ?? 'No description'}
                    </p>
                </div>
                <time className="text-[11px] text-text-muted dark:text-text-muted-dark shrink-0 tabular-nums mt-0.5">
                    {formatDate(repo.updated_at)}
                </time>
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
            <div className="flex items-center justify-center py-10">
                <Loader2 className="w-4 h-4 text-text-muted dark:text-text-muted-dark animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="py-6 text-center">
                <p className="text-xs text-danger">{error}</p>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onRefresh}
                    className="mt-2 text-xs px-3 py-1.5 h-auto"
                >
                    {t('tryAgain')}
                </Button>
            </div>
        );
    }

    if (repositories.length === 0) {
        return (
            <div className="py-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
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
                <div className="px-3 py-3">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onLoadMore}
                        disabled={loading}
                        fullWidth
                        className="text-xs h-auto py-2.5 dark:bg-white/6"
                    >
                        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('loadMore')}
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
        <div className="rounded-xl border border-border dark:border-border-dark overflow-hidden">
            <Accordion type="single" collapsible defaultValue="repos">
                <AccordionItem value="repos" className="border-0">
                    <AccordionTrigger
                        className={cn(
                            'px-4 py-4 hover:no-underline',
                            'bg-card dark:bg-card-primary-dark',
                            'hover:bg-surface/50 dark:hover:bg-white/2',
                            'transition-colors duration-100',
                        )}
                    >
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-white/4 flex items-center justify-center shrink-0">
                                <FolderGit2
                                    className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark"
                                    strokeWidth={1.5}
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="text-sm font-medium text-text dark:text-text-dark leading-none">
                                    {t('title')}
                                </span>
                                {selectedRepo && (
                                    <span className="inline-block px-1.5 py-0.5 rounded text-[12px] font-mono bg-surface dark:bg-white/5 border border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark max-w-[320px] truncate">
                                        {selectedRepo.full_name}
                                    </span>
                                )}
                            </div>
                        </div>
                    </AccordionTrigger>

                    <AccordionContent className="p-0">
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

                            <div className="relative">
                                <div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-linear-to-b from-white dark:from-[#0a0a0a] to-transparent z-10" />
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
                                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-t from-white dark:from-[#0a0a0a] to-transparent z-10" />
                            </div>

                            {repositories.length > 0 && (
                                <div className="px-3 py-1.5 text-center border-t border-border dark:border-border-dark">
                                    <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                        {selectedOwner
                                            ? t('showingOrgRepos', { org: selectedOwner })
                                            : t('showingPersonalRepos')}
                                    </span>
                                </div>
                            )}
                        </div>
                    </AccordionContent>
                </AccordionItem>
            </Accordion>
        </div>
    );
}
