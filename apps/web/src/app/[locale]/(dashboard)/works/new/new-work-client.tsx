'use client';

import { useMemo, useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { WorkAICreator } from '@/components/works/WorkAICreator';
import { WorkImportForm } from '@/components/works/WorkImportForm';
import { GitProviderSelector } from './git-provider-selector';
import { DeployProviderSelector, type DeployProvider } from './deploy-provider-selector';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    BookOpen,
    Building2,
    Files,
    FolderInput,
    FolderKanban,
    FolderOpen,
    Globe,
    PenLine,
    Star,
    Store,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    PromptComposer,
    buildAttachmentRefs,
    type ComposerAttachment,
} from '@/components/common/PromptComposer';
import { PromptChipsRow, type PromptChip } from '@/components/common/PromptChipsRow';
import { PageHeader } from '@/components/common/PageHeader';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import type { ProviderWithConnection } from './page';
import type { WebsiteTemplateOption } from '@/lib/api/work';
import type { WorkProposal } from '@/lib/api/work-proposals';

export type CreationMode = 'ai' | 'manual' | 'import';

type InitialWorkKind = 'website' | 'landing-page' | 'blog' | 'directory' | 'awesome-repo';

const WORK_KIND_ORDER: InitialWorkKind[] = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
];

/**
 * Every work-kind chip value gated by a `works-<value>` PostHog flag
 * (fail-open — see `@/lib/feature-flags/work-kinds`). Live kinds plus the
 * baseline coming-soon `store`/`company` so the server page resolves one
 * flag set covering the whole catalog.
 */
export const ALL_WORK_KIND_CHIP_VALUES: ReadonlyArray<InitialWorkKind | 'store' | 'company'> = [
    ...WORK_KIND_ORDER,
    'store',
    'company',
];

const WORK_KIND_ICONS: Record<InitialWorkKind, LucideIcon> = {
    website: Globe,
    'landing-page': Files,
    blog: BookOpen,
    // Distinct icon from `landing-page` — Greptile P2: shared `Files`
    // makes the two chips visually indistinguishable in the chip row.
    directory: FolderOpen,
    'awesome-repo': Star,
};

const PLACEHOLDERS_BY_KIND: Record<InitialWorkKind, ReadonlyArray<string>> = {
    website: [
        'e.g. "Modern website for a boutique design studio with case studies and a contact form"',
        'e.g. "Marketing site for a B2B SaaS with pricing, integrations, and a documentation hub"',
        'e.g. "Portfolio for a freelance photographer with galleries by genre and testimonials"',
        'e.g. "Five-page site for my dentist practice with services, team, and online booking"',
    ],
    'landing-page': [
        'e.g. "Waitlist landing page for an AI customer-support copilot with a hero demo and FAQ"',
        'e.g. "Product launch page for noise-cancelling earbuds with specs, video, and pre-order CTA"',
        'e.g. "Lead-magnet landing page for a free SaaS pricing benchmark report"',
        'e.g. "Webinar registration page with speaker bios, agenda, and a countdown timer"',
    ],
    blog: [
        'e.g. "Personal blog about indie game development with postmortems and tooling tags"',
        'e.g. "Engineering blog with RSS, code-highlighting, author pages, and OG previews"',
        'e.g. "AI research summaries blog — daily 200-word paper rundowns with citations"',
        'e.g. "Founder journal — weekly progress logs tagged for revenue, hiring, product"',
    ],
    directory: [
        'e.g. "Directory of AI coding assistants with reviews, pricing tiers, and editor compatibility"',
        'e.g. "Directory of agent skills for Claude Code — categories, install instructions, demos"',
        'e.g. "Directory of remote-first companies with timezone overlap, perks, and stack tags"',
        'e.g. "Directory of climate-tech startups by sub-sector with funding stage and team size"',
    ],
    'awesome-repo': [
        'e.g. "Awesome list of React state-management libraries with benchmarks and trade-offs"',
        'e.g. "Awesome list of TypeScript ESLint rules with examples and when-to-disable guidance"',
        'e.g. "Awesome list of self-hostable open-source SaaS alternatives — categorized + docker-ready"',
        'e.g. "Awesome list of agent frameworks (LangChain, AutoGen, CrewAI…) with pros/cons"',
    ],
};

interface NewWorkClientProps {
    user: AuthUser;
    providers: ProviderWithConnection[];
    defaultProviderId: string | null;
    deployProviders: DeployProvider[];
    defaultDeployProviderId: string | null;
    websiteTemplates: WebsiteTemplateOption[];
    proposal?: WorkProposal | null;
    initialMode?: CreationMode | null;
    initialPrompt?: string;
    initialKind?: InitialWorkKind | null;
    /**
     * Work-kind chip values whose `works-<value>` PostHog flag resolved
     * to an explicit `false` (evaluated server-side). Defaults to `[]` →
     * everything enabled (fail-open).
     */
    disabledKinds?: string[];
}

export default function NewWorkClient({
    user,
    providers,
    defaultProviderId,
    deployProviders,
    defaultDeployProviderId,
    websiteTemplates,
    proposal,
    initialMode = null,
    initialPrompt,
    initialKind = null,
    disabledKinds = [],
}: NewWorkClientProps) {
    const [creationMode, setCreationMode] = useState<CreationMode | null>(
        proposal ? 'ai' : initialMode,
    );
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
        defaultProviderId || providers[0]?.provider.id || null,
    );
    const [selectedDeployProviderId, setSelectedDeployProviderId] = useState<string | null>(
        defaultDeployProviderId ||
            deployProviders.find((provider) => provider.enabled && provider.configured)?.id ||
            deployProviders.find((provider) => provider.enabled)?.id ||
            deployProviders[0]?.id ||
            null,
    );
    const t = useTranslations('dashboard.workCreation');

    // Composer state used by the entry view (creationMode === null).
    const [prompt, setPrompt] = useState(initialPrompt ?? '');
    const [selectedKind, setSelectedKind] = useState<InitialWorkKind>(initialKind ?? 'website');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    const [, startSubmit] = useTransition();
    const startFromPrompt = useStartFromPrompt();

    const WORK_KIND_INTENT_LABEL: Record<InitialWorkKind, string> = {
        website: 'website',
        'landing-page': 'landing page',
        blog: 'blog',
        directory: 'directory',
        'awesome-repo': 'awesome list repo',
    };

    const gitConnected = useMemo(() => {
        if (!selectedProviderId) return false;
        const selected = providers.find((p) => p.provider.id === selectedProviderId);
        return selected?.connectionInfo?.connected ?? false;
    }, [selectedProviderId, providers]);

    // `store` is now flag-controlled via `works-store` like every other
    // kind (the flag currently resolves to `false`, so the chip still
    // renders inert "Soon" today). `company` stays a hardcoded inert
    // "Soon" baseline on this surface — the live company chip lives on
    // `/new`, not `/works/new`.
    // `comingSoon` per live kind is purely driven by whether its
    // `works-<value>` PostHog flag resolved to `false` server-side.
    // Missing/undefined flags stay enabled (fail-open).
    const disabledSet = useMemo(() => new Set(disabledKinds), [disabledKinds]);

    // Effective selection — derived during render so a flag-disabled kind
    // is never the active selection (no effect/setState round-trip; see
    // the project's "derive state, don't store it in an effect" rule). If
    // the raw `selectedKind` is disabled, fall back to the first live kind
    // (or `website` only if every kind is disabled — degenerate config).
    // Everything that reads/acts on the selection uses `effectiveKind`, so
    // a disabled kind can never be submitted or handed off.
    const effectiveKind: InitialWorkKind = disabledSet.has(selectedKind)
        ? (WORK_KIND_ORDER.find((k) => !disabledSet.has(k)) ?? 'website')
        : selectedKind;

    const placeholderExamples = useMemo(
        () => PLACEHOLDERS_BY_KIND[effectiveKind] ?? PLACEHOLDERS_BY_KIND.website,
        [effectiveKind],
    );

    // Full work-kind chip catalog. `store` is now flag-controlled via
    // `works-store` like every other kind; `company` stays a hardcoded
    // inert "Soon" baseline here (the live Company chip lives on `/new`).
    // Both are appended after the live kinds so they match the marketing
    // site's chip catalog without breaking the existing /works/new kind
    // picker behavior.
    const workKindChips = useMemo<ReadonlyArray<PromptChip<InitialWorkKind | 'store' | 'company'>>>(
        () => [
            ...WORK_KIND_ORDER.map((k) => ({
                value: k,
                label: t(`kinds.${k}`),
                Icon: WORK_KIND_ICONS[k],
                comingSoon: disabledSet.has(k),
            })),
            // store is flag-controlled via works-store like every other kind.
            // The `works-store` PostHog flag exists as `active: false`, so
            // the chip continues to render as the inert "Soon" baseline
            // until the flag is flipped — no code change required to enable.
            // `company` stays hardcoded coming-soon here (the live company
            // chip lives on `/new`, not `/works/new`).
            {
                value: 'store' as const,
                label: 'Store',
                Icon: Store,
                comingSoon: disabledSet.has('store'),
            },
            { value: 'company' as const, label: 'Company', Icon: Building2, comingSoon: true },
        ],
        [t, disabledSet],
    );

    const submitPrompt = () => {
        const description = prompt.trim();
        if (description.length < 10) {
            toast.error(t('promptHints.minLength'));
            return;
        }
        // Send the prompt into the chat AI — the chat now drives the
        // conversation while the canvas below (the WorkAICreator form)
        // is where the user optionally edits manually. Note we DO NOT
        // pass `initialPrompt={prompt}` to WorkAICreator anymore: the
        // chat carries it, the form starts empty so the user isn't
        // re-prompted to confirm the same text twice.
        startSubmit(() => {
            startFromPrompt(description, {
                intent: WORK_KIND_INTENT_LABEL[effectiveKind],
                attachments: buildAttachmentRefs(attachments),
            });
            setPrompt('');
            setCreationMode('ai');
        });
    };

    if (creationMode === null) {
        // Entry view — prompt + kind chips + manual/import affordances.
        // Mirrors the global `/new` page but with Work-only chips
        // (no Mission/Idea) so the user can stay focused on a Work.
        return (
            <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-6">
                <PageHeader
                    icon={FolderKanban}
                    title={t('title')}
                    subtitle={t('subtitle')}
                    tone="work"
                />

                <PromptComposer
                    inputId="new-work-prompt"
                    value={prompt}
                    onChange={setPrompt}
                    onSubmit={submitPrompt}
                    placeholderExamples={placeholderExamples}
                    rows={5}
                    ariaLabel={t('promptLabel')}
                    submitTitle={t('promptHints.submitTitle')}
                    testId="new-work-prompt"
                    onAttachmentsChange={setAttachments}
                    // /works/new is the surface where importing an
                    // existing GitHub repo as a Work makes sense.
                    showImportGithubRepo
                    chipsBelow={
                        <div className="space-y-2">
                            <PromptChipsRow
                                chips={workKindChips}
                                value={effectiveKind}
                                onChange={(next) => {
                                    // `store` and `company` are inert "Soon"
                                    // chips and never get emitted — narrow
                                    // back to InitialWorkKind before
                                    // persisting.
                                    if (next === null || next === 'store' || next === 'company') {
                                        return;
                                    }
                                    setSelectedKind(next);
                                }}
                                ariaLabel={t('promptLabel')}
                                testIdPrefix="new-work-kind"
                            />
                            <p className="px-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t(`kindDescriptions.${effectiveKind}`)}
                            </p>
                        </div>
                    }
                />

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface/60 dark:bg-surface-dark/60 px-4 py-3">
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('or')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setCreationMode('manual')}
                        >
                            <PenLine className="w-3.5 h-3.5" />
                            {t('buttons.manual')}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setCreationMode('import')}
                        >
                            <FolderInput className="w-3.5 h-3.5" />
                            {t('buttons.import')}
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-wrap justify-between gap-6 w-full">
            {/* Provider Selector Sidebar — full-width at top on small, sticky right column on @lg/main+ */}
            <aside className="order-first @lg/main:order-last w-full @lg/main:w-[280px] shrink-0 @lg/main:sticky @lg/main:top-8 self-start">
                <div
                    className={cn(
                        'p-1 rounded-lg space-y-6 shadow-xs',
                        'bg-card/10 dark:bg-card-primary-dark/30',
                        'border border-card-border dark:border-border-secondary-dark',
                    )}
                >
                    <div
                        className={cn(
                            'p-4 rounded-sm relative overflow-hidden',
                            'bg-card dark:bg-card-secondary-dark/30',
                            'border border-card-border dark:border-border-secondary-dark',
                        )}
                    >
                        <div className="absolute -top-5 -right-6 w-30 h-30 rounded-full dark:bg-accent-indigo/10 bg-accent-indigo/10 blur-xl pointer-events-none" />
                        <div className="relative z-20 mb-4">
                            <h3 className="font-bold text-sm text-text dark:text-text-dark mb-2">
                                {t('sidebar.selectedProvider')}
                            </h3>
                            <GitProviderSelector
                                providers={providers}
                                selectedProviderId={selectedProviderId}
                                onSelect={setSelectedProviderId}
                                compact
                            />
                        </div>
                        {deployProviders.length > 0 && (
                            <div className="relative z-20 mb-4">
                                <h3 className="font-bold text-sm text-text dark:text-text-dark mb-2">
                                    {t('sidebar.selectedDeployProvider')}
                                </h3>
                                <DeployProviderSelector
                                    providers={deployProviders}
                                    selectedProviderId={selectedDeployProviderId}
                                    onSelect={setSelectedDeployProviderId}
                                    compact
                                />
                            </div>
                        )}
                    </div>
                </div>
            </aside>
            {/* Main Content */}
            <div className="flex-1 min-w-96">
                <div className="mb-8">
                    <button
                        onClick={() => setCreationMode(null)}
                        className="flex cursor-pointer items-center gap-2 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors mb-4"
                    >
                        <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M10 19l-7-7m0 0l7-7m-7 7h18"
                            />
                        </svg>
                        {t('backToOptions')}
                    </button>
                </div>

                {(creationMode === 'ai' || creationMode === 'manual') && (
                    /* The previously separate "Create with AI" and
                       "Create Manually" flows are merged here. The AI
                       creator carries the richer surface (name + slug
                       + prompt + advanced AI/provider settings +
                       example prompts), which is everything the
                       manual form covered plus the AI affordances. The
                       user-facing distinction is just how they arrived
                       — typing a prompt (ai) vs. clicking "Create Work
                       Manually" (manual). When the user arrived via a
                       prompt, the chat AI now carries the prompt text
                       and the form starts empty so we don't re-prompt
                       them inside the canvas. */
                    <WorkAICreator
                        gitProvider={selectedProviderId || undefined}
                        gitConnected={gitConnected}
                        deployProvider={selectedDeployProviderId || undefined}
                        websiteTemplates={websiteTemplates}
                        proposal={proposal ?? undefined}
                        initialPrompt={initialPrompt}
                        initialKind={effectiveKind || initialKind || undefined}
                    />
                )}
                {creationMode === 'import' && (
                    <WorkImportForm
                        user={user}
                        gitProvider={selectedProviderId || undefined}
                        deployProvider={selectedDeployProviderId || undefined}
                    />
                )}
            </div>
        </div>
    );
}
