'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Bot, Loader2, Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { AgentAssignCandidate } from '@/lib/api/agents.shared';
import { assignAgentToIdeaAction, listAssignableIdeaAgentsAction } from '@/app/actions/agents';
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
 * "Assign an existing Agent to this Idea" picker — the Idea counterpart
 * of `works/detail/AssignWorkAgentDialog`, opened from the Agents card
 * in the Idea detail rail.
 *
 * Same session contract as the Work dialog: the candidate list is
 * fetched per open (debounced while typing), every close path resets it
 * so the next open never flashes the previous run's rows or error, and
 * assignment is idempotent server-side so a double-click can't 409.
 */
const SEARCH_DEBOUNCE_MS = 250;

export function AssignIdeaAgentDialog({
    ideaId,
    open,
    onOpenChange,
    onAssigned,
}: {
    ideaId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAssigned?: () => void;
}) {
    const t = useTranslations('dashboard.ideasPage.detail.agents');
    const router = useRouter();
    const [search, setSearch] = useState('');
    const [candidates, setCandidates] = useState<AgentAssignCandidate[]>([]);
    // Starts true so the first paint of a session is the spinner, not the
    // "none available" empty state: the fetch is scheduled on a timer and so
    // lands a paint after the dialog opens.
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [assigningId, setAssigningId] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const load = useCallback(
        async (term: string, signal: { cancelled: boolean }) => {
            setLoading(true);
            setLoadError(null);
            try {
                const rows = await listAssignableIdeaAgentsAction(ideaId, term);
                if (!signal.cancelled) setCandidates(rows);
            } catch (error) {
                if (!signal.cancelled) {
                    setLoadError(error instanceof Error ? error.message : t('assignLoadFailed'));
                }
            } finally {
                if (!signal.cancelled) setLoading(false);
            }
        },
        [ideaId, t],
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

    const closeDialog = useCallback(() => {
        setSearch('');
        setCandidates([]);
        setLoadError(null);
        setLoading(true);
        onOpenChange(false);
    }, [onOpenChange]);

    const handleOpenChange = useCallback(
        (next: boolean) => {
            if (next) {
                onOpenChange(true);
                return;
            }
            closeDialog();
        },
        [closeDialog, onOpenChange],
    );

    const assign = (agent: AgentAssignCandidate) => {
        setAssigningId(agent.id);
        startTransition(async () => {
            try {
                await assignAgentToIdeaAction(agent.id, ideaId);
                toast.success(t('assignedToast', { name: agent.name }));
                closeDialog();
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
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-md p-5">
                <DialogClose onClose={closeDialog} />
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
                        <ul className="space-y-1.5">
                            {candidates.map((agent) => {
                                const isAssigning = assigningId === agent.id;
                                return (
                                    <li key={agent.id}>
                                        <button
                                            type="button"
                                            disabled={assigningId !== null}
                                            onClick={() => assign(agent)}
                                            className={cn(
                                                'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border dark:border-border-dark px-2 py-2 text-left transition-colors',
                                                'hover:border-border-hover dark:hover:border-border-hover-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                                'focus-visible:border-border-hover dark:focus-visible:border-border-hover-dark focus-visible:bg-surface-hover dark:focus-visible:bg-surface-hover-dark outline-none',
                                                assigningId !== null &&
                                                    !isAssigning &&
                                                    'opacity-50',
                                            )}
                                        >
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
                    <Button variant="ghost" size="sm" onClick={closeDialog}>
                        {t('assignCancel')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
