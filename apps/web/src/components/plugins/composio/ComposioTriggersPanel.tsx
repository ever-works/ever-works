'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { deleteComposioTrigger, listComposioTriggers } from '@/app/actions/plugins';
import type { ComposioTrigger } from '@/lib/api/plugins-capabilities/composio-triggers';

/**
 * Settings-page panel that lists the caller's Composio trigger subscriptions
 * (each row = one enabled trigger event surface like `GMAIL_NEW_EMAIL`).
 *
 * Create flow is intentionally out of this MVP — triggers are minted via
 * `POST /api/plugins/composio/triggers` (the API also returns the
 * per-subscription HMAC secret once). UI for "Create trigger" lands with
 * the upstream Composio enable-trigger call in a follow-up PR — until
 * then operators provision via API and this panel surfaces the result.
 */
export function ComposioTriggersPanel() {
    const [items, setItems] = useState<ComposioTrigger[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        const result = await listComposioTriggers();
        if (result.success && result.data) setItems(result.data);
        else if (!result.success) setError(result.error ?? 'Failed to load triggers');
        setLoading(false);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const handleDelete = useCallback(async (id: string) => {
        setDeletingId(id);
        try {
            const result = await deleteComposioTrigger(id);
            if (!result.success) {
                setError(result.error ?? 'Failed to delete trigger');
                return;
            }
            setItems((prev) => prev.filter((t) => t.id !== id));
        } finally {
            setDeletingId(null);
        }
    }, []);

    if (loading) {
        return (
            <div className="rounded-lg border border-border dark:border-border-dark p-6 bg-surface dark:bg-surface-dark flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading Composio triggers…
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark">
            <div className="flex items-center justify-between gap-2 px-6 py-3 border-b border-border dark:border-border-dark">
                <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        Composio triggers
                    </h2>
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refresh()}
                    aria-label="Refresh triggers"
                >
                    <RefreshCw className="w-4 h-4" />
                </Button>
            </div>

            {error && (
                <div className="px-6 py-3 text-sm text-danger border-b border-border dark:border-border-dark">
                    {error}
                </div>
            )}

            {items.length === 0 ? (
                <div className="p-6 text-sm text-text-muted dark:text-text-muted-dark">
                    No triggers yet. Create one via{' '}
                    <code className="font-mono">POST /api/plugins/composio/triggers</code> — UI is
                    coming in a follow-up.
                </div>
            ) : (
                <ul className="divide-y divide-border dark:divide-border-dark">
                    {items.map((trigger) => (
                        <li key={trigger.id} className="px-6 py-4 flex items-start gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-sm text-text dark:text-text-dark">
                                        {trigger.triggerSlug}
                                    </span>
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {trigger.toolkitSlug}
                                    </span>
                                    {trigger.enabled ? (
                                        <span className="inline-flex items-center gap-1 text-xs text-success">
                                            <span className="w-1.5 h-1.5 rounded-full bg-success" />
                                            Enabled
                                        </span>
                                    ) : (
                                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                            Disabled
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                    Deliveries: {trigger.deliveriesReceived} received,{' '}
                                    {trigger.deliveriesRejected} rejected
                                    {trigger.lastFiredAt
                                        ? ` · last fired ${new Date(trigger.lastFiredAt).toLocaleString()}`
                                        : ''}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void handleDelete(trigger.id)}
                                disabled={deletingId === trigger.id}
                                loading={deletingId === trigger.id}
                                aria-label={`Delete trigger ${trigger.triggerSlug}`}
                                className="text-danger hover:text-danger hover:bg-danger/10"
                            >
                                <Trash2 className="w-4 h-4" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
