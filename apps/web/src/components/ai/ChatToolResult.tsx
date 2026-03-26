'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { ExternalLink, FolderOpen, GitBranch, Loader2, Check, Compass } from 'lucide-react';

interface ChatToolResultProps {
    toolName: string;
    state: string;
    output?: unknown;
}

const LABELS: Record<string, string> = {
    listDirectories: 'Fetching directories',
    getDirectoryDetails: 'Loading directory',
    getDirectoryStats: 'Loading stats',
    checkGitConnection: 'Checking git',
    navigate: 'Navigating',
};

export function ChatToolResult({ toolName, state, output }: ChatToolResultProps) {
    const t = useTranslations('dashboard.aiChat');
    const router = useRouter();

    const isRunning = state === 'input-streaming' || state === 'input-available';
    const isDone = state === 'output-available';

    // Auto-navigate
    useEffect(() => {
        if (toolName === 'navigate' && isDone && output) {
            const data = output as { url?: string };
            if (data.url) router.push(data.url);
        }
    }, [toolName, isDone, output, router]);

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

    if (!isDone) return null;

    // Navigate — show a brief confirmation, useEffect handles the redirect
    if (toolName === 'navigate') {
        const data = output as { url?: string };
        return data?.url ? (
            <a
                href={data.url}
                className="inline-flex items-center gap-1 mt-1 text-[11px] text-primary dark:text-primary-400 hover:underline"
            >
                <Compass className="w-3 h-3" />
                <span>Opened</span>
            </a>
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
        default:
            return null;
    }
}

// ────────────────────────────────────────────────────────────────
// Result renderers
// ────────────────────────────────────────────────────────────────

function DirectoryList({ output }: { output: unknown }) {
    const data = output as {
        directories?: Array<{ id: string; name: string; itemsCount: number; url: string }>;
    };
    if (!data?.directories?.length) return null;

    return (
        <div className="mt-1 space-y-0.5">
            {data.directories.map((dir) => (
                <a
                    key={dir.id}
                    href={dir.url}
                    className={cn(
                        'flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px]',
                        'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                        'text-text dark:text-text-dark transition-colors',
                    )}
                >
                    <span className="flex items-center gap-1.5">
                        <FolderOpen className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
                        {dir.name}
                    </span>
                    <span className="text-text-muted dark:text-text-muted-dark flex items-center gap-1">
                        {dir.itemsCount}
                        <ExternalLink className="w-2.5 h-2.5" />
                    </span>
                </a>
            ))}
        </div>
    );
}

function DirectoryDetail({ output }: { output: unknown }) {
    const data = output as { name?: string; description?: string; url?: string };
    if (!data?.name) return null;

    return (
        <a
            href={data.url}
            className={cn(
                'flex items-center gap-1.5 mt-1 px-2.5 py-1.5 rounded-md text-[11px]',
                'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                'text-text dark:text-text-dark transition-colors',
            )}
        >
            <FolderOpen className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
            <span className="font-medium">{data.name}</span>
            <ExternalLink className="w-2.5 h-2.5 text-text-muted ml-auto shrink-0" />
        </a>
    );
}

function Stats({ output }: { output: unknown }) {
    const data = output as {
        totalDirectories?: number;
        totalItems?: number;
        activeWebsites?: number;
    };
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
    const data = output as { connected?: boolean; username?: string; setupUrl?: string };
    if (!data) return null;

    return (
        <div
            className={cn(
                'flex items-center gap-1.5 mt-1 text-[11px]',
                data.connected ? 'text-success' : 'text-warning',
            )}
        >
            {data.connected ? (
                <>
                    <Check className="w-3 h-3" />
                    <span>
                        Connected as <strong>{data.username}</strong>
                    </span>
                </>
            ) : (
                <>
                    <GitBranch className="w-3 h-3" />
                    <a href={data.setupUrl} className="underline">
                        {t('notConfigured')}
                    </a>
                </>
            )}
        </div>
    );
}
