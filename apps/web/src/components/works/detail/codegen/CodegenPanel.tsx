'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { ExternalLink, Loader2, CheckCircle2, XCircle, AlertCircle, Sparkles } from 'lucide-react';
import type { WorkCodeUpdate, WorkCodeUpdateStatus } from '@/lib/api';

interface CodegenPanelProps {
    workId: string;
    initialCodeUpdates: WorkCodeUpdate[];
}

const STATUS_BADGE: Record<WorkCodeUpdateStatus, string> = {
    pending: 'bg-surface-secondary text-text-muted',
    generating: 'bg-primary/10 text-primary',
    proposed: 'bg-warning/10 text-warning',
    applied: 'bg-success/10 text-success',
    rejected: 'bg-surface-secondary text-text-muted',
    failed: 'bg-error/10 text-error',
};

const STATUS_ICON: Record<WorkCodeUpdateStatus, React.ReactNode> = {
    pending: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    generating: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    proposed: <Sparkles className="w-3.5 h-3.5" />,
    applied: <CheckCircle2 className="w-3.5 h-3.5" />,
    rejected: <XCircle className="w-3.5 h-3.5" />,
    failed: <AlertCircle className="w-3.5 h-3.5" />,
};

export function CodegenPanel({ workId, initialCodeUpdates }: CodegenPanelProps) {
    const t = useTranslations('dashboard.workDetail.codegen');
    const router = useRouter();
    const [codeUpdates, setCodeUpdates] = useState(initialCodeUpdates);
    const [prompt, setPrompt] = useState('');
    const [title, setTitle] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setCodeUpdates(initialCodeUpdates);
    }, [initialCodeUpdates]);

    const hasInFlight = useMemo(
        () => codeUpdates.some((c) => c.status === 'pending' || c.status === 'generating'),
        [codeUpdates],
    );

    useEffect(() => {
        if (!hasInFlight) return;
        const tick = async () => {
            try {
                const res = await fetch(`/api/works/${workId}/code-updates`);
                if (!res.ok) return;
                const data = await res.json();
                if (Array.isArray(data?.codeUpdates)) {
                    setCodeUpdates(data.codeUpdates);
                }
            } catch {
                // tolerate poll failures
            }
        };
        const interval = setInterval(tick, 3000);
        return () => clearInterval(interval);
    }, [hasInFlight, workId]);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!prompt.trim()) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/works/${workId}/code-updates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt.trim(), title: title.trim() || undefined }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.message ?? data?.error ?? 'Failed to create code update');
            }
            const data = await res.json().catch(() => ({}));
            if (data?.codeUpdate) {
                setCodeUpdates((current) => [
                    data.codeUpdate,
                    ...current.filter((c) => c.id !== data.codeUpdate.id),
                ]);
            }
            setPrompt('');
            setTitle('');
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed');
        } finally {
            setSubmitting(false);
        }
    }

    async function act(id: string, action: 'apply' | 'reject') {
        try {
            const res = await fetch(`/api/works/${workId}/code-updates/${id}/${action}`, {
                method: 'POST',
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.message ?? data?.error ?? `Failed to ${action}`);
            }
            const data = await res.json().catch(() => ({}));
            if (data?.codeUpdate) {
                setCodeUpdates((current) =>
                    current.map((codeUpdate) =>
                        codeUpdate.id === data.codeUpdate.id ? data.codeUpdate : codeUpdate,
                    ),
                );
            }
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : `Failed to ${action}`);
        }
    }

    return (
        <div className="space-y-6">
            <form
                onSubmit={submit}
                className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6 space-y-4"
            >
                <div>
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('promptTitle')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('promptHelp')}
                    </p>
                </div>
                <input
                    type="text"
                    placeholder={t('titlePlaceholder')}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    className="w-full px-3 py-2 text-sm rounded-md border border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <textarea
                    placeholder={t('promptPlaceholder')}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    maxLength={2000}
                    rows={5}
                    className="w-full px-3 py-2 text-sm rounded-md border border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                {error && <p className="text-sm text-error">{error}</p>}
                <div className="flex justify-end">
                    <button
                        type="submit"
                        disabled={!prompt.trim() || submitting}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {t('submit')}
                    </button>
                </div>
            </form>

            <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                <div className="px-6 py-4 border-b border-border dark:border-border-dark">
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('historyTitle')}
                    </h2>
                </div>
                {codeUpdates.length === 0 ? (
                    <div className="px-6 py-8 text-sm text-text-muted text-center">
                        {t('historyEmpty')}
                    </div>
                ) : (
                    <ul className="divide-y divide-border dark:divide-border-dark">
                        {codeUpdates.map((c) => (
                            <li key={c.id} className="px-6 py-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span
                                                className={cn(
                                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                                                    STATUS_BADGE[c.status],
                                                )}
                                            >
                                                {STATUS_ICON[c.status]}
                                                {t(`status.${c.status}`)}
                                            </span>
                                            <span className="text-xs text-text-muted">
                                                {new Date(c.createdAt).toLocaleString()}
                                            </span>
                                        </div>
                                        <p className="mt-2 text-sm text-text dark:text-text-dark font-medium truncate">
                                            {c.title ?? c.prompt.slice(0, 80)}
                                        </p>
                                        <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                                            {c.prompt}
                                        </p>
                                        {c.summary && (
                                            <p className="mt-1 text-xs text-text-muted line-clamp-2">
                                                {c.summary}
                                            </p>
                                        )}
                                        {c.lastError && (
                                            <p className="mt-1 text-xs text-error">{c.lastError}</p>
                                        )}
                                        {c.prUrl && (
                                            <a
                                                href={c.prUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
                                            >
                                                {t('openPr', { number: c.prNumber ?? 0 })}
                                                <ExternalLink className="w-3 h-3" />
                                            </a>
                                        )}
                                    </div>
                                    {c.status === 'proposed' && (
                                        <div className="flex shrink-0 gap-2">
                                            <button
                                                onClick={() => act(c.id, 'reject')}
                                                className="px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-surface-secondary"
                                            >
                                                {t('reject')}
                                            </button>
                                            <button
                                                onClick={() => act(c.id, 'apply')}
                                                className="px-3 py-1.5 text-xs font-medium rounded-md bg-success text-white hover:bg-success/90"
                                            >
                                                {t('apply')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
