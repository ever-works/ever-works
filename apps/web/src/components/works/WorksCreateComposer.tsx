'use client';

import { useMemo, useState, useTransition } from 'react';
import { BookOpen, Files, FolderInput, FolderOpen, Globe, PenLine, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { PromptComposer } from '@/components/common/PromptComposer';
import { PromptChipsRow, type PromptChip } from '@/components/common/PromptChipsRow';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';

/**
 * Dashboard polish (2026-05-27) — Work-specific composer mounted at
 * the top of `/works`. Same shape as `MissionsList` (PromptComposer +
 * chips) and the entry view of `/works/new`, but routes the submit
 * into the existing `/works/new?mode=ai&kind=…` flow instead of
 * persisting inline.
 *
 * Mirrors `NewPageClient` / `NewWorkClient` deliberately:
 *   - The same Work kinds (no Mission/Idea — this is /works).
 *   - The same icons and placeholder examples per kind.
 *   - The same two affordances below the input: "Create Work
 *     Manually" → `/works/new?mode=manual`, "Import Existing Work"
 *     → `/works/new?mode=import`. We do NOT introduce a second
 *     creation surface — the canvas pages are the same.
 */
type InitialWorkKind = 'website' | 'landing-page' | 'blog' | 'directory' | 'awesome-repo';

const WORK_KIND_ORDER: InitialWorkKind[] = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
];

const WORK_KIND_ICONS: Record<InitialWorkKind, LucideIcon> = {
    website: Globe,
    'landing-page': Files,
    blog: BookOpen,
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

const KIND_INTENT_LABEL: Record<InitialWorkKind, string> = {
    website: 'website',
    'landing-page': 'landing page',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome list repo',
};

export function WorksCreateComposer() {
    const t = useTranslations('dashboard.workCreation');
    const router = useRouter();
    const [prompt, setPrompt] = useState('');
    const [selectedKind, setSelectedKind] = useState<InitialWorkKind>('website');
    const [submitting, startSubmit] = useTransition();
    const startFromPrompt = useStartFromPrompt();

    const placeholderExamples = useMemo(
        () => PLACEHOLDERS_BY_KIND[selectedKind] ?? PLACEHOLDERS_BY_KIND.website,
        [selectedKind],
    );

    const chips: ReadonlyArray<PromptChip<InitialWorkKind>> = useMemo(
        () =>
            WORK_KIND_ORDER.map((k) => ({
                value: k,
                label: t(`kinds.${k}`),
                Icon: WORK_KIND_ICONS[k],
            })),
        [t],
    );

    const submit = () => {
        const description = prompt.trim();
        if (description.length < 10) {
            toast.error(t('promptHints.minLength'));
            return;
        }
        startSubmit(() => {
            // Send the prompt into chat so the AI can iterate while the
            // user lands on the AI form. `/works/new?mode=ai&kind=…`
            // skips the entry view and renders the form directly.
            startFromPrompt(description, { intent: KIND_INTENT_LABEL[selectedKind] });
            const params = new URLSearchParams({ mode: 'ai', kind: selectedKind });
            router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?${params.toString()}`);
        });
    };

    return (
        <div className="mb-8 space-y-3">
            <PromptComposer
                inputId="works-quick-add"
                value={prompt}
                onChange={setPrompt}
                onSubmit={submit}
                submitting={submitting}
                placeholderExamples={placeholderExamples}
                rows={4}
                ariaLabel={t('promptLabel')}
                submitTitle={t('promptHints.submitTitle')}
                testId="works-quick-add"
                chipsBelow={
                    <div className="space-y-2">
                        <PromptChipsRow<InitialWorkKind>
                            chips={chips}
                            value={selectedKind}
                            onChange={(v) => v && setSelectedKind(v)}
                            ariaLabel={t('promptLabel')}
                            testIdPrefix="works-quick-add"
                        />
                        <p className="text-xs text-text-muted dark:text-text-muted-dark px-1">
                            {t(`kindDescriptions.${selectedKind}`)}
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
                        onClick={() =>
                            router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?mode=manual`)
                        }
                    >
                        <PenLine className="w-3.5 h-3.5" />
                        {t('buttons.manual')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="gap-1.5"
                        onClick={() =>
                            router.push(`${ROUTES.DASHBOARD_WORKS_NEW}?mode=import`)
                        }
                    >
                        <FolderInput className="w-3.5 h-3.5" />
                        {t('buttons.import')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
