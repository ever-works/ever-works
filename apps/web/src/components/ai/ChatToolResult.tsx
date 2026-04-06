'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { getPathname, Link, usePathname } from '@/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'nextjs-toploader/app';
import { cn } from '@/lib/utils/cn';
import {
    ExternalLink,
    FolderOpen,
    GitBranch,
    Github,
    Loader2,
    Check,
    Compass,
    AlertCircle,
} from 'lucide-react';
import { connectOAuthProvider } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';

interface ChatToolResultProps {
    toolCallId: string;
    toolName: string;
    state: string;
    output?: unknown;
    errorText?: string;
}

// ── Tool output types ───────────────────────────────────────────

interface NavigateOutput {
    url?: string;
    navigated?: boolean;
}

interface DirectoryListOutput {
    directories?: Array<{ id: string; name: string; itemsCount: number; url: string }>;
    total?: number;
}

interface DirectoryDetailOutput {
    name?: string;
    description?: string;
    url?: string;
}

interface StatsOutput {
    totalDirectories?: number;
    totalItems?: number;
    activeWebsites?: number;
}

interface GitConnectionOutput {
    connected?: boolean;
    username?: string;
    providerId?: string;
    availableProviders?: Array<{ id: string; name: string }>;
    setupUrl?: string;
}

interface DeployConnectionOutput {
    configured?: boolean;
    available?: boolean;
    providerId?: string;
    providers?: Array<{ id: string; name: string }>;
    setupUrl?: string;
}

interface WebSearchOutput {
    success?: boolean;
    results?: Array<{ title: string; url: string; score?: number; publishedDate?: string }>;
    resultCount?: number;
    message?: string;
    setupUrl?: string;
}

interface UserInfoOutput {
    success?: boolean;
    user?: { username: string; email: string; avatar?: string | null };
    message?: string;
}

interface GenericToolOutput {
    success?: boolean;
    error?: string;
}

const executedToolActions = new Set<string>();

const LABELS: Record<string, string> = {
    listDirectories: 'Fetching directories',
    getDirectoryDetails: 'Loading directory',
    getStats: 'Loading stats',
    getDirectoryItemsSummary: 'Loading items summary',
    getDirectoryConfig: 'Loading config',
    getGenerationHistory: 'Loading history',
    getScheduleStatus: 'Checking schedule',
    syncDirectory: 'Syncing directory',
    checkGitConnection: 'Checking git',
    checkDeployConnection: 'Checking deploy',
    listGitProviders: 'Checking providers',
    listAvailablePipelines: 'Loading pipelines',
    createDirectoryManual: 'Creating directory',
    createDirectoryWithAI: 'Creating directory with AI',
    importDirectory: 'Importing directory',
    analyzeImportSource: 'Analyzing repository',
    updateDirectory: 'Updating directory',
    deleteDirectory: 'Deleting directory',
    addItem: 'Adding item',
    removeItem: 'Removing item',
    updateItem: 'Updating item',
    generateItems: 'Starting generation',
    checkItemHealth: 'Checking item health',
    regenerateMarkdown: 'Regenerating markdown',
    deployDirectory: 'Deploying',
    checkDeploymentStatus: 'Checking deployment',
    listDomains: 'Loading domains',
    setSchedule: 'Updating schedule',
    runScheduleNow: 'Running schedule',
    cancelSchedule: 'Cancelling schedule',
    webSearch: 'Searching the web',
    getUserInfo: 'Loading user profile',
    suggestDirectories: 'Researching directory ideas',
    navigate: 'Navigating',
    reloadPage: 'Refreshing',
};

export function ChatToolResult({
    toolCallId,
    toolName,
    state,
    output,
    errorText,
}: ChatToolResultProps) {
    const t = useTranslations('dashboard.aiChat');
    const locale = useLocale();
    const router = useRouter();

    const isRunning = state === 'input-streaming' || state === 'input-available';
    const isDone = state === 'output-available';
    const isError = state === 'output-error';

    // Track whether this tool was live (seen running) vs loaded from history.
    // Only auto-navigate/reload for live tool executions, not replayed results.
    const wasLive = useRef(false);
    useEffect(() => {
        if (isRunning) {
            wasLive.current = true;
        }
    }, [isRunning]);

    useEffect(() => {
        if (!isDone || !output || !wasLive.current || executedToolActions.has(toolCallId)) {
            return;
        }

        if (toolName === 'navigate') {
            const data = output as NavigateOutput;
            if (data.url && data.url.startsWith('/')) {
                executedToolActions.add(toolCallId);
                router.push(getPathname({ href: data.url, locale }));
            }
            return;
        }

        if (toolName === 'reloadPage') {
            executedToolActions.add(toolCallId);
            router.refresh();
            return;
        }
    }, [toolCallId, toolName, isDone, output, router, locale]);

    // Running — only show for known tools
    if (isRunning) {
        if (!LABELS[toolName]) return null;
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {LABELS[toolName]}
            </span>
        );
    }

    if (isError) {
        const label = LABELS[toolName] ?? toolName;
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-danger">
                <AlertCircle className="w-2.5 h-2.5" />
                {label} failed{errorText ? `: ${errorText}` : ''}
            </span>
        );
    }

    if (!isDone) return null;

    // Reload — invisible, handled by useEffect
    if (toolName === 'reloadPage') return null;

    // Navigate — show a brief confirmation, useEffect handles the redirect
    if (toolName === 'navigate') {
        const data = output as NavigateOutput;
        return data?.url ? (
            <Link
                href={data.url}
                className="inline-flex items-center gap-1 mt-1 text-[11px] text-primary dark:text-primary-400 hover:underline"
            >
                <Compass className="w-3 h-3" />
                <span>{t('opened')}</span>
            </Link>
        ) : null;
    }

    switch (toolName) {
        case 'listDirectories':
            return <DirectoryList output={output} />;
        case 'getDirectoryDetails':
            return <DirectoryDetail output={output} />;
        case 'getDirectoryStats':
            return <Stats output={output} />;
        case 'checkGitConnection':
            return <GitConnection output={output} />;
        case 'checkDeployConnection':
            return <DeployConnection output={output} />;
        case 'webSearch':
            return <WebSearchResult output={output} />;
        case 'getUserInfo':
            return <UserInfo output={output} />;
        default: {
            // Generic completed indicator for tools without custom UI
            const label = LABELS[toolName];
            if (!label) return null;
            const data = output as GenericToolOutput | null;
            if (data?.error) {
                return (
                    <span className="inline-flex items-center gap-1 text-[10px] text-danger">
                        <ExternalLink className="w-2.5 h-2.5" />
                        {data.error}
                    </span>
                );
            }
            return (
                <span className="inline-flex items-center gap-1 text-[10px] text-success">
                    <Check className="w-2.5 h-2.5" />
                    {label}
                </span>
            );
        }
    }
}

// ────────────────────────────────────────────────────────────────
// Result renderers
// ────────────────────────────────────────────────────────────────

function DirectoryList({ output }: { output: unknown }) {
    const data = output as DirectoryListOutput;
    if (!data?.directories?.length) return null;

    return (
        <div className="mt-1 space-y-0.5">
            {data.directories.map((dir) => (
                <Link
                    key={dir.id}
                    href={dir.url}
                    className={cn(
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px]',
                        'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                        'text-text dark:text-text-dark transition-colors',
                    )}
                >
                    <FolderOpen className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{dir.name}</span>
                    <span className="text-text-muted dark:text-text-muted-dark flex items-center gap-1 shrink-0 whitespace-nowrap">
                        {dir.itemsCount}
                        <ExternalLink className="w-2.5 h-2.5" />
                    </span>
                </Link>
            ))}
        </div>
    );
}

function DirectoryDetail({ output }: { output: unknown }) {
    const data = output as DirectoryDetailOutput;
    if (!data?.name || !data.url) return null;

    return (
        <Link
            href={data.url}
            className={cn(
                'flex items-center gap-2 mt-1 px-2.5 py-1.5 rounded-md text-[11px]',
                'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                'text-text dark:text-text-dark transition-colors',
            )}
        >
            <FolderOpen className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
            <span className="flex-1 min-w-0 truncate font-medium">{data.name}</span>
            <ExternalLink className="w-2.5 h-2.5 text-text-muted shrink-0" />
        </Link>
    );
}

function Stats({ output }: { output: unknown }) {
    const data = output as StatsOutput;
    if (!data) return null;

    return (
        <div className="flex gap-2 mt-1">
            {[
                { label: 'Directories', value: data.totalDirectories ?? 0 },
                { label: 'Items', value: data.totalItems ?? 0 },
                { label: 'Websites', value: data.activeWebsites ?? 0 },
            ].map((s) => (
                <div
                    key={s.label}
                    className="flex-1 px-2 py-1.5 rounded-md bg-surface-secondary/50 dark:bg-white/[0.03] text-center"
                >
                    <p className="text-xs font-semibold text-text dark:text-white">{s.value}</p>
                    <p className="text-[9px] text-text-muted dark:text-text-muted-dark">
                        {s.label}
                    </p>
                </div>
            ))}
        </div>
    );
}

function GitConnection({ output }: { output: unknown }) {
    const t = useTranslations('dashboard.aiChat');
    const data = output as GitConnectionOutput;
    const pathname = usePathname();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    if (!data) return null;

    if (data.connected) {
        return (
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-success">
                <Check className="w-3 h-3" />
                <span>
                    {t('gitConnectedAs', {
                        username: data.username ?? '',
                        provider: data.providerId ?? '',
                    })}
                </span>
            </div>
        );
    }

    const handleConnect = (providerId: string) => {
        setPendingId(providerId);
        startTransition(async () => {
            const result = await connectOAuthProvider(providerId, pathname);
            if (result.success && result.url) {
                window.location.href = result.url;
            } else {
                toast.error(result.error || 'Failed to connect');
                setPendingId(null);
            }
        });
    };

    const providers = data.availableProviders?.length
        ? data.availableProviders
        : [{ id: 'github', name: 'GitHub' }];

    return (
        <div className="mt-2 p-3 rounded-lg border border-warning/20 bg-warning/5">
            <div className="flex items-center gap-2 mb-2">
                <GitBranch className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-text dark:text-text-dark">
                    {t('gitNotConnected')}
                </span>
            </div>
            <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-3">
                {t('gitNotConnectedDesc')}
            </p>
            <div className="flex flex-wrap gap-2">
                {providers.map((provider) => (
                    <button
                        key={provider.id}
                        onClick={() => handleConnect(provider.id)}
                        disabled={pendingId !== null}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer',
                            provider.id === 'github'
                                ? 'bg-github text-white hover:bg-github/90'
                                : 'bg-primary text-white hover:bg-primary-hover',
                            'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        {pendingId === provider.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : provider.id === 'github' ? (
                            <Github className="w-3 h-3" />
                        ) : (
                            <GitBranch className="w-3 h-3" />
                        )}
                        {provider.name}
                    </button>
                ))}
            </div>
        </div>
    );
}

function DeployConnection({ output }: { output: unknown }) {
    const t = useTranslations('dashboard.aiChat');
    const data = output as DeployConnectionOutput;
    if (!data) return null;

    if (data.configured) {
        return (
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-success">
                <Check className="w-3 h-3" />
                <span>{t('deployConfigured', { provider: data.providerId || '' })}</span>
            </div>
        );
    }

    return (
        <div className="mt-2 p-3 rounded-lg border border-warning/20 bg-warning/5">
            <div className="flex items-center gap-2 mb-2">
                <ExternalLink className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-text dark:text-text-dark">
                    {t('deployNotConfigured')}
                </span>
            </div>
            <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-2">
                {t('deployNotConfiguredDesc')}
            </p>
            {data.setupUrl && (
                <Link
                    href={data.setupUrl}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                        'bg-primary text-white hover:bg-primary-hover transition-colors',
                    )}
                >
                    <ExternalLink className="w-3 h-3" />
                    {t('configureDeployProvider')}
                </Link>
            )}
        </div>
    );
}

function WebSearchResult({ output }: { output: unknown }) {
    const data = output as WebSearchOutput;
    if (!data) return null;

    if (!data.success) {
        return (
            <div className="mt-2 p-3 rounded-lg border border-warning/20 bg-warning/5">
                <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4 text-warning" />
                    <span className="text-xs font-medium text-text dark:text-text-dark">
                        Search unavailable
                    </span>
                </div>
                <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-2">
                    {data.message}
                </p>
                {data.setupUrl && (
                    <Link
                        href={data.setupUrl}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                            'bg-primary text-white hover:bg-primary-hover transition-colors',
                        )}
                    >
                        <ExternalLink className="w-3 h-3" />
                        Configure search provider
                    </Link>
                )}
            </div>
        );
    }

    if (!data.results?.length) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                <Check className="w-2.5 h-2.5" />
                No results found
            </span>
        );
    }

    return (
        <div className="mt-1 space-y-0.5">
            {data.results.slice(0, 5).map((result, i) => (
                <a
                    key={i}
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px]',
                        'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                        'text-text dark:text-text-dark transition-colors',
                    )}
                >
                    <Compass className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{result.title}</span>
                    <ExternalLink className="w-2.5 h-2.5 text-text-muted shrink-0" />
                </a>
            ))}
            {data.results.length > 5 && (
                <span className="block px-2.5 text-[10px] text-text-muted dark:text-text-muted-dark">
                    +{data.results.length - 5} more results
                </span>
            )}
        </div>
    );
}

function UserInfo({ output }: { output: unknown }) {
    const data = output as UserInfoOutput;
    if (!data?.success || !data.user) return null;

    return (
        <div className="flex items-center gap-2 mt-1 px-2.5 py-1.5 rounded-md text-[11px] text-text dark:text-text-dark">
            <Check className="w-3 h-3 text-success shrink-0" />
            <span className="truncate">
                {data.user.username} ({data.user.email})
            </span>
        </div>
    );
}
