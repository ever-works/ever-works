'use client';

import { useMemo, useState, useTransition } from 'react';
import { Lightbulb, Settings as SettingsIcon } from 'lucide-react';
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
import { PromptComposer } from '@/components/common/PromptComposer';
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
 * Phase 5 PR N + UI polish — Ideas catalog page client.
 *
 * Renders the full list of the user's Ideas — drafted by auto-
 * generation, suggested by Discover, spawned from a Mission, and
 * typed in by the user — with two visibility toggles for the
 * terminal statuses (ACCEPTED + DISMISSED, off by default) and a
 * filter-chip strip for narrowing to one specific status.
 *
 * Quick-add at the top now uses the shared `PromptComposer`
 * (same shape as the marketing site's landing prompt) so this
 * page and `/missions` feel like the same primitive.
 */
type Toggles = {
    showAccepted: boolean;
    showDismissed: boolean;
};

type StatusFilter = 'all' | WorkProposalStatus | 'done';

const ACTIONABLE_STATUSES: WorkProposalStatus[] = ['pending', 'queued', 'building', 'failed'];

const STATUS_FILTER_ORDER: StatusFilter[] = [
    'all',
    'pending',
    'queued',
    'building',
    'failed',
    'accepted',
    'dismissed',
    'done',
];

const IDEA_PLACEHOLDERS: ReadonlyArray<string> = [
    'e.g. "A curated list of the best AI coding agents released this year"',
    'e.g. "Landing page for my fintech startup with hero, pricing, and CTA"',
    'e.g. "Awesome list: best React state-management libraries with benchmarks"',
    'e.g. "Directory of MCP servers — capabilities, language, install command, source repo"',
    'e.g. "Knowledge base for our open-source SDK with search and versioning"',
    'e.g. "Blog about indie game development with categories for postmortems and tooling"',
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
        const isDoneFilter = statusFilter === 'done';
        return ideas.filter((idea) => {
            if (idea.status === 'accepted' && !toggles.showAccepted && !isDoneFilter) {
                return false;
            }
            if (idea.status === 'dismissed' && !toggles.showDismissed) return false;
            if (statusFilter === 'done' && idea.status !== 'accepted') return false;
            if (statusFilter !== 'all' && statusFilter !== 'done' && idea.status !== statusFilter) {
                return false;
            }
            return true;
        });
    }, [ideas, toggles, statusFilter]);

    const counts = useMemo(() => {
        const map = new Map<StatusFilter, number>();
        map.set('all', ideas.length);
        for (const idea of ideas) {
            map.set(idea.status, (map.get(idea.status) ?? 0) + 1);
        }
        map.set('done', map.get('accepted') ?? 0);
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
                toast.error(err instanceof Error ? err.message : t('toasts.ideaCreateError'));
            }
        });
    };

    const handleDismissed = (id: string) => {
        setIdeas((prev) =>
            prev.map((idea) => (idea.id === id ? { ...idea, status: 'dismissed' as const } : idea)),
        );
    };

    const handleQueueBuild = (id: string) => {
        startBuilding(async () => {
            try {
                const { idea } = await buildIdeaAction(id);
                setIdeas((prev) => prev.map((row) => (row.id === id ? idea : row)));
                toast.success(t('toasts.ideaQueued'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.ideaQueueError'));
            }
        });
    };
    void handleQueueBuild;
    void dismissProposalAction;

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            {/* Header — title + subtitle take the full row width and
                the gears menu floats to the far right so the subtitle
                isn't truncated next to it. */}
            <div className="flex items-start gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center">
                    <Lightbulb className="w-4 h-4 text-warning" />
                </div>
                <div className="min-w-0 flex-1">
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="ml-auto shrink-0 gap-1.5"
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

            {/* Quick add — shared composer matches the marketing site. */}
            <div className="mb-6">
                <label
                    htmlFor="ideas-quick-add"
                    className="block text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark mb-2"
                >
                    {t('quickAdd.label')}
                </label>
                <PromptComposer
                    inputId="ideas-quick-add"
                    value={draft}
                    onChange={setDraft}
                    onSubmit={handleQuickAdd}
                    submitting={isCreating}
                    placeholderExamples={IDEA_PLACEHOLDERS}
                    ariaLabel={t('quickAdd.label')}
                    submitTitle={t('quickAdd.submitTitle')}
                    testId="ideas-quick-add"
                />
            </div>

            {/* Toggles + filter chips row */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 dark:border-border-dark/50 bg-card/70 dark:bg-card-primary-dark/50 px-3 py-2">
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
                        const isDoneChip = s === 'done';
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
                                    isDoneChip
                                        ? isActive
                                            ? 'bg-success text-white border-success'
                                            : 'bg-success/5 dark:bg-success/10 border-success/30 text-success hover:border-success/60'
                                        : isActive
                                          ? 'bg-primary text-white border-primary'
                                          : 'bg-card dark:bg-card-primary-dark border-border dark:border-border-dark text-text-secondary dark:text-text-secondary-dark hover:border-primary/40',
                                    isHidden && 'opacity-40 cursor-not-allowed',
                                    isTerminal && !isActive && 'italic',
                                )}
                                title={isDoneChip ? t('filters.doneTooltip') : undefined}
                            >
                                {isDoneChip && <span aria-hidden>✓</span>}
                                {t(`filters.${s}`)}
                                <span
                                    className={cn(
                                        'rounded-full px-1.5 text-[10px] font-medium',
                                        isActive
                                            ? 'bg-white/20'
                                            : isDoneChip
                                              ? 'bg-success/15 dark:bg-success/20 text-success'
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
                <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 bg-surface/40 dark:bg-surface-dark/30 p-8 text-center">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-warning/20 bg-warning/10">
                        <Lightbulb className="w-4 h-4 text-warning" />
                    </div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('empty.title')}
                    </p>
                    <p className="mx-auto mt-1 max-w-xl text-xs text-text-muted dark:text-text-muted-dark">
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
                            <IdeaCard key={idea.id} proposal={idea} onDismissed={handleDismissed} />
                        ))}
                </div>
            )}
        </div>
    );
}

export { ACTIONABLE_STATUSES };
export { ROUTES as IDEAS_PAGE_ROUTES };
