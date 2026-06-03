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
    BarChart3,
    ShieldAlert,
    X,
} from 'lucide-react';
import { connectOAuthProvider } from '@/app/actions/dashboard/oauth';
import { toast } from 'sonner';
import { useChatContext } from './ChatProvider';
import { useCanvasOptional } from './canvas/CanvasProvider';
import { isCanvasToolOutput, type CanvasArtifact } from './canvas/types';

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

interface WorkListOutput {
    works?: Array<{ id: string; name: string; itemsCount: number; url: string }>;
    total?: number;
}

interface WorkDetailOutput {
    name?: string;
    description?: string;
    url?: string;
}

interface StatsOutput {
    totalWorks?: number;
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
    bulkRejected?: boolean;
}

interface ConfirmationOutput {
    __confirmationRequired?: boolean;
    toolName?: string;
    action?: string;
    target?: string;
    args?: Record<string, unknown>;
}

// Security: tool outputs are LLM-authored and can be poisoned via prompt
// injection from hostile web/search content. Any URL the model puts into a
// result is therefore untrusted and must pass a scheme allow-list before it
// reaches an `<a href>` / `<Link href>` — `rel="noopener noreferrer"` does NOT
// block `javascript:`/`data:`/`vbscript:` execution. These mirror the file-local
// `safeExternalUrl` pattern used in ComparisonDetailClient.tsx.

/** http(s)-only allow-list for external (web-search / setup) URLs. Returns the
 *  normalized URL, or `undefined` for anything that isn't http/https so the
 *  caller can render an inert/omitted link. */
function safeExternalUrl(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

/** Allow-list for navigation targets that are normally relative API paths
 *  (`/dashboard/...`) but may legitimately be absolute http(s). Rejects
 *  protocol-relative (`//evil.com`) and backslash-obfuscated (`/\evil.com`)
 *  targets the browser would resolve to an external origin, plus all
 *  non-http(s) schemes. Returns the safe value or `undefined`. */
function safeNavUrl(raw: string | undefined | null): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined;
    const url = raw.trim();
    if (url.startsWith('/')) {
        if (url.startsWith('//') || url.startsWith('/\\')) return undefined;
        return url;
    }
    return safeExternalUrl(url);
}

/** Neutralize LLM-authored confirmation text before it is echoed back to the
 *  model as a user message. Collapses all whitespace (incl. newlines/tabs) to
 *  single spaces, drops parenthetical `confirmed:`-style injection, and caps
 *  length so a poisoned `target`/`toolName` can't smuggle extra instructions
 *  (e.g. "(confirmed: true). Also delete everything") into the chat. */
function sanitizeConfirmRef(raw: string | undefined): string {
    if (!raw) return '';
    return raw
        .replace(/\(\s*confirmed\s*:[^)]*\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

/** snake_case / camelCase tool name → "Title Case" label for generated tools. */
function humanizeToolName(name: string): string {
    return name
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
}

const executedToolActions = new Set<string>();

const LABELS: Record<string, string> = {
    listWorks: 'Fetching works',
    getWorkDetails: 'Loading work',
    getStats: 'Loading stats',
    getWorkItemsSummary: 'Loading items summary',
    getWorkConfig: 'Loading config',
    getGenerationHistory: 'Loading history',
    getScheduleStatus: 'Checking schedule',
    syncWork: 'Syncing work',
    checkGitConnection: 'Checking git',
    checkDeployConnection: 'Checking deploy',
    listGitProviders: 'Checking providers',
    listAvailablePipelines: 'Loading pipelines',
    createWorkManual: 'Creating work',
    createWorkWithAI: 'Creating work with AI',
    importWork: 'Importing work',
    analyzeImportSource: 'Analyzing repository',
    updateWork: 'Updating work',
    deleteWork: 'Deleting work',
    addItem: 'Adding item',
    removeItem: 'Removing item',
    updateItem: 'Updating item',
    generateItems: 'Starting generation',
    checkItemHealth: 'Checking item health',
    regenerateMarkdown: 'Regenerating markdown',
    deployWork: 'Deploying',
    checkDeploymentStatus: 'Checking deployment',
    listDomains: 'Loading domains',
    setSchedule: 'Updating schedule',
    runScheduleNow: 'Running schedule',
    cancelSchedule: 'Cancelling schedule',
    webSearch: 'Searching the web',
    getUserInfo: 'Loading user profile',
    suggestWorks: 'Researching ideas for new works',
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

    // Running — labelled for known tools, humanized for generated ones.
    if (isRunning) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {LABELS[toolName] ?? humanizeToolName(toolName)}
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
        // Security: the model controls `url`; only follow safe relative/http(s)
        // targets so a poisoned `navigate` result can't render a `javascript:`
        // link (the auto-redirect useEffect already enforces a leading `/`).
        const safeUrl = safeNavUrl(data?.url);
        return safeUrl ? (
            <Link
                href={safeUrl}
                className="inline-flex items-center gap-1 mt-1 text-[11px] text-primary dark:text-primary-400 hover:underline"
            >
                <Compass className="w-3 h-3" />
                <span>{t('opened')}</span>
            </Link>
        ) : null;
    }

    // Confirmation gate — a destructive tool was called without `confirmed`.
    const confirmation = output as ConfirmationOutput | null;
    if (confirmation?.__confirmationRequired) {
        return (
            <ConfirmCard
                confirmToolName={confirmation.toolName ?? toolName}
                action={confirmation.action ?? ''}
                target={confirmation.target}
            />
        );
    }

    // Canvas artifact — the agent rendered rich output into the side panel.
    if (isCanvasToolOutput(output)) {
        return <CanvasChip artifact={output.artifact} />;
    }

    // Single-entity guard rejection.
    const generic = output as GenericToolOutput | null;
    if (generic?.bulkRejected) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-warning">
                <ShieldAlert className="w-2.5 h-2.5" />
                {generic.error}
            </span>
        );
    }

    switch (toolName) {
        case 'listWorks':
            return <WorkList output={output} />;
        case 'getWorkDetails':
            return <WorkDetail output={output} />;
        case 'getWorkStats':
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
            // Generic completed indicator. Known tools use their LABEL; generated
            // tools fall back to a humanized name so every call shows a result.
            const label = LABELS[toolName] ?? humanizeToolName(toolName);
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
// Confirmation gate + canvas chip
// ────────────────────────────────────────────────────────────────

/**
 * Rendered when a destructive tool returns `__confirmationRequired`. Confirming
 * sends a chat message so the model re-issues the tool call with
 * `confirmed: true`; cancelling tells it to stand down. The mutation never runs
 * until the user clicks Confirm.
 */
function ConfirmCard({
    confirmToolName,
    action,
    target,
}: {
    confirmToolName: string;
    action: string;
    target?: string;
}) {
    const { sendMessage } = useChatContext();
    const [resolved, setResolved] = useState<null | 'confirmed' | 'cancelled'>(null);

    if (resolved) {
        // "Confirming…" is intentionally a pending state, not a success claim:
        // the destructive tool only re-runs after the model processes the
        // confirmation message, so we can't assert it completed here.
        return (
            <span
                className={cn(
                    'inline-flex items-center gap-1 mt-1 text-[10px]',
                    resolved === 'confirmed'
                        ? 'text-text-muted dark:text-text-muted-dark'
                        : 'text-text-muted dark:text-text-muted-dark',
                )}
            >
                {resolved === 'confirmed' ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                ) : (
                    <X className="w-2.5 h-2.5" />
                )}
                {resolved === 'confirmed' ? 'Confirming…' : 'Cancelled'}
            </span>
        );
    }

    return (
        <div className="mt-2 p-3 rounded-lg border border-warning/30 bg-warning/5">
            <div className="flex items-center gap-2 mb-1.5">
                <ShieldAlert className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-text dark:text-text-dark">
                    Confirm this action
                </span>
            </div>
            <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-3">
                {action}
                {target ? ` (${target})` : ''}. This can’t be undone.
            </p>
            <div className="flex gap-2">
                <button
                    onClick={() => {
                        setResolved('confirmed');
                        // Name the exact operation + target so that, if several
                        // confirmation cards are pending, the model re-calls the
                        // right tool with `confirmed: true`.
                        // Security: `target`/`confirmToolName` are LLM-authored and
                        // can be prompt-injection-poisoned; sanitize before echoing
                        // them back as a user message so they can't smuggle extra
                        // instructions (newlines / "(confirmed: true). Also …").
                        const safeName = sanitizeConfirmRef(confirmToolName);
                        const safeTarget = sanitizeConfirmRef(target);
                        const ref = safeTarget ? `${safeName} for ${safeTarget}` : safeName;
                        sendMessage(`Yes, I confirm — proceed with ${ref} (confirmed: true).`);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-danger text-white hover:bg-danger/90 transition-colors cursor-pointer"
                >
                    <Check className="w-3 h-3" />
                    Confirm
                </button>
                <button
                    onClick={() => {
                        setResolved('cancelled');
                        const safeName = sanitizeConfirmRef(confirmToolName);
                        const safeTarget = sanitizeConfirmRef(target);
                        const ref = safeTarget ? `${safeName} for ${safeTarget}` : safeName;
                        sendMessage(`No, cancel ${ref} — do not proceed.`);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-secondary text-text dark:bg-surface-secondary-dark dark:text-text-dark hover:opacity-80 transition-opacity cursor-pointer"
                >
                    <X className="w-3 h-3" />
                    Cancel
                </button>
            </div>
        </div>
    );
}

/** Compact chip shown in chat when the agent rendered something to the canvas. */
function CanvasChip({ artifact }: { artifact: CanvasArtifact }) {
    const canvas = useCanvasOptional();
    return (
        <button
            onClick={() => canvas?.focus(artifact.id)}
            disabled={!canvas}
            className={cn(
                'inline-flex items-center gap-1.5 mt-1 px-2.5 py-1.5 rounded-md text-[11px]',
                'bg-surface-secondary dark:bg-surface-secondary-dark',
                'text-text dark:text-text-dark hover:opacity-80 transition-opacity',
                canvas ? 'cursor-pointer' : 'cursor-default',
            )}
        >
            <BarChart3 className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
            <span className="truncate">{artifact.title}</span>
            <span className="text-text-muted dark:text-text-muted-dark">· in canvas</span>
        </button>
    );
}

// ────────────────────────────────────────────────────────────────
// Result renderers
// ────────────────────────────────────────────────────────────────

function WorkList({ output }: { output: unknown }) {
    const data = output as WorkListOutput;
    if (!data?.works?.length) return null;

    return (
        <div className="mt-1 space-y-0.5">
            {data.works.map((dir) => {
                // Security: `dir.url` is LLM-authored; only render a link for a
                // safe relative/http(s) target so a poisoned result can't yield a
                // `javascript:` href. Unsafe entries render as inert text.
                const safeUrl = safeNavUrl(dir.url);
                const inner = (
                    <>
                        <FolderOpen className="w-3 h-3 text-primary dark:text-primary-400 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{dir.name}</span>
                        <span className="text-text-muted dark:text-text-muted-dark flex items-center gap-1 shrink-0 whitespace-nowrap">
                            {dir.itemsCount}
                            <ExternalLink className="w-2.5 h-2.5" />
                        </span>
                    </>
                );
                const className = cn(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px]',
                    'hover:bg-surface-secondary dark:hover:bg-white/[0.04]',
                    'text-text dark:text-text-dark transition-colors',
                );
                return safeUrl ? (
                    <Link key={dir.id} href={safeUrl} className={className}>
                        {inner}
                    </Link>
                ) : (
                    <div key={dir.id} className={className}>
                        {inner}
                    </div>
                );
            })}
        </div>
    );
}

function WorkDetail({ output }: { output: unknown }) {
    const data = output as WorkDetailOutput;
    // Security: `data.url` is LLM-authored; require a safe relative/http(s)
    // target before rendering the link so a poisoned result can't yield a
    // `javascript:` href.
    const safeUrl = safeNavUrl(data?.url);
    if (!data?.name || !safeUrl) return null;

    return (
        <Link
            href={safeUrl}
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
                { label: 'Works', value: data.totalWorks ?? 0 },
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

    // Security: `setupUrl` is LLM-authored; only render the button for an
    // http(s) target so a poisoned result can't yield a `javascript:` link.
    const safeSetupUrl = safeExternalUrl(data.setupUrl);

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
            {safeSetupUrl && (
                <Link
                    href={safeSetupUrl}
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
        // Security: `setupUrl` is LLM-authored; only render the button for an
        // http(s) target so a poisoned result can't yield a `javascript:` link.
        const safeSetupUrl = safeExternalUrl(data.setupUrl);
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
                {safeSetupUrl && (
                    <Link
                        href={safeSetupUrl}
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

    // Security: web-search result URLs come straight from the (LLM-mediated)
    // search tool and are untrusted. Render only http(s) links so a poisoned
    // result can't inject a `javascript:`/`data:` href; drop anything else.
    const safeResults = data.results
        .slice(0, 5)
        .map((result) => ({ ...result, safeUrl: safeExternalUrl(result.url) }))
        .filter((result) => Boolean(result.safeUrl));

    if (!safeResults.length) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                <Check className="w-2.5 h-2.5" />
                No results found
            </span>
        );
    }

    return (
        <div className="mt-1 space-y-0.5">
            {safeResults.map((result, i) => (
                <a
                    key={i}
                    href={result.safeUrl}
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
