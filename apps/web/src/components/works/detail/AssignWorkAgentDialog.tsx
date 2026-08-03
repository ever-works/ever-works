'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Bot, Loader2, Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { AgentAssignCandidate } from '@/lib/api/agents.shared';
import { assignAgentToWorkAction, listAssignableWorkAgentsAction } from '@/app/actions/agents';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * "Assign existing Agent" — the counterpart to "+ New Agent" in the
 * Work header's Agents dropdown. Creating an Agent per Work is the
 * wrong default for an operator who already has a roster; this dialog
 * suggests that roster and puts one on the Work in a single click.
 *
 * Candidates come from `listAssignableWorkAgentsAction` — every Agent
 * the caller owns, whatever its own scope, minus the archived ones and
 * the ones already on this Work. Search re-queries the server
 * (debounced) rather than filtering the first page client-side, so an
 * Agent past the 100-row page is still reachable by name.
 */

const SEARCH_DEBOUNCE_MS = 250;

export function AssignWorkAgentDialog({
    workId,
    open,
    onOpenChange,
    onAssigned,
}: {
    workId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Fired after a successful assign — lets the opener close its menu. */
    onAssigned?: () => void;
}) {
    const t = useTranslations('dashboard.workDetail.agentsDropdown');
    const router = useRouter();
    const [search, setSearch] = useState('');
    const [candidates, setCandidates] = useState<AgentAssignCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [assigningId, setAssigningId] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const load = useCallback(
        async (term: string, signal: { cancelled: boolean }) => {
            setLoading(true);
            setLoadError(null);
            try {
                const rows = await listAssignableWorkAgentsAction(workId, term);
                if (!signal.cancelled) setCandidates(rows);
            } catch (error) {
                if (!signal.cancelled) {
                    setLoadError(error instanceof Error ? error.message : t('assignLoadFailed'));
                }
            } finally {
                if (!signal.cancelled) setLoading(false);
            }
        },
        [workId, t],
    );

    useEffect(() => {
        if (!open) return;
        const signal = { cancelled: false };
        const timer = setTimeout(() => void load(search, signal), search ? SEARCH_DEBOUNCE_MS : 0);
        return () => {
            signal.cancelled = true;
            clearTimeout(timer);
        };
    }, [open, search, load]);

    // A dialog reopened after an assign should not show the previous
    // search — the list it filters has changed underneath it.
    useEffect(() => {
        if (!open) setSearch('');
    }, [open]);

    const assign = (agent: AgentAssignCandidate) => {
        setAssigningId(agent.id);
        startTransition(async () => {
            try {
                await assignAgentToWorkAction(agent.id, workId);
                toast.success(t('assignedToast', { name: agent.name }));
                // Drop the row locally so the list stays truthful even
                // before the server components re-render.
                setCandidates((rows) => rows.filter((row) => row.id !== agent.id));
                onOpenChange(false);
                onAssigned?.();
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('assignFailed'));
            } finally {
                setAssigningId(null);
            }
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md p-5">
                <DialogClose onClose={() => onOpenChange(false)} />
                <DialogHeader className="mb-3">
                    <DialogTitle className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('assignTitle')}
                    </DialogTitle>
                    <DialogDescription className="text-xs">{t('assignSubtitle')}</DialogDescription>
                </DialogHeader>

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted dark:text-text-muted-dark" />
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t('assignSearchPlaceholder')}
                        aria-label={t('assignSearchPlaceholder')}
                        className="h-8 w-full rounded-lg border border-border dark:border-border-dark bg-transparent pl-8 pr-2 text-sm text-text dark:text-text-dark placeholder:text-text-muted dark:placeholder:text-text-muted-dark outline-none focus-visible:border-border-hover dark:focus-visible:border-border-hover-dark"
                    />
                </div>

                <div className="mt-3 max-h-72 overflow-y-auto">
                    {loading && candidates.length === 0 ? (
                        <p className="flex items-center justify-center gap-2 py-8 text-xs text-text-muted dark:text-text-muted-dark">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t('assignLoading')}
                        </p>
                    ) : loadError ? (
                        <p className="py-8 text-center text-xs text-danger" role="alert">
                            {loadError}
                        </p>
                    ) : candidates.length === 0 ? (
                        <p className="py-8 text-center text-xs text-text-muted dark:text-text-muted-dark">
                            {search ? t('assignNoMatches') : t('assignNoneAvailable')}
                        </p>
                    ) : (
                        <ul className="space-y-0.5">
                            {candidates.map((agent) => {
                                const isAssigning = assigningId === agent.id;
                                return (
                                    <li key={agent.id}>
                                        <button
                                            type="button"
                                            disabled={assigningId !== null}
                                            onClick={() => assign(agent)}
                                            className={cn(
                                                'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors',
                                                'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                                'focus-visible:bg-surface-hover dark:focus-visible:bg-surface-hover-dark outline-none',
                                                assigningId !== null &&
                                                    !isAssigning &&
                                                    'opacity-50',
                                            )}
                                        >
                                            {/* Neutral tile on purpose: in a picker every row is
                                                an equally valid choice, so an accent colour here
                                                signals a distinction that isn't there. */}
                                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark">
                                                <Bot className="h-3.5 w-3.5" />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-medium text-text dark:text-text-dark">
                                                    {agent.name}
                                                </span>
                                                <span className="mt-0.5 block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                                    {agent.title ?? agent.slug}
                                                </span>
                                            </span>
                                            {isAssigning ? (
                                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted dark:text-text-muted-dark" />
                                            ) : (
                                                <Plus className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                                            )}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <div className="mt-4 flex justify-end">
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t('assignCancel')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
