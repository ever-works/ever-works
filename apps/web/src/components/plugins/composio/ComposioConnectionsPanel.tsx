'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, Plug, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    initiateComposioConnection,
    listComposioConnectedAccounts,
    listComposioToolkits,
} from '@/app/actions/plugins';
import type {
    ComposioConnectedAccount,
    ComposioToolkit,
} from '@/lib/api/plugins-capabilities/composio';
import { isValidRedirectUrl } from '@/lib/utils';

interface ComposioConnectionsPanelProps {
    /** Optional callback URL Composio should redirect to after OAuth completes. */
    callbackUrl?: string;
}

const ACTIVE_STATUS = 'ACTIVE';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Settings-page panel that lists the Composio toolkit catalog the caller's
 * API key has access to and the caller's current connected accounts. For
 * each toolkit row the user supplies an authConfigId (ac_*) and clicks
 * **Connect** — we POST `/api/plugins/composio/connect`, open the returned
 * OAuth URL in a popup, then poll `/api/plugins/composio/connected-accounts`
 * until the new account flips to ACTIVE.
 */
export function ComposioConnectionsPanel({ callbackUrl }: ComposioConnectionsPanelProps) {
    const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
    const [accounts, setAccounts] = useState<ComposioConnectedAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [authConfigBySlug, setAuthConfigBySlug] = useState<Record<string, string>>({});
    const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
    const [pollingSlug, setPollingSlug] = useState<string | null>(null);
    const pollTimerRef = useRef<number | null>(null);

    const accountsByToolkit = useMemo(() => {
        const map = new Map<string, ComposioConnectedAccount[]>();
        for (const a of accounts) {
            const key = (a.toolkitSlug ?? '').toUpperCase();
            const list = map.get(key) ?? [];
            list.push(a);
            map.set(key, list);
        }
        return map;
    }, [accounts]);

    const refreshAccounts = useCallback(async () => {
        const result = await listComposioConnectedAccounts();
        if (result.success && result.data) {
            setAccounts(result.data);
            return result.data;
        }
        if (!result.success) setError(result.error ?? 'Failed to load connected accounts');
        return [] as ComposioConnectedAccount[];
    }, []);

    const refreshAll = useCallback(async () => {
        setLoading(true);
        setError(null);
        const [tk, _accs] = await Promise.all([listComposioToolkits(200), refreshAccounts()]);
        if (tk.success && tk.data) setToolkits(tk.data);
        else if (!tk.success) setError(tk.error ?? 'Failed to load toolkits');
        setLoading(false);
    }, [refreshAccounts]);

    useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    useEffect(() => {
        return () => {
            if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
        };
    }, []);

    const startPolling = useCallback(
        (toolkitSlug: string) => {
            if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
            setPollingSlug(toolkitSlug);
            const startedAt = Date.now();
            const upper = toolkitSlug.toUpperCase();
            pollTimerRef.current = window.setInterval(async () => {
                const latest = await refreshAccounts();
                const active = latest.some(
                    (a) =>
                        (a.toolkitSlug ?? '').toUpperCase() === upper && a.status === ACTIVE_STATUS,
                );
                if (active || Date.now() - startedAt > POLL_TIMEOUT_MS) {
                    if (pollTimerRef.current !== null) {
                        window.clearInterval(pollTimerRef.current);
                        pollTimerRef.current = null;
                    }
                    setPollingSlug(null);
                }
            }, POLL_INTERVAL_MS);
        },
        [refreshAccounts],
    );

    const handleConnect = useCallback(
        async (toolkit: ComposioToolkit) => {
            const authConfigId = (authConfigBySlug[toolkit.slug] ?? '').trim();
            if (!authConfigId) {
                setError(
                    `Enter the authConfig id (ac_*) for ${toolkit.slug} before connecting. Create one in the Composio dashboard.`,
                );
                return;
            }
            setError(null);
            setConnectingSlug(toolkit.slug);
            try {
                const result = await initiateComposioConnection({
                    toolkitSlug: toolkit.slug,
                    authConfigId,
                    ...(callbackUrl ? { callbackUrl } : {}),
                });
                if (!result.success || !result.data) {
                    setError(result.error ?? 'Failed to initiate connection');
                    return;
                }
                // Security: the OAuth redirect URL is returned by the third-party Composio
                // API and is opened in a popup. A compromised/crafted response (or a malicious
                // authConfig) could return a `javascript:`/`data:`/protocol-relative target,
                // turning window.open() into an XSS/open-redirect sink. Only open http(s) URLs
                // (legitimate OAuth URLs are always https); reject anything else.
                const redirectUrl = result.data.redirectUrl;
                if (!isValidRedirectUrl(redirectUrl)) {
                    setError('Received an unsafe redirect URL from Composio. Connection aborted.');
                    return;
                }
                window.open(redirectUrl, '_blank', 'noopener,noreferrer,width=600,height=700');
                startPolling(toolkit.slug);
            } finally {
                setConnectingSlug(null);
            }
        },
        [authConfigBySlug, callbackUrl, startPolling],
    );

    if (loading) {
        return (
            <div className="rounded-lg border border-border dark:border-border-dark p-6 bg-surface dark:bg-surface-dark flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading Composio toolkits…
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark">
            <div className="flex items-center justify-between gap-2 px-6 py-3 border-b border-border dark:border-border-dark">
                <div className="flex items-center gap-2">
                    <Plug className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        Composio connections
                    </h2>
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshAll()}
                    aria-label="Refresh connections"
                >
                    <RefreshCw className="w-4 h-4" />
                </Button>
            </div>

            {error && (
                <div className="px-6 py-3 text-sm text-danger border-b border-border dark:border-border-dark">
                    {error}
                </div>
            )}

            {toolkits.length === 0 ? (
                <div className="p-6 text-sm text-text-muted dark:text-text-muted-dark">
                    No toolkits returned. Set your Composio API key in plugin settings first.
                </div>
            ) : (
                <ul className="divide-y divide-border dark:divide-border-dark">
                    {toolkits.map((toolkit) => {
                        const connected = accountsByToolkit.get(toolkit.slug.toUpperCase()) ?? [];
                        const isActive = connected.some((a) => a.status === ACTIVE_STATUS);
                        const isConnecting = connectingSlug === toolkit.slug;
                        const isPolling = pollingSlug === toolkit.slug;
                        return (
                            <li
                                key={toolkit.slug}
                                className="px-6 py-4 flex items-start gap-4 flex-wrap"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium text-text dark:text-text-dark">
                                            {toolkit.name}
                                        </span>
                                        <span className="font-mono text-xs text-text-muted dark:text-text-muted-dark">
                                            {toolkit.slug}
                                        </span>
                                        {isActive && (
                                            <span className="inline-flex items-center gap-1 text-xs text-success">
                                                <CheckCircle2 className="w-3.5 h-3.5" />
                                                Connected
                                            </span>
                                        )}
                                        {!isActive && connected.length > 0 && (
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {connected[0].status}
                                            </span>
                                        )}
                                    </div>
                                    {toolkit.description && (
                                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1 line-clamp-2">
                                            {toolkit.description}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 w-full sm:w-auto">
                                    <Input
                                        type="text"
                                        placeholder="authConfigId (ac_…)"
                                        value={authConfigBySlug[toolkit.slug] ?? ''}
                                        onChange={(e) =>
                                            setAuthConfigBySlug((prev) => ({
                                                ...prev,
                                                [toolkit.slug]: e.target.value,
                                            }))
                                        }
                                        className="w-56 font-mono text-xs"
                                        aria-label={`authConfigId for ${toolkit.slug}`}
                                    />
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        onClick={() => void handleConnect(toolkit)}
                                        disabled={isConnecting || isPolling}
                                        loading={isConnecting || isPolling}
                                    >
                                        {isPolling ? (
                                            'Waiting…'
                                        ) : (
                                            <>
                                                <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                                                {isActive ? 'Reconnect' : 'Connect'}
                                            </>
                                        )}
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
