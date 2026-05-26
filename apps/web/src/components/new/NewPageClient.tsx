'use client';

import { useMemo, useState, useTransition } from 'react';
import {
    BookOpen,
    Files,
    FolderInput,
    Globe,
    Lightbulb,
    PenLine,
    Star,
    Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PromptComposer } from '@/components/common/PromptComposer';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { createMissionAction } from '@/app/actions/dashboard/missions';
import { createIdeaAction } from '@/app/actions/dashboard/work-proposals';

/**
 * Phase 6.5 PR CC2 + UI polish — unified `/new` page.
 *
 * Single creation entry point per spec §8b. Composer matches the
 * marketing site's landing prompt — a rounded card on the page's
 * dark background with chips below the input and an arrow submit
 * inside the composer. The previous "Create" button + chip hint
 * are gone: a chip is always preselected (Mission for new users,
 * Idea for users with existing Missions), so the "Pick a chip to
 * enable Create" hint never served a purpose.
 *
 * Selecting a chip swaps the typewriter placeholder list AND
 * surfaces a one-line description of what that kind is, so the
 * user gets the same affordance the marketing site shows.
 */
export type ChipType =
    | 'mission'
    | 'idea'
    | 'website'
    | 'landing-page'
    | 'blog'
    | 'directory'
    | 'awesome-repo';

const CHIP_ORDER: ChipType[] = [
    'mission',
    'idea',
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
];

const CHIP_ICONS: Record<ChipType, LucideIcon> = {
    mission: Target,
    idea: Lightbulb,
    website: Globe,
    'landing-page': Files,
    blog: BookOpen,
    directory: Files,
    'awesome-repo': Star,
};

const PLACEHOLDERS_BY_CHIP: Record<ChipType, ReadonlyArray<string>> = {
    mission: [
        'e.g. "Curate the best AI coding assistants and refresh the list weekly"',
        'e.g. "Maintain a directory of remote-friendly climate-tech companies"',
        'e.g. "Track new MCP servers shipped each week and tag the standout ones"',
        'e.g. "Publish a fresh investor-targeted comparison of OSS observability tools monthly"',
        'e.g. "Keep an awesome-list of TypeScript ESLint rules in sync with the latest releases"',
    ],
    idea: [
        'e.g. "A curated list of the best AI coding agents released this year"',
        'e.g. "Awesome list: best React state-management libraries with benchmarks"',
        'e.g. "Directory of MCP servers — capabilities, language, install command, source repo"',
        'e.g. "Knowledge base for our open-source SDK with search and versioning"',
        'e.g. "Blog about indie game development with categories for postmortems and tooling"',
    ],
    website: [
        'e.g. "Modern website for a boutique design studio with case studies and a contact form"',
        'e.g. "Marketing site for a B2B SaaS with pricing, integrations, and a documentation hub"',
        'e.g. "Portfolio for a freelance photographer with galleries by genre and testimonials"',
        'e.g. "Five-page site for my dentist practice with services, team, and online booking"',
        'e.g. "Non-profit site with donation flow, programs, impact stats, and volunteer signup"',
    ],
    'landing-page': [
        'e.g. "Waitlist landing page for an AI customer-support copilot with a hero demo and FAQ"',
        'e.g. "Product launch page for noise-cancelling earbuds with specs, video, and pre-order CTA"',
        'e.g. "Lead-magnet landing page for a free SaaS pricing benchmark report"',
        'e.g. "Webinar registration page with speaker bios, agenda, and a countdown timer"',
        'e.g. "Comparison landing page: us vs. <competitor> with feature matrix and migration guide"',
    ],
    blog: [
        'e.g. "Personal blog about indie game development with postmortems and tooling tags"',
        'e.g. "Engineering blog with RSS, code-highlighting, author pages, and OG previews"',
        'e.g. "AI research summaries blog — daily 200-word paper rundowns with citations"',
        'e.g. "Founder journal — weekly progress logs tagged for revenue, hiring, product"',
        'e.g. "Recipe blog with structured data, ingredient scaler, and category filters"',
    ],
    directory: [
        'e.g. "Directory of AI coding assistants with reviews, pricing tiers, and editor compatibility"',
        'e.g. "Directory of agent skills for Claude Code — categories, install instructions, demos"',
        'e.g. "Directory of remote-first companies with timezone overlap, perks, and stack tags"',
        'e.g. "Directory of climate-tech startups by sub-sector with funding stage and team size"',
        'e.g. "Directory of MCP servers — capabilities, language, install command, source repo"',
    ],
    'awesome-repo': [
        'e.g. "Awesome list of React state-management libraries with benchmarks and trade-offs"',
        'e.g. "Awesome list of TypeScript ESLint rules with examples and when-to-disable guidance"',
        'e.g. "Awesome list of self-hostable open-source SaaS alternatives — categorized + docker-ready"',
        'e.g. "Awesome list of agent frameworks (LangChain, AutoGen, CrewAI…) with pros/cons"',
        'e.g. "Awesome list of free design resources for indie founders — icons, illustrations, fonts"',
    ],
};

export interface NewPageClientProps {
    initialType?: ChipType | null;
    initialPrompt?: string;
    initialTemplateId?: string;
}

export function NewPageClient({
    initialType = 'mission',
    initialPrompt,
    initialTemplateId,
}: NewPageClientProps) {
    const t = useTranslations('dashboard.newPage');
    const router = useRouter();
    const [prompt, setPrompt] = useState(initialPrompt ?? '');
    const [selectedChip, setSelectedChip] = useState<ChipType>(initialType ?? 'mission');
    const [submitting, startSubmit] = useTransition();

    const submit = () => {
        const description = prompt.trim();
        if (description.length < 10) {
            toast.error(t('hints.minLength'));
            return;
        }
        startSubmit(async () => {
            try {
                if (selectedChip === 'mission') {
                    const mission = await createMissionAction({
                        description,
                        type: 'one-shot',
                        ...(initialTemplateId ? { missionTemplateRepo: initialTemplateId } : {}),
                    });
                    toast.success(t('toasts.missionCreated'));
                    router.push(ROUTES.DASHBOARD_MISSION(mission.id));
                    return;
                }
                if (selectedChip === 'idea') {
                    await createIdeaAction({ description });
                    toast.success(t('toasts.ideaCreated'));
                    router.push(ROUTES.DASHBOARD_IDEAS);
                    return;
                }
                // The remaining 5 chip types route into the existing
                // /works/new flow.
                const params = new URLSearchParams({
                    mode: 'ai',
                    kind: selectedChip,
                    prompt: description.slice(0, 4000),
                });
                router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.submitError'));
            }
        });
    };

    // Per-chip placeholder cycle. New reference on each chip flip
    // resets the typewriter inside PromptComposer.
    const placeholderExamples = useMemo(
        () => PLACEHOLDERS_BY_CHIP[selectedChip] ?? PLACEHOLDERS_BY_CHIP.mission,
        [selectedChip],
    );

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-secondary dark:text-text-secondary-dark mt-1">
                    {t('subtitle')}
                </p>
            </div>

            {/* Composer with chips below — sits directly on the page's
                dark background, no nested card wrapper. */}
            <PromptComposer
                inputId="new-prompt"
                value={prompt}
                onChange={setPrompt}
                onSubmit={submit}
                submitting={submitting}
                placeholderExamples={placeholderExamples}
                rows={5}
                ariaLabel={t('promptLabel')}
                submitTitle={t('submitTitle')}
                testId="new-prompt"
                belowInput={
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            {CHIP_ORDER.map((c) => {
                                const Icon = CHIP_ICONS[c];
                                const active = selectedChip === c;
                                return (
                                    <button
                                        key={c}
                                        type="button"
                                        onClick={() => setSelectedChip(c)}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                                            active
                                                ? 'border-primary/60 bg-primary/10 text-primary shadow-sm'
                                                : 'border-border/60 dark:border-white/10 bg-transparent text-text-secondary dark:text-text-secondary-dark hover:border-primary/40',
                                        )}
                                        aria-pressed={active}
                                    >
                                        <Icon className="w-3.5 h-3.5" />
                                        {t(`chips.${c}`)}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t(`chipDescriptions.${selectedChip}`)}
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
                        onClick={() => {
                            const params = new URLSearchParams({ mode: 'manual' });
                            if (prompt.trim().length > 0) {
                                params.set('prompt', prompt.trim().slice(0, 4000));
                            }
                            router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
                        }}
                    >
                        <PenLine className="w-3.5 h-3.5" />
                        {t('cards.manual.title')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                            const params = new URLSearchParams({ mode: 'import' });
                            router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
                        }}
                    >
                        <FolderInput className="w-3.5 h-3.5" />
                        {t('cards.import.title')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
