'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DirectoryResponse } from '@/lib/api/directory';
import { cn } from '@/lib/utils/cn';

interface DirectoryListProps {
    onUpdate?: (directories: DirectoryResponse[]) => void;
}

export function DirectoryList({ onUpdate }: DirectoryListProps) {
    const [directories, setDirectories] = useState<DirectoryResponse[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchDirectories();
    }, []);

    const fetchDirectories = async () => {
        try {
            // TODO: Replace with actual API call using directoryAPI.getAll()
            // For now, using mock data
            const mockDirectories: DirectoryResponse[] = [
                {
                    id: '1',
                    slug: 'awesome-ai-tools',
                    name: 'Awesome AI Tools',
                    description: 'A curated list of the best AI tools and resources',
                    organization: false,
                    repo_provider: 'github' as any,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                },
                {
                    id: '2',
                    slug: 'tech-startups',
                    name: 'Tech Startups Directory',
                    description: 'Directory of innovative tech startups worldwide',
                    organization: false,
                    repo_provider: 'github' as any,
                    created_at: new Date(Date.now() - 86400000).toISOString(),
                    updated_at: new Date(Date.now() - 86400000).toISOString()
                }
            ];
            setDirectories(mockDirectories);
            onUpdate?.(mockDirectories);
        } catch (error) {
            console.error('Failed to fetch directories:', error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return <DirectoryListSkeleton />;
    }

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">Your Directories</h2>
                <Link
                    href="/dashboard/directories/new"
                    className={cn(
                        "px-4 py-2 rounded-lg font-medium transition-colors",
                        "bg-primary hover:bg-primary-hover text-white"
                    )}
                >
                    Create Directory
                </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {directories.map((directory) => (
                    <DirectoryCard key={directory.id} directory={directory} />
                ))}
            </div>
        </div>
    );
}

function DirectoryCard({ directory }: { directory: DirectoryResponse }) {
    return (
        <div className={cn(
            "rounded-lg p-6 transition-shadow hover:shadow-lg",
            "bg-card dark:bg-card-dark",
            "border border-card-border dark:border-card-border-dark"
        )}>
            <div className="flex justify-between items-start mb-4">
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {directory.name}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        /{directory.slug}
                    </p>
                </div>
                <div className="flex gap-2">
                    <button className={cn(
                        "p-2",
                        "text-text-secondary dark:text-text-secondary-dark",
                        "hover:text-text dark:hover:text-text-dark"
                    )}>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                    <button className={cn(
                        "p-2",
                        "text-text-secondary dark:text-text-secondary-dark hover:text-danger"
                    )}>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            </div>

            <p className={cn(
                "text-sm mb-4 line-clamp-2",
                "text-text-secondary dark:text-text-secondary-dark"
            )}>
                {directory.description}
            </p>

            <div className="flex items-center justify-between">
                <div className="flex gap-4 text-sm text-text-muted dark:text-text-muted-dark">
                    <span className="flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        24 items
                    </span>
                    <span className="flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        1.2k views
                    </span>
                </div>
                <Link
                    href={`/dashboard/directories/${directory.id}`}
                    className={cn(
                        "text-sm font-medium",
                        "text-primary hover:text-primary-hover"
                    )}
                >
                    View Details →
                </Link>
            </div>
        </div>
    );
}

function DirectoryListSkeleton() {
    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <div className="h-8 w-48 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                <div className="h-10 w-32 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[1, 2].map((i) => (
                    <div key={i} className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-6">
                        <div className="h-6 w-3/4 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-2"></div>
                        <div className="h-4 w-1/2 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-4"></div>
                        <div className="h-4 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-2"></div>
                        <div className="h-4 w-5/6 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse mb-4"></div>
                        <div className="flex justify-between">
                            <div className="h-4 w-24 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                            <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded animate-pulse"></div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}