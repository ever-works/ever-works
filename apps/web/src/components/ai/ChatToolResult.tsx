'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { ExternalLink, FolderOpen, GitBranch, BarChart3, Compass } from 'lucide-react';

interface ToolResultProps {
    toolName: string;
    state: string;
    result?: unknown;
}

export function ChatToolResult({ toolName, state, result }: ToolResultProps) {
    const t = useTranslations('dashboard.aiChat');
    const router = useRouter();

    // Auto-navigate when navigate tool completes
    useEffect(() => {
        if (toolName === 'navigate' && state === 'result' && result) {
            const data = result as { url?: string; action?: string };
            if (data.action === 'navigate' && data.url) {
                router.push(data.url);
            }
        }
    }, [toolName, state, result, router]);

    if (state !== 'result') {
        return (
            <div className="flex items-center gap-2 mt-1.5 px-2.5 py-2 rounded-lg bg-surface-secondary/60 dark:bg-white/[0.03] text-[11px] text-text-muted dark:text-text-muted-dark">
                <ToolIcon name={toolName} />
                <span>{t('thinking')}</span>
            </div>
        );
    }

    // Render different result UIs based on tool
    switch (toolName) {
        case 'listDirectories':
            return <DirectoryListResult result={result} />;
        case 'getDirectoryDetails':
            return <DirectoryDetailResult result={result} />;
        case 'checkGitConnection':
            return <GitConnectionResult result={result} />;
        case 'navigate':
            return null; // Navigation handled by useEffect above
        case 'getDirectoryStats':
            return <StatsResult result={result} />;
        default:
            return null;
    }
}

function ToolIcon({ name }: { name: string }) {
    const cls = 'w-3 h-3 animate-pulse';
    switch (name) {
        case 'listDirectories':
        case 'getDirectoryDetails':
            return <FolderOpen className={cls} />;
        case 'checkGitConnection':
            return <GitBranch className={cls} />;
        case 'getDirectoryStats':
            return <BarChart3 className={cls} />;
        case 'navigate':
            return <Compass className={cls} />;
        default:
            return <Compass className={cls} />;
    }
}

function DirectoryListResult({ result }: { result: unknown }) {
    const data = result as {
        directories?: Array<{
            id: string;
            name: string;
            slug: string;
            itemsCount: number;
            status: string;
            url: string;
        }>;
        total?: number;
    };
    if (!data?.directories?.length) return null;

    return (
        <div className="mt-1.5 space-y-1">
            {data.directories.map((dir) => (
                <a
                    key={dir.id}
                    href={dir.url}
                    className={cn(
                        'flex items-center justify-between px-2.5 py-2 rounded-lg text-xs',
                        'bg-surface-secondary/60 dark:bg-white/[0.03]',
                        'hover:bg-surface-tertiary/60 dark:hover:bg-white/[0.06]',
                        'text-text dark:text-text-dark transition-colors',
                    )}
                >
                    <div className="flex items-center gap-2">
                        <FolderOpen className="w-3.5 h-3.5 text-primary dark:text-primary-400" />
                        <span className="font-medium">{dir.name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-text-muted dark:text-text-muted-dark">
                        <span>{dir.itemsCount} items</span>
                        <ExternalLink className="w-3 h-3" />
                    </div>
                </a>
            ))}
        </div>
    );
}

function DirectoryDetailResult({ result }: { result: unknown }) {
    const data = result as {
        name?: string;
        description?: string;
        itemsCount?: number;
        status?: string;
        url?: string;
    };
    if (!data?.name) return null;

    return (
        <a
            href={data.url}
            className={cn(
                'flex items-center justify-between mt-1.5 px-2.5 py-2 rounded-lg text-xs',
                'bg-surface-secondary/60 dark:bg-white/[0.03]',
                'hover:bg-surface-tertiary/60 dark:hover:bg-white/[0.06]',
                'text-text dark:text-text-dark transition-colors',
            )}
        >
            <div className="flex items-center gap-2">
                <FolderOpen className="w-3.5 h-3.5 text-primary dark:text-primary-400" />
                <div>
                    <span className="font-medium">{data.name}</span>
                    {data.description && (
                        <p className="text-[10px] text-text-muted dark:text-text-muted-dark mt-0.5 line-clamp-1">
                            {data.description}
                        </p>
                    )}
                </div>
            </div>
            <ExternalLink className="w-3 h-3 text-text-muted" />
        </a>
    );
}

function GitConnectionResult({ result }: { result: unknown }) {
    const data = result as {
        connected?: boolean;
        username?: string;
        providerId?: string;
        setupUrl?: string;
    };
    if (!data) return null;

    return (
        <div
            className={cn(
                'flex items-center gap-2 mt-1.5 px-2.5 py-2 rounded-lg text-xs',
                data.connected ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
            )}
        >
            <GitBranch className="w-3.5 h-3.5" />
            {data.connected ? (
                <span>
                    Connected as <strong>{data.username}</strong>
                </span>
            ) : (
                <a href={data.setupUrl} className="underline">
                    Connect your git provider to continue
                </a>
            )}
        </div>
    );
}

function StatsResult({ result }: { result: unknown }) {
    const data = result as {
        totalDirectories?: number;
        totalItems?: number;
        activeWebsites?: number;
    };
    if (!data) return null;

    return (
        <div className="flex gap-3 mt-1.5">
            {[
                { label: 'Directories', value: data.totalDirectories ?? 0 },
                { label: 'Items', value: data.totalItems ?? 0 },
                { label: 'Websites', value: data.activeWebsites ?? 0 },
            ].map((stat) => (
                <div
                    key={stat.label}
                    className="flex-1 px-2.5 py-2 rounded-lg bg-surface-secondary/60 dark:bg-white/[0.03] text-center"
                >
                    <p className="text-sm font-semibold text-text dark:text-white">{stat.value}</p>
                    <p className="text-[10px] text-text-muted dark:text-text-muted-dark">
                        {stat.label}
                    </p>
                </div>
            ))}
        </div>
    );
}
