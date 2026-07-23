'use client';

import { useState, useTransition, useEffect } from 'react';
import { Target, Search, PenLine } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import {
    PromptComposer,
    buildAttachmentRefs,
    type ComposerAttachment,
} from '@/components/common/PromptComposer';
import { PageHeader } from '@/components/common/PageHeader';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import { ROUTES } from '@/lib/constants';
import { MissionCard } from './MissionCard';
import type { Mission, MissionStatus } from '@/lib/api/missions';

const MISSION_STATUSES: MissionStatus[] = ['active', 'paused', 'completed', 'failed'];

interface MissionsListProps {
    missions: Mission[];
    loadError?: string | null;
    filters?: {
        status?: MissionStatus;
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

/**
 * Phase 6 PR Q + UI polish — Missions catalog list client.
 *
 * Spec: simple grid of MissionCards with a quick-add composer at
 * the top so the user can describe a new Mission inline (mirrors
 * `/ideas`, see [IdeasPageClient.tsx]). The composer matches the
 * marketing site's landing prompt (typewriter placeholder, arrow
 * submit inside the input) so first-time and returning users see
 * the same shape.
 *
 * The sidebar's "+ New" still routes to `/new?type=mission` for
 * the chip-aware unified entry point — this page hosts the
 * Mission-only composer.
 */

const MISSION_PLACEHOLDERS: ReadonlyArray<string> = [
    'e.g. "Curate the best AI coding assistants and refresh the list weekly"',
    'e.g. "Maintain a directory of remote-friendly climate-tech companies"',
    'e.g. "Track new MCP servers shipped each week and tag the standout ones"',
    'e.g. "Publish a fresh investor-targeted comparison of OSS observability tools every month"',
    'e.g. "Keep an awesome-list of TypeScript ESLint rules in sync with the latest releases"',
    'e.g. "Spin up a niche directory of Tailwind component libraries and refresh metadata"',
];

export function MissionsList({
    missions,
    loadError = null,
    filters,
    pagination,
}: MissionsListProps) {
    const t = useTranslations('dashboard.missionsPage');
    const [draft, setDraft] = useState('');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    const [submitting, startSubmit] = useTransition();
    let [statusFilter, setStatusFilter] = useState(filters?.status ?? '');
    useEffect(() => {
        setStatusFilter(filters?.status ?? '');
    }, [filters?.status]);
    const startFromPrompt = useStartFromPrompt();

    const submit = () => {
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
        // The quick-add composer no longer creates a Mission inline.
        // Instead it hands the prompt off to the chat AI (which can
        // ask the user to confirm details, suggest a schedule, etc),
        // and the existing /missions list itself is the canvas where
        // the Mission will appear once chat confirms creation. This
        // matches the pattern on /new — a single source of truth for
        // "I'm trying to create something" is the chat side panel.
        startSubmit(() => {
            const handedOff = startFromPrompt(description, {
                intent: 'Mission',
                attachments: buildAttachmentRefs(attachments),
            });
            // `startFromPrompt` returns false when the chat context isn't
            // mounted — previously that silently swallowed the prompt and the
            // user was left staring at an unchanged page. Keep their draft and
            // point them at the deterministic create form instead.
            if (!handedOff) {
                toast.error(t('newPage.chatUnavailable'));
                return;
            }
            setDraft('');
        });
    };

    return (
        <div className="w-full">
            {/* Header */}
            <PageHeader icon={Target} title={t('title')} subtitle={t('subtitle')} tone="mission" />

            {/* Quick-add composer — modeled on the marketing site's
                landing prompt. Used by both empty and populated
                states so the entry point doesn't move around as the
                user's catalog grows. */}
            <div className="mb-6 lg:mb-20 mt-8">
                <label
                    htmlFor="missions-quick-add"
                    className="block text-xs mb-4 font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                >
                    {t('quickAdd.label')}
                </label>
                <PromptComposer
                    inputId="missions-quick-add"
                    value={draft}
                    onChange={setDraft}
                    onSubmit={submit}
                    submitting={submitting}
                    placeholderExamples={MISSION_PLACEHOLDERS}
                    ariaLabel={t('quickAdd.label')}
                    submitTitle="Start in chat"
                    testId="missions-quick-add"
                    onAttachmentsChange={setAttachments}
                />

                {/* Deterministic, no-AI path. The composer above hands the
                    prompt to the chat AI and only creates a Mission if the
                    model calls the createMission tool; this bar links to the
                    manual form at /missions/new, mirroring /ideas. */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/60 dark:bg-surface-dark/60 px-4 py-3">
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('newPage.or')}
                    </p>
                    <Button
                        href={ROUTES.DASHBOARD_MISSIONS_NEW}
                        variant="secondary"
                        size="sm"
                        className="gap-1.5"
                    >
                        <PenLine className="w-3.5 h-3.5" />
                        {t('newPage.link')}
                    </Button>
                </div>
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
                <div className="min-w-40">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('filterBar.status')}
                    </span>
                    <input type="hidden" name="status" value={statusFilter} />
                    <Select
                        value={statusFilter}
                        onValueChange={setStatusFilter}
                        placeholder={t('filterBar.anyStatus')}
                        size="xs"
                    >
                        <option value="">{t('filterBar.anyStatus')}</option>
                        {MISSION_STATUSES.map((status) => (
                            <option key={status} value={status}>
                                {status}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                        {t('filterBar.apply')}
                    </Button>
                    <Button href={ROUTES.DASHBOARD_MISSIONS} size="sm" variant="ghost">
                        {t('filterBar.reset')}
                    </Button>
                </div>
            </form>

            {loadError ? (
                <div
                    role="alert"
                    className="mb-5 rounded-lg border border-danger/30 bg-danger/5 p-4"
                >
                    <p className="text-sm font-medium text-danger">Could not load Missions.</p>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {loadError}
                    </p>
                </div>
            ) : null}

            {/* List */}
            {!loadError ? (
                missions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 bg-surface/40 dark:bg-surface-dark/30 p-8 text-center">
                        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-concept-missions/20 bg-concept-missions/10">
                            <Target className="w-4 h-4 text-concept-missions" />
                        </div>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('empty.title')}
                        </p>
                        <p className="mx-auto mt-1 max-w-2xl text-xs text-text-muted dark:text-text-muted-dark">
                            {t('empty.subtitle')}
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                        {missions.map((m) => (
                            <MissionCard key={m.id} mission={m} />
                        ))}
                    </div>
                )
            ) : null}

            {!loadError && pagination && (pagination.hasPrevious || pagination.hasNext) ? (
                <nav className="mt-5 flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    {missions.length > 0 ? (
                        <span>
                            Showing {pagination.offset + 1}-{pagination.offset + missions.length}
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
