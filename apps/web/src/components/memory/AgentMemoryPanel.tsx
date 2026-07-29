'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Brain, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Agent memory on the global Memory page.
 *
 * This is the half of "Memory" that is NOT a knowledge base. Memory is
 * the container: uploaded documents and originals on one side, what the
 * agents themselves remember on the other. Until now the page only
 * showed the first half, which made "Memory" and "KB" look like synonyms.
 *
 * Read-only by design. Sessions are opened, written and closed by agents
 * during runs; a person browsing this page should be able to see that
 * history without being able to mutate it as a side effect of looking.
 *
 * Agent memory is plugin-backed and often not configured, so this does
 * NOT hide itself when unavailable — unlike the chat mic, where a dead
 * control is worse than none. Here the absence is the answer to a
 * question the user is actually asking ("what do my agents remember?"),
 * so it surfaces the operator-facing hint the API returns instead.
 */

interface AgentMemorySession {
    readonly id: string;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly metadata?: Record<string, unknown>;
}

interface Availability {
    readonly available: boolean;
    readonly message?: string;
    readonly activeProvider?: { id?: string; name?: string } | null;
}

function formatWhen(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
}

export function AgentMemoryPanel({
    workId,
    compact = false,
}: {
    /**
     * Narrow the sessions to one Work. Omitted on `/memory`, where the
     * question is org-wide. The API asserts Work access when this is
     * present, so passing it never widens what the caller can see.
     */
    readonly workId?: string;
    /**
     * Drop the card chrome. The Work workbench renders this inside an
     * existing bordered tree column, where a second border reads as a
     * nested card.
     */
    readonly compact?: boolean;
} = {}) {
    const t = useTranslations('dashboard.memoryPage.agentMemory');
    const [availability, setAvailability] = useState<Availability | null>(null);
    const [sessions, setSessions] = useState<AgentMemorySession[]>([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const availRes = await fetch('/api/agent-memory/check-availability', {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            const avail = availRes.ok
                ? ((await availRes.json()) as Availability)
                : { available: false };
            setAvailability(avail);

            // Only ask for sessions when a provider is actually loaded —
            // otherwise the upstream call fails in a way that says nothing
            // the availability check has not already said better.
            if (!avail.available) {
                setSessions([]);
                return;
            }

            const qs = new URLSearchParams({ limit: '20' });
            if (workId) qs.set('workId', workId);
            const res = await fetch(`/api/agent-memory/sessions?${qs.toString()}`, {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            if (!res.ok) {
                setSessions([]);
                return;
            }
            const body = (await res.json()) as { sessions?: AgentMemorySession[] };
            setSessions(body.sessions ?? []);
        } catch {
            // Best-effort panel: a transient failure leaves the rest of the
            // Memory page fully usable.
            setAvailability({ available: false });
        } finally {
            setLoading(false);
        }
    }, [workId]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div
            data-testid="agent-memory-panel"
            className={cn(
                'flex flex-col gap-3',
                !compact && [
                    'rounded-lg border p-4',
                    'bg-card dark:bg-card-primary-dark',
                    'border-card-border dark:border-white/9',
                ],
            )}
        >
            <div className="flex items-center gap-2">
                <Brain
                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0"
                    strokeWidth={1.5}
                />
                <span className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </span>
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
            </div>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('subtitle')}</p>

            {!loading && availability && !availability.available && (
                <p
                    data-testid="agent-memory-unavailable"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {/* The API ships an operator-facing hint naming the plugin
                        to enable; prefer it over our generic copy. */}
                    {availability.message ?? t('unavailable')}
                </p>
            )}

            {!loading && availability?.available && sessions.length === 0 && (
                <p
                    data-testid="agent-memory-empty"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {t('empty')}
                </p>
            )}

            {sessions.length > 0 && (
                <ul className="flex flex-col divide-y divide-card-border dark:divide-white/9">
                    {sessions.map((session) => (
                        <li
                            key={session.id}
                            data-testid="agent-memory-session"
                            className="flex items-center justify-between gap-3 py-2"
                        >
                            <span className="truncate text-sm text-text dark:text-text-dark">
                                {formatWhen(session.startedAt)}
                            </span>
                            <span className="text-xs text-text-muted dark:text-text-muted-dark shrink-0">
                                {session.endedAt ? t('closed') : t('open')}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
