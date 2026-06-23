'use client';

import { useState, useTransition, useEffect } from 'react';
import { Lightbulb, Settings as SettingsIcon, Search } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { buildIdeaAction } from '@/app/actions/dashboard/work-proposals';
import type { WorkProposal, WorkProposalStatus } from '@/lib/api/work-proposals';
import { Button } from '@/components/ui/button';
import {
    PromptComposer,
    buildAttachmentRefs,
    type ComposerAttachment,
} from '@/components/common/PromptComposer';
import { PageHeader } from '@/components/common/PageHeader';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { IdeaCard } from './IdeaCard';

/**
 * Phase 5 PR N + UI polish — Ideas catalog page client.
 *
 * Renders a server-filtered page of the user's Ideas — drafted by
 * auto-generation, suggested by Discover, spawned from a Mission,
 * and typed in by the user — with URL-backed search/status filters.
 *
 * Quick-add at the top now uses the shared `PromptComposer`
 * (same shape as the marketing site's landing prompt) so this
 * page and `/missions` feel like the same primitive.
 */
type IdeasStatusFilter = 'actionable' | 'all' | WorkProposalStatus | 'done';

const ACTIONABLE_STATUSES: WorkProposalStatus[] = ['pending', 'queued', 'building', 'failed'];

const STATUS_FILTER_ORDER: IdeasStatusFilter[] = [
    'actionable',
    'all',
    'pending',
    'queued',
    'building',
    'failed',
    'accepted',
    'dismissed',
    'done',
];

function ideaMatchesFilter(idea: WorkProposal, filter: IdeasStatusFilter = 'actionable'): boolean {
    if (filter === 'all') return true;
    if (filter === 'done') return idea.status === 'accepted';
    if (filter === 'actionable') return ACTIONABLE_STATUSES.includes(idea.status);
    return idea.status === filter;
}

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
    loadError?: string | null;
    filters?: {
        status?: IdeasStatusFilter;
        search?: string;
    };
    pagination?: {
        offset: number;
        hasPrevious: boolean;
        hasNext: boolean;
        previousHref: string;
        nextHref: string;
    };
}

export function IdeasPageClient({
    initialIdeas,
    loadError = null,
    filters,
    pagination,
}: IdeasPageClientProps) {
    const t = useTranslations('dashboard.ideasPage');
    const [ideas, setIdeas] = useState(initialIdeas);
    const [draft, setDraft] = useState('');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    const [isCreating, startCreating] = useTransition();
    const [isBuilding, startBuilding] = useTransition();
    let [statusFilter, setStatusFilter] = useState<string>(filters?.status ?? 'actionable');
    useEffect(() => {
        setStatusFilter(filters?.status ?? 'actionable');
    }, [filters?.status]);

    const startFromPrompt = useStartFromPrompt();

    const handleQuickAdd = () => {
        const description = draft.trim();
        if (description.length < 10) {
            toast.error(t('quickAdd.minLength'));
            return;
        }
        const uploadsInProgress = attachments.some(
            (a) => (a.kind === 'file' || a.kind === 'folder-file') && a.uploading,
        );
        if (uploadsInProgress) {
            toast.error('Wait for attachments to finish uploading before starting the chat.');
            return;
        }
        const failedUploads = attachments.some(
            (a) => (a.kind === 'file' || a.kind === 'folder-file') && a.error,
        );
        if (failedUploads) {
            toast.error('Remove failed attachments before starting the chat.');
            return;
        }
        // The quick-add composer no longer creates an Idea inline.
        // Instead the prompt is handed off to the chat AI (which can
        // refine the brief, suggest categories, etc); the existing
        // Ideas list IS the canvas where the new Idea will appear
        // once chat confirms creation. Single source of truth for
        // "create from a prompt" lives in the chat side panel.
        startCreating(() => {
            startFromPrompt(description, {
                intent: 'Idea',
                attachments: buildAttachmentRefs(attachments),
            });
            setDraft('');
        });
    };

    const handleDismissed = (id: string) => {
        setIdeas((prev) => {
            const next = prev.map((idea) =>
                idea.id === id ? { ...idea, status: 'dismissed' as const } : idea,
            );
            return next.filter((idea) => ideaMatchesFilter(idea, filters?.status));
        });
    };

    const handleQueueBuild = (id: string) => {
        startBuilding(async () => {
            try {
                const { idea } = await buildIdeaAction(id);
                setIdeas((prev) =>
                    prev
                        .map((row) => (row.id === id ? idea : row))
                        .filter((row) => ideaMatchesFilter(row, filters?.status)),
                );
                toast.success(t('toasts.ideaQueued'));
            } catch {
                // Security: never expose raw error messages (may contain internal details, API keys, stack fragments)
                toast.error(t('toasts.ideaQueueError'));
            }
        });
    };

    return (
        <div className="w-full">
            {/* Header — title + subtitle take the full row width and
                the gears menu floats to the far right so the subtitle
                isn't truncated next to it. */}
            <PageHeader
                icon={Lightbulb}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="idea"
                actions={
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="shrink-0 gap-1.5"
                                aria-label={t('gears.menuLabel')}
                            >
                                <SettingsIcon className="w-4 h-4" aria-hidden="true" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuLabel>{t('gears.menuLabel')}</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <Link
                                    href="/settings/work-agent#auto-generate-ideas"
                                    className="w-full text-left"
                                >
                                    {t('gears.autoGenerate')}
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link
                                    href="/settings/work-agent#auto-build-works"
                                    className="w-full text-left"
                                >
                                    {t('gears.autoBuild')}
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link
                                    href="/settings/work-agent#auto-retry"
                                    className="w-full text-left"
                                >
                                    {t('gears.autoRetry')}
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link
                                    href="/settings/work-agent#account-budgets"
                                    className="w-full text-left"
                                >
                                    {t('gears.accountBudgets')}
                                </Link>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                }
            />

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
                    submitTitle="Start in chat"
                    testId="ideas-quick-add"
                    onAttachmentsChange={setAttachments}
                />
            </div>

            <form className="mb-5 flex flex-col gap-2 @lg/main:flex-row @lg/main:items-end">
                <label className="flex-1 min-w-0">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('filterBar.search')}
                    </span>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted dark:text-text-muted-dark pointer-events-none" />
                        <input
                            name="search"
                            defaultValue={filters?.search ?? ''}
                            placeholder={t('filterBar.searchPlaceholder')}
                            maxLength={500}
                            className="w-full rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark pl-9 pr-4 py-2 h-9 text-xs text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark hover:border-border-secondary dark:hover:border-border-secondary-dark focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20 transition-colors outline-none"
                        />
                    </div>
                </label>
                <div className="min-w-44">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('filterBar.status')}
                    </span>
                    <input type="hidden" name="status" value={statusFilter} />
                    <Select value={statusFilter} onValueChange={setStatusFilter} size="xs">
                        {STATUS_FILTER_ORDER.map((status) => (
                            <option key={status} value={status}>
                                {status === 'actionable' ? 'Actionable' : t(`filters.${status}`)}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                        {t('filterBar.apply')}
                    </Button>
                    <Link
                        href={ROUTES.DASHBOARD_IDEAS}
                        className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                    >
                        {t('filterBar.reset')}
                    </Link>
                </div>
            </form>

            {loadError ? (
                <div
                    role="alert"
                    className="mb-5 rounded-lg border border-danger/30 bg-danger/5 p-4"
                >
                    <p className="text-sm font-medium text-danger">Could not load Ideas.</p>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {loadError}
                    </p>
                </div>
            ) : null}

            {/* Sorted list */}
            {!loadError && ideas.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 bg-surface/40 dark:bg-surface-dark/30 p-8 text-center">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-concept-ideas/20 bg-concept-ideas/10">
                        <Lightbulb className="w-4 h-4 text-concept-ideas" />
                    </div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('empty.title')}
                    </p>
                    <p className="mx-auto mt-1 max-w-xl text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty.subtitle')}
                    </p>
                </div>
            ) : null}
            {!loadError && ideas.length > 0 ? (
                <div
                    className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4"
                    aria-busy={isBuilding}
                >
                    {ideas
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
                                onQueueBuild={handleQueueBuild}
                            />
                        ))}
                </div>
            ) : null}

            {!loadError && pagination && (pagination.hasPrevious || pagination.hasNext) ? (
                <nav className="mt-5 flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    {ideas.length > 0 ? (
                        <span>
                            Showing {pagination.offset + 1}-{pagination.offset + ideas.length}
                        </span>
                    ) : (
                        <span>No results on this page</span>
                    )}
                    <div className="flex items-center gap-2">
                        {pagination.hasPrevious ? (
                            <Link
                                href={pagination.previousHref}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                Previous
                            </Link>
                        ) : null}
                        {pagination.hasNext ? (
                            <Link
                                href={pagination.nextHref}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                Next
                            </Link>
                        ) : null}
                    </div>
                </nav>
            ) : null}
        </div>
    );
}

export { ACTIONABLE_STATUSES };
export { ROUTES as IDEAS_PAGE_ROUTES };
