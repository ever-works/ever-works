'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Lightbulb, Loader2, Plus, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { WorkProposal, WorkProposalStatus } from '@/lib/api/work-proposals';
import {
    createIdeaAction,
    getProposalsStatusAction,
    listProposalsAction,
    refreshProposalsAction,
} from '@/app/actions/dashboard/work-proposals';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { IdeaCard } from '@/components/ideas';

const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_MS = 10 * 60_000;
/** Spec §3 + PR O - dashboard preview block caps at 3 IdeaCards.
 *  The full list lives at /ideas (PR N). */
const PREVIEW_CARD_LIMIT = 3;

interface WorkProposalsSectionProps {
    initialProposals: WorkProposal[];
    initiallyResearching: boolean;
    initiallyCanRefresh: boolean;
    username?: string;
    autoStart?: boolean;
}

export function WorkProposalsSection({
    initialProposals,
    initiallyResearching,
    initiallyCanRefresh,
    username,
    autoStart = false,
}: WorkProposalsSectionProps) {
    const t = useTranslations('dashboard.proposals');
    const tPage = useTranslations('dashboard.ideasPage');
    const router = useRouter();
    const [proposals, setProposals] = useState(initialProposals);
    const [researching, setResearching] = useState(initiallyResearching);
    const [canRefresh, setCanRefresh] = useState(initiallyCanRefresh);
    const [pendingRefresh, startRefreshTransition] = useTransition();
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const autoStartAttempted = useRef(false);

    // Phase 5 PR O — quick-add inline (collapsible).
    const [quickAddOpen, setQuickAddOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [isCreating, startCreating] = useTransition();

    // Phase 5 PR O — toggles match the /ideas page (PR N). The
    // dashboard server fetch only loads PENDING by default; the
    // toggle handler lazy-fetches the additional status buckets
    // the first time it ticks on, so a user who never opens them
    // doesn't pay the round-trip.
    const [showAccepted, setShowAccepted] = useState(false);
    const [showDismissed, setShowDismissed] = useState(false);
    const [loadedAccepted, setLoadedAccepted] = useState(false);
    const [loadedDismissed, setLoadedDismissed] = useState(false);

    const refreshListAndStatus = useCallback(async () => {
        const [status, list] = await Promise.all([
            getProposalsStatusAction(),
            listProposalsAction(),
        ]);
        setProposals(list);
        setResearching(status.researching);
        setCanRefresh(status.canRefresh);
        return status;
    }, []);

    useEffect(() => {
        if (!researching) return;
        let cancelled = false;
        const deadline = Date.now() + POLL_MAX_MS;

        const loop = async () => {
            while (!cancelled && Date.now() < deadline) {
                try {
                    const status = await refreshListAndStatus();
                    if (cancelled || !status.researching) return;
                } catch {
                    // Network blip: keep polling until deadline.
                }

                await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            }

            if (!cancelled) {
                setResearching(false);
            }
        };
        void loop();
        return () => {
            cancelled = true;
        };
    }, [refreshListAndStatus, researching]);

    const queueRefresh = useCallback(async () => {
        try {
            const result = await refreshProposalsAction();
            if (result.status === 'queued') {
                setResearching(true);
                window.setTimeout(() => {
                    void refreshListAndStatus().catch(() => undefined);
                }, 1_000);
            } else if (result.status === 'rate-limited') {
                setRefreshError(t('errors.rateLimited'));
                setCanRefresh(false);
                setResearching(false);
            } else if (result.status === 'at-limit') {
                setCanRefresh(false);
                setResearching(false);
            }
        } catch {
            setRefreshError(t('errors.generic'));
            setResearching(false);
        }
    }, [refreshListAndStatus, t]);

    useEffect(() => {
        if (!autoStart || autoStartAttempted.current || proposals.length > 0) return;
        autoStartAttempted.current = true;
        setRefreshError(null);
        setResearching(true);
        void queueRefresh();
    }, [autoStart, proposals.length, queueRefresh]);

    // Phase 5 PR O - lazy-loader for the new toggle-driven statuses.
    const loadStatuses = useCallback(async (statuses: WorkProposalStatus[]) => {
        try {
            const rows = await listProposalsAction(statuses);
            setProposals((prev) => {
                const byId = new Map(prev.map((p) => [p.id, p]));
                for (const r of rows) byId.set(r.id, r);
                return Array.from(byId.values());
            });
        } catch {
            // Silent - empty toggle just renders nothing extra. The
            // user can refresh the page if they want a retry.
        }
    }, []);

    const handleToggleAccepted = (checked: boolean) => {
        setShowAccepted(checked);
        if (checked && !loadedAccepted) {
            setLoadedAccepted(true);
            void loadStatuses(['accepted']);
        }
    };
    const handleToggleDismissed = (checked: boolean) => {
        setShowDismissed(checked);
        if (checked && !loadedDismissed) {
            setLoadedDismissed(true);
            void loadStatuses(['dismissed']);
        }
    };

    const handleRefresh = () => {
        setRefreshError(null);
        startRefreshTransition(async () => {
            await queueRefresh();
        });
    };

    const handleDismissed = (id: string) => {
        // PR O: don't drop the row here — flip its status to
        // DISMISSED locally so the user can un-hide via the
        // "Show dismissed" toggle without re-fetching. If the
        // toggle is OFF, the row is filtered out below.
        setProposals((prev) =>
            prev.map((p) => (p.id === id ? { ...p, status: 'dismissed' as const } : p)),
        );
    };

    const handleQuickAdd = () => {
        const description = draft.trim();
        if (description.length < 10) {
            toast.error(tPage('quickAdd.minLength'));
            return;
        }
        startCreating(async () => {
            try {
                const created = await createIdeaAction({ description });
                setProposals((prev) => [created, ...prev]);
                setDraft('');
                setQuickAddOpen(false);
                toast.success(tPage('toasts.ideaCreated'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : tPage('toasts.ideaCreateError'));
            }
        });
    };

    // Apply the toggle filters identically to the /ideas page so
    // the preview block stays a coherent prefix of the catalog.
    const visibleProposals = useMemo(() => {
        return proposals.filter((p) => {
            if (p.status === 'accepted' && !showAccepted) return false;
            if (p.status === 'dismissed' && !showDismissed) return false;
            return true;
        });
    }, [proposals, showAccepted, showDismissed]);

    const previewCards = visibleProposals.slice(0, PREVIEW_CARD_LIMIT);
    const totalVisible = visibleProposals.length;

    const showEmpty = visibleProposals.length === 0 && !researching;
    const showResearching = researching && visibleProposals.length === 0;
    const showRefreshButton = canRefresh || researching;

    return (
        <section className="mt-8" aria-labelledby="work-proposals-heading">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center">
                        <Lightbulb className="w-4 h-4 text-warning" />
                    </div>
                    <h2
                        id="work-proposals-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {username ? t('header.titleWithName', { username }) : t('header.title')}
                    </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {/* Phase 5 PR O — quick-add trigger. Hidden while the form is open
                        so the header and form don't show duplicate Add controls. */}
                    {!quickAddOpen && (
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setQuickAddOpen(true)}
                            aria-expanded={quickAddOpen}
                        >
                            <Plus className="w-3.5 h-3.5" />
                            {tPage('quickAdd.submit')}
                        </Button>
                    )}

                    {/* Phase 5 PR O — gears dropdown linking to settings anchors */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                aria-label={tPage('gears.menuLabel')}
                            >
                                <SettingsIcon className="w-4 h-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuLabel>{tPage('gears.menuLabel')}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onClick={() =>
                                    router.push('/settings/work-agent#auto-generate-ideas')
                                }
                            >
                                <a
                                    href="/settings/work-agent#auto-generate-ideas"
                                    className="w-full text-left"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    {tPage('gears.autoGenerate')}
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => router.push('/settings/work-agent#auto-build-works')}
                            >
                                <a
                                    href="/settings/work-agent#auto-build-works"
                                    className="w-full text-left"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    {tPage('gears.autoBuild')}
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => router.push('/settings/work-agent#auto-retry')}
                            >
                                <a
                                    href="/settings/work-agent#auto-retry"
                                    className="w-full text-left"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    {tPage('gears.autoRetry')}
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => router.push('/settings/work-agent#account-budgets')}
                            >
                                <a
                                    href="/settings/work-agent#account-budgets"
                                    className="w-full text-left"
                                    onClick={(e) => e.preventDefault()}
                                >
                                    {tPage('gears.accountBudgets')}
                                </a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Existing Suggest more button (keeps prior PR-E label). */}
                    {showRefreshButton && (
                        <button
                            type="button"
                            onClick={handleRefresh}
                            disabled={pendingRefresh || researching}
                            className="inline-flex items-center gap-1.5 text-sm text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                            {pendingRefresh || researching ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <RefreshCw className="w-4 h-4" />
                            )}
                            {t('actions.refresh')}
                        </button>
                    )}

                    {/* View all (n) — moved into the header row so the
                        section reads icon → title → actions → counts on
                        one line, matching the Works section below. */}
                    {totalVisible > 0 && (
                        <Link
                            href={ROUTES.DASHBOARD_IDEAS}
                            className={cn(
                                'text-sm font-medium text-primary hover:underline whitespace-nowrap',
                                'inline-flex items-center gap-1',
                            )}
                        >
                            {tPage('viewAll', { n: totalVisible })}
                        </Link>
                    )}
                </div>
            </div>

            {/* Phase 5 PR O — toggles row (sub-header). */}
            <div className="flex flex-wrap items-center gap-3 mb-3 text-sm text-text-secondary dark:text-text-secondary-dark">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={showAccepted}
                        onChange={(e) => handleToggleAccepted(e.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {tPage('toggles.showAccepted')}
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={showDismissed}
                        onChange={(e) => handleToggleDismissed(e.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {tPage('toggles.showDismissed')}
                </label>
            </div>

            {/* Phase 5 PR O — collapsible quick-add. */}
            {quickAddOpen && (
                <div className="mb-4 rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3">
                    <Textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={2}
                        placeholder={tPage('quickAdd.placeholder')}
                        className="w-full text-sm"
                        autoFocus
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                setQuickAddOpen(false);
                                setDraft('');
                            }}
                            disabled={isCreating}
                        >
                            {/* Re-use the dismiss-aria string as a Cancel label —
                                the dashboard preview rarely needs a dedicated
                                "Cancel" key for v1; if QA flags it we'll add
                                one in PR P. */}
                            ✕
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            className="gap-1.5"
                            onClick={handleQuickAdd}
                            disabled={isCreating || draft.trim().length < 10}
                        >
                            <Plus className="w-3.5 h-3.5" />
                            {tPage('quickAdd.submit')}
                        </Button>
                    </div>
                </div>
            )}

            {refreshError && (
                <p className="mb-3 text-sm text-red-500 dark:text-red-400">{refreshError}</p>
            )}

            {showResearching && (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>
                            {t('researching.title')}
                            <span aria-hidden="true" className="inline-flex w-5 justify-start">
                                <span className="animate-pulse">.</span>
                                <span className="animate-pulse [animation-delay:160ms]">.</span>
                                <span className="animate-pulse [animation-delay:320ms]">.</span>
                            </span>
                        </span>
                    </div>
                    <p className="mt-1 text-xs">{t('researching.subtitle')}</p>
                </div>
            )}

            {!showResearching && showEmpty && (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>{t('empty.title')}</p>
                    <p className="mt-1 text-xs">{t('empty.subtitle')}</p>
                </div>
            )}

            {previewCards.length > 0 && (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {previewCards.map((p) => (
                        <IdeaCard key={p.id} proposal={p} onDismissed={handleDismissed} />
                    ))}
                </div>
            )}

        </section>
    );
}
