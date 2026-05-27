'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
    BookOpen,
    Bot,
    Files,
    FolderOpen,
    Globe,
    Lightbulb,
    ListChecks,
    Star,
    Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { PromptComposer } from '@/components/common/PromptComposer';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { useChatPanel } from '@/lib/hooks/use-chat-panel';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import { createMissionAction } from '@/app/actions/dashboard/missions';

/**
 * Unified `/new` page — single prompt input + chips for every
 * creatable kind. No "Create Work Manually" / "Import Existing"
 * affordances here: those live on `/works/new` so this page stays
 * focused on the conversational entry point.
 *
 * Chip → submit routing:
 *   - mission / idea  — created inline via server actions.
 *   - agent / task    — route to their respective `/new` pages with
 *                       the prompt prefilled (one-pager creators
 *                       there collect any remaining bits and persist).
 *   - website + 4 work kinds — forwarded to `/works/new` with the
 *                       prompt and the selected kind preserved.
 *
 * The chat panel is auto-collapsed on mount so the prompt + chips
 * get the full main column on first land. Users can reopen it from
 * the layout's chat handle if they want it back.
 */
export type ChipType =
    | 'mission'
    | 'idea'
    | 'agent'
    | 'task'
    | 'website'
    | 'landing-page'
    | 'blog'
    | 'directory'
    | 'awesome-repo';

const CHIP_ORDER: ChipType[] = [
    'mission',
    'idea',
    'agent',
    'task',
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
];

const CHIP_ICONS: Record<ChipType, LucideIcon> = {
    mission: Target,
    idea: Lightbulb,
    agent: Bot,
    task: ListChecks,
    website: Globe,
    'landing-page': Files,
    blog: BookOpen,
    // Distinct icon from `landing-page` — Greptile P2: shared `Files`
    // makes the two chips visually indistinguishable in the chip row.
    directory: FolderOpen,
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
    agent: [
        'e.g. "Research assistant that fetches AI safety papers and summarizes them weekly"',
        'e.g. "Content editor that rewrites our directory descriptions in a consistent voice"',
        'e.g. "Release-notes drafter that watches a repo and proposes draft notes"',
        'e.g. "PR triage agent that labels new community PRs and suggests reviewers"',
    ],
    task: [
        'e.g. "Audit the Mission backlog and tag stale items for review"',
        'e.g. "Run the weekly data refresh for the AI tools directory"',
        'e.g. "Draft the launch checklist for the new website template"',
        'e.g. "Sync website copy with the latest pricing changes"',
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

const CHIP_INTENT_LABEL: Record<ChipType, string> = {
    mission: 'Mission',
    idea: 'Idea',
    agent: 'Agent',
    task: 'Task',
    website: 'website',
    'landing-page': 'landing page',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome list repo',
};

const CHIP_TO_CANVAS_ROUTE: Partial<Record<ChipType, string>> = {
    agent: ROUTES.DASHBOARD_AGENT_NEW,
    task: ROUTES.DASHBOARD_TASK_NEW,
    website: ROUTES.DASHBOARD_WORKS_NEW,
    'landing-page': ROUTES.DASHBOARD_WORKS_NEW,
    blog: ROUTES.DASHBOARD_WORKS_NEW,
    directory: ROUTES.DASHBOARD_WORKS_NEW,
    'awesome-repo': ROUTES.DASHBOARD_WORKS_NEW,
};

const CHIP_TO_WORK_KIND: Partial<Record<ChipType, string>> = {
    website: 'website',
    'landing-page': 'landing-page',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome-repo',
};

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
    const startFromPrompt = useStartFromPrompt();

    // Close the layout chat panel on mount so the prompt + chips
    // take the full main column. We depend ONLY on the (stable)
    // setter — not the whole context object — because the context
    // value is recreated on every `open` flip, so depending on
    // `chat` would re-fire `setOpen(false)` the moment the user
    // re-opens the panel and lock them out. The setter itself is
    // memoised by the provider so this effectively runs once on
    // mount. Hook is null-safe when rendered outside the dashboard
    // layout (e.g. previews/tests).
    const chat = useChatPanel();
    const setChatOpen = chat?.setOpen;
    useEffect(() => {
        setChatOpen?.(false);
    }, [setChatOpen]);

    const submit = () => {
        const description = prompt.trim();
        if (description.length < 10) {
            toast.error(t('hints.minLength'));
            return;
        }
        startSubmit(async () => {
            // Special case: Mission with a template-id in scope.
            // `/new?type=mission&template=<id>` comes from "Use this
            // template" buttons elsewhere in the app and needs the
            // template persisted as `missionTemplateRepo` on the new
            // Mission. The chat AI doesn't yet have a template-aware
            // Mission-creation tool, so dropping the id would silently
            // lose the template link (Greptile P1 on PR #1038). Keep
            // the legacy inline-create path here.
            //
            // Importantly, we DO NOT then send the same prompt into
            // the chat AI: the chat has `createMission` registered as
            // a tool and the system prompt instructs it to use tools
            // for mutations (Codex P2), so re-sending "I want to
            // create a Mission. <description>" would trigger a SECOND
            // non-template Mission creation. Just open the panel so
            // the user can iterate manually if they want, but don't
            // dispatch a message.
            if (selectedChip === 'mission' && initialTemplateId) {
                try {
                    const mission = await createMissionAction({
                        description,
                        type: 'one-shot',
                        missionTemplateRepo: initialTemplateId,
                    });
                    toast.success(t('toasts.missionCreated'));
                    setChatOpen?.(true);
                    router.push(ROUTES.DASHBOARD_MISSION(mission.id));
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : t('toasts.submitError'));
                }
                return;
            }

            // Send the prompt into the chat AI so the user can keep
            // iterating in chat — replaces the old "submit + redirect
            // with the same prompt pre-filled" pattern. The chat AI's
            // currentPageUrl context tells it where the user is, and
            // the intent prefix narrows it further.
            startFromPrompt(description, { intent: CHIP_INTENT_LABEL[selectedChip] });

            // Then navigate to the canvas for that intent. The canvas
            // page does NOT pre-fill the prompt — the user already
            // sent it, chat is the live channel from here on. The
            // canvas is for optional manual editing of the entity.
            if (selectedChip === 'mission') {
                router.push(ROUTES.DASHBOARD_MISSIONS);
                return;
            }
            if (selectedChip === 'idea') {
                router.push(ROUTES.DASHBOARD_IDEAS);
                return;
            }
            const canvasRoute = CHIP_TO_CANVAS_ROUTE[selectedChip];
            const workKind = CHIP_TO_WORK_KIND[selectedChip];
            if (canvasRoute && workKind) {
                // Work canvases need `mode=ai` so /works/new skips its
                // own composer entry view and renders the form. They
                // also need `kind` so the AI generator hints at the
                // right Work shape. Critically, no `prompt=` — the
                // chat already carries it.
                const params = new URLSearchParams({ mode: 'ai', kind: workKind });
                router.push(`${canvasRoute}?${params.toString()}`);
                return;
            }
            if (canvasRoute) {
                router.push(canvasRoute);
                return;
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
                                            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors whitespace-nowrap',
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
        </div>
    );
}
