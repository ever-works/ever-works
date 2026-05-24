'use client';

import { useMemo, useState, useTransition } from 'react';
import { Lightbulb, Plus, Settings as SettingsIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import {
    buildIdeaAction,
    createIdeaAction,
    dismissProposalAction,
} from '@/app/actions/dashboard/work-proposals';
import type { WorkProposal, WorkProposalStatus } from '@/lib/api/work-proposals';
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
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { IdeaCard } from './IdeaCard';

/**
 * Phase 5 PR N — Ideas catalog page client.
 *
 * Renders the full list of the user's Ideas — drafted by auto-
 * generation, suggested by Discover, spawned from a Mission, and
 * typed in by the user — with two visibility toggles for the
 * terminal statuses (ACCEPTED + DISMISSED, off by default) and a
 * filter-chip strip for narrowing to one specific status.
 *
 * Quick-add form at the top wires Phase 1 PR B's
 * `POST /me/work-proposals` (user-manual create) — first UI surface
 * for that endpoint. The created Idea is prepended to the local
 * state immediately (optimistic) so the user sees their typed
 * description show up as a PENDING card without round-tripping a
 * full re-fetch.
 *
 * Gears menu (Settings dropdown, top-right) deep-links to the
 * Phase 4 PR L / PR EE settings anchors so the user can jump from
 * "I want fewer auto-suggestions" → the cadence knob in a single
 * click.
 *
 * Each IdeaCard's Build CTA still routes to `/works/new?proposal=…`
 * for now (the existing Phase 0 flow). A future tick can swap that
 * for `buildIdeaAction` directly — but doing so here would change
 * IdeaCard's behavior for the dashboard preview block too, which
 * is out of PR N's scope.
 */
type Toggles = {
    showAccepted: boolean;
    showDismissed: boolean;
};

type StatusFilter = 'all' | WorkProposalStatus;

const ACTIONABLE_STATUSES: WorkProposalStatus[] = ['pending', 'queued', 'building', 'failed'];

const STATUS_FILTER_ORDER: StatusFilter[] = [
    'all',
    'pending',
    'queued',
    'building',
    'failed',
    'accepted',
    'dismissed',
];

interface IdeasPageClientProps {
    initialIdeas: WorkProposal[];
}

export function IdeasPageClient({ initialIdeas }: IdeasPageClientProps) {
    const t = useTranslations('dashboard.ideasPage');
    const router = useRouter();
    const [ideas, setIdeas] = useState(initialIdeas);
    const [draft, setDraft] = useState('');
    const [toggles, setToggles] = useState<Toggles>({
        showAccepted: false,
        showDismissed: false,
    });
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [isCreating, startCreating] = useTransition();
    const [isBuilding, startBuilding] = useTransition();

    const visibleIdeas = useMemo(() => {
        return ideas.filter((idea) => {
            // Toggles gate the terminal-status surfaces.
            if (idea.status === 'accepted' && !toggles.showAccepted) return false;
            if (idea.status === 'dismissed' && !toggles.showDismissed) return false;
            // Filter chip narrows further.
            if (statusFilter !== 'all' && idea.status !== statusFilter) return false;
            return true;
        });
    }, [ideas, toggles, statusFilter]);

    // Per-status counts for the filter-chip badges. Computed once
    // per render against the full set so the toggles don't reduce
    // the chip badges out from under the user.
    const counts = useMemo(() => {
        const map = new Map<StatusFilter, number>();
        map.set('all', ideas.length);
        for (const idea of ideas) {
            map.set(idea.status, (map.get(idea.status) ?? 0) + 1);
        }
        return map;
    }, [ideas]);

    const handleQuickAdd = () => {
        const description = draft.trim();
        if (description.length < 10) {
            toast.error(t('quickAdd.minLength'));
            return;
        }
        startCreating(async () => {
            try {
                const created = await createIdeaAction({ description });
                setIdeas((prev) => [created, ...prev]);
                setDraft('');
                toast.success(t('toasts.ideaCreated'));
            } catch (err) {
                toast.error(
                    err instanceof Error ? err.message : t('toasts.ideaCreateError'),
                );
            }
        });
    };

    const handleDismissed = (id: string) => {
        // IdeaCard's own dismiss path already calls
        // dismissProposalAction; we just mirror the local list so
        // the card disappears from this page without a full re-fetch.
        setIdeas((prev) =>
            prev.map((idea) =>
                idea.id === id ? { ...idea, status: 'dismissed' as const } : idea,
            ),
        );
    };

    // Build-from-Idea handler (Phase 1 PR B `POST /me/work-proposals/:id/build`).
    // Wired here as an explicit `Queue build` button on the FAILED
    // and PENDING cards once we add a richer card variant. For now
    // the existing IdeaCard's Build CTA preserves the legacy
    // `/works/new?proposal=…` flow. This handler is exposed so a
    // follow-up tick can swap one for the other without touching
    // the IdeaCard component.
    const handleQueueBuild = (id: string) => {
        startBuilding(async () => {
            try {
                const { idea } = await buildIdeaAction(id);
                setIdeas((prev) => prev.map((row) => (row.id === id ? idea : row)));
                toast.success(t('toasts.ideaQueued'));
            } catch (err) {
                toast.error(
                    err instanceof Error ? err.message : t('toasts.ideaQueueError'),
                );
            }
        });
    };
    // Suppress unused-var warning until a card variant calls it.
    void handleQueueBuild;

    // Catch-all dismiss for the per-card handler in IdeaCard; we
    // re-export a `silent` no-op when the user manually dismisses
    // via the card's X button (handled inside IdeaCard already).
    void dismissProposalAction;

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-6">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center">
                        <Lightbulb className="w-4 h-4 text-warning" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h1>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            aria-label={t('gears.menuLabel')}
                        >
                            <SettingsIcon className="w-4 h-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuLabel>{t('gears.menuLabel')}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={() => router.push('/settings/work-agent#auto-generate-ideas')}
                        >
                            <a
                                href="/settings/work-agent#auto-generate-ideas"
                                className="w-full text-left"
                                onClick={(e) => e.preventDefault()}
                            >
                                {t('gears.autoGenerate')}
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
                                {t('gears.autoBuild')}
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
                                {t('gears.autoRetry')}
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
                                {t('gears.accountBudgets')}
                            </a>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Quick add */}
            <div className="mb-6 rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4">
                <label
                    htmlFor="ideas-quick-add"
                    className="text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                >
                    {t('quickAdd.label')}
                </label>
                <div className="mt-2 flex flex-col gap-3 @3xl/main:flex-row @3xl/main:items-start">
                    <Textarea
                        id="ideas-quick-add"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        placeholder={t('quickAdd.placeholder')}
                        className="flex-1"
                    />
                    <Button
                        type="button"
                        size="sm"
                        className="gap-1.5 self-start @3xl/main:self-stretch @3xl/main:px-4"
                        onClick={handleQuickAdd}
                        disabled={isCreating || draft.trim().length < 10}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        {t('quickAdd.submit')}
                    </Button>
                </div>
            </div>

            {/* Toggles + filter chips row */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={toggles.showAccepted}
                            onChange={(e) =>
                                setToggles((prev) => ({
                                    ...prev,
                                    showAccepted: e.target.checked,
                                }))
                            }
                            className="rounded border-border dark:border-border-dark"
                        />
                        {t('toggles.showAccepted')}
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={toggles.showDismissed}
                            onChange={(e) =>
                                setToggles((prev) => ({
                                    ...prev,
                                    showDismissed: e.target.checked,
                                }))
                            }
                            className="rounded border-border dark:border-border-dark"
                        />
                        {t('toggles.showDismissed')}
                    </label>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {STATUS_FILTER_ORDER.map((s) => {
                        const c = counts.get(s) ?? 0;
                        const isActive = statusFilter === s;
                        const isTerminal = s === 'accepted' || s === 'dismissed';
                        const isHidden =
                            (s === 'accepted' && !toggles.showAccepted) ||
                            (s === 'dismissed' && !toggles.showDismissed);
                        return (
                            <button
                                key={s}
                                type="button"
                                onClick={() => setStatusFilter(s)}
                                disabled={isHidden}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                                    isActive
                                        ? 'bg-primary text-white border-primary'
                                        : 'bg-card dark:bg-card-primary-dark border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark hover:border-primary/40',
                                    isHidden && 'opacity-40 cursor-not-allowed',
                                    isTerminal && !isActive && 'italic',
                                )}
                            >
                                {t(`filters.${s}`)}
                                <span
                                    className={cn(
                                        'rounded-full px-1.5 text-[10px] font-medium',
                                        isActive
                                            ? 'bg-white/20'
                                            : 'bg-surface dark:bg-surface-dark text-text-muted dark:text-text-muted-dark',
                                    )}
                                >
                                    {c}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Sorted list */}
            {visibleIdeas.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                    <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {t('empty.subtitle')}
                    </p>
                </div>
            ) : (
                <div
                    className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4"
                    aria-busy={isBuilding}
                >
                    {visibleIdeas
                        .slice()
                        .sort(
                            (a, b) =>
                                new Date(b.generatedAt).getTime() -
                                new Date(a.generatedAt).getTime(),
                        )
                        .map((idea) => (
                            <IdeaCard
                                key={idea.id}
                                proposal={idea}
                                onDismissed={handleDismissed}
                            />
                        ))}
                </div>
            )}
        </div>
    );
}

// Re-export the constant so spec-doc / a follow-up tick can
// import it (e.g. dashboard preview wants the same default set).
export { ACTIONABLE_STATUSES };

// Re-export ROUTES alias so spec docs can deep-link to this page
// without re-importing constants.ts. (Tiny: keeps PR N's surface
// self-contained at a single import point.)
export { ROUTES as IDEAS_PAGE_ROUTES };
