'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
    BookOpen,
    Bot,
    Building2,
    Files,
    FolderOpen,
    Globe,
    Lightbulb,
    ListChecks,
    Star,
    Store,
    Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    PromptComposer,
    buildAttachmentRefs,
    type ComposerAttachment,
} from '@/components/common/PromptComposer';
import { PromptChipsRow, type PromptChip } from '@/components/common/PromptChipsRow';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useChatPanel } from '@/lib/hooks/use-chat-panel';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import { attachUploadToMissionAction, createMissionAction } from '@/app/actions/dashboard/missions';
import { RegisterCompanyDialog } from '@/components/organizations/RegisterCompanyDialog';

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
 * `store` is a catalog entry telegraphing roadmap scope (see Workspace
 * notes `2026-05-23-missions-ideas-works-spec.md` + AGENTS.md "stores
 * + companies are in-scope future use cases"). It renders as an inert
 * "Soon" chip, matching how the marketing site telegraphs it.
 *
 * EW-662 (Phase 10) — `company` graduated from inert to live: picking
 * the Company chip opens the Register-Company dialog (spec §5.4), which
 * creates an Organization with `registrationProvider = 'manual'` and
 * `registrationStatus = 'registered'`. The full Stripe Atlas SDK
 * integration is deferred to a later phase; for v1 the manual-completion
 * path is the only way Company Works produce Orgs.
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
    | 'awesome-repo'
    | 'company';

// Spec §6.3 order:
// `Mission · Idea · Website · Landing Page · Store · Blog · Directory
//  · Awesome Repo · Knowledge Base · Company`.
//
// Live chips below stay in their current order (mission first, ideas
// second, then content chips). `Company` joins at the end of the live
// chip list per the spec, sitting next to the inert `store` chip which
// is appended afterwards.
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
    'company',
];

/**
 * Every chip value whose availability is gated by a `works-<value>`
 * PostHog feature flag (fail-open — see
 * `@/lib/feature-flags/work-kinds`). Includes the live chips (which now
 * cover `company`, graduated in EW-662 Phase 10) plus the inert baseline
 * `store` so the server page can resolve one flag set covering the whole
 * catalog.
 */
export const ALL_NEW_CHIP_VALUES: ReadonlyArray<ChipType | 'store'> = [
    ...CHIP_ORDER,
    'store',
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
    // EW-662 Phase 10 — same `Building2` icon the WorkspaceSwitcher
    // empty state uses for consistency.
    company: Building2,
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
    // EW-662 Phase 10 — Company placeholders telegraph that this chip
    // ends in a registered Organization (manual-completion path for v1).
    // The prompt input is ignored on submit — the chip opens the
    // Register-Company dialog directly — but the placeholder still
    // sets context if the user lands on `?type=company` first.
    company: [
        'e.g. "Acme Inc. — an Org for our consultancy"',
        'e.g. "Globex Holdings — the umbrella entity for our product lines"',
        'e.g. "Soylent Labs — research entity for AI experimentation"',
        'e.g. "Initech LLC — billing entity for our SaaS clients"',
    ],
};

export interface NewPageClientProps {
    initialType?: ChipType | null;
    initialPrompt?: string;
    initialTemplateId?: string;
    /**
     * Work-kind chip values whose `works-<value>` PostHog flag resolved
     * to an explicit `false`. Evaluated server-side and passed down (the
     * web app keeps `posthog-js` out of the client bundle). Defaults to
     * `[]` → everything enabled (fail-open).
     */
    disabledKinds?: string[];
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
    company: 'Company',
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
    disabledKinds = [],
}: NewPageClientProps) {
    const t = useTranslations('dashboard.newPage');
    const router = useRouter();
    const [prompt, setPrompt] = useState(initialPrompt ?? '');
    const [selectedChip, setSelectedChip] = useState<ChipType>(initialType ?? 'mission');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    const [submitting, startSubmit] = useTransition();
    const startFromPrompt = useStartFromPrompt();
    // EW-662 Phase 10 — Company chip is a special chip whose submit
    // opens the Register-Company dialog instead of going through the
    // chat-AI / canvas pipeline. We hold the dialog open-state here so
    // it survives chip switches.
    const [companyDialogOpen, setCompanyDialogOpen] = useState(false);

    // Auto-open the dialog when the user lands on `/new?type=company`
    // (e.g. from the Settings → Account banner). The chip is selected
    // by the page's initialType param; we mirror that into the dialog
    // open state once on mount.
    useEffect(() => {
        if (initialType === 'company') {
            setCompanyDialogOpen(true);
        }
        // Only run on mount — chip switches are handled by the click
        // handler in PromptChipsRow below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // `buildAttachmentRefs` imported from PromptComposer — turns the
    // composer's full attachment list into chat-ready refs (filtering
    // uploads in flight + failed uploads).

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

    // Set of chip values whose `works-<value>` flag resolved to false
    // server-side. A disabled chip must never be the active selection
    // (and thus never submittable).
    const disabledSet = useMemo(() => new Set(disabledKinds), [disabledKinds]);

    // Effective selection — derived during render so a disabled chip is
    // never the active selection (no effect/setState round-trip; see the
    // project's "derive state, don't store it in an effect" rule). If the
    // raw `selectedChip` is flag-disabled, fall back to the safe default
    // (`mission` is never flag-gated here). Everything that reads/acts on
    // the selection uses `effectiveChip`, so a disabled kind can never be
    // submitted or handed off.
    const effectiveChip: ChipType = disabledSet.has(selectedChip) ? 'mission' : selectedChip;

    const submit = () => {
        // EW-662 Phase 10 — Company chip short-circuits the chat-AI
        // path. There's no prompt-to-mission/work pipeline here: the
        // user is going to register an Organization-backed Company,
        // and that flow is owned by `<RegisterCompanyDialog>` (which
        // collects the name + countryCode form). Open it and bail out
        // of the rest of the submit logic — no min-length check,
        // because the prompt input is incidental for this chip.
        // Use `effectiveChip` (not the raw selection) so a `works-company`
        // flag-disabled chip — which renders inert — can't still open the
        // register dialog via a stale selection.
        if (effectiveChip === 'company') {
            setCompanyDialogOpen(true);
            return;
        }
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
            if (effectiveChip === 'mission' && initialTemplateId) {
                try {
                    const mission = await createMissionAction({
                        description,
                        type: 'one-shot',
                        missionTemplateRepo: initialTemplateId,
                    });
                    // Wire any completed PromptComposer uploads onto the
                    // newly created Mission via the new attachments
                    // endpoint. Failures here are non-fatal: the Mission
                    // is created either way, so we toast a warning and
                    // proceed rather than rolling back. github-repo
                    // entries are skipped — they're metadata refs, not
                    // uploaded files.
                    // Single source of truth — `buildAttachmentRefs`
                    // already filters in-flight + failed uploads and
                    // carries the `uploadId` on each `upload` ref
                    // (Greptile P2 on PR #1044: avoids re-scanning the
                    // raw attachments with a divergent filter).
                    const uploadIds = buildAttachmentRefs(attachments)
                        .filter((r) => r.kind === 'upload' && r.uploadId)
                        .map((r) => r.uploadId!);
                    if (uploadIds.length > 0) {
                        const failed: string[] = [];
                        for (const uploadId of uploadIds) {
                            try {
                                await attachUploadToMissionAction(mission.id, uploadId);
                            } catch {
                                failed.push(uploadId);
                            }
                        }
                        if (failed.length > 0) {
                            toast.warning(
                                `${failed.length} attachment(s) couldn't be linked to the Mission — they're still saved in your uploads.`,
                            );
                        }
                    }
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
            startFromPrompt(description, {
                intent: CHIP_INTENT_LABEL[effectiveChip],
                attachments: buildAttachmentRefs(attachments),
            });

            // Then navigate to the canvas for that intent. The canvas
            // page does NOT pre-fill the prompt — the user already
            // sent it, chat is the live channel from here on. The
            // canvas is for optional manual editing of the entity.
            if (effectiveChip === 'mission') {
                router.push(ROUTES.DASHBOARD_MISSIONS);
                return;
            }
            if (effectiveChip === 'idea') {
                router.push(ROUTES.DASHBOARD_IDEAS);
                return;
            }
            const canvasRoute = CHIP_TO_CANVAS_ROUTE[effectiveChip];
            const workKind = CHIP_TO_WORK_KIND[effectiveChip];
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
        () => PLACEHOLDERS_BY_CHIP[effectiveChip] ?? PLACEHOLDERS_BY_CHIP.mission,
        [effectiveChip],
    );

    // Full chip catalog. `store` stays as an inert "Soon" chip,
    // appended after the live chips so it sits at the end of the
    // horizontal scroll the way the marketing site does it.
    //
    // EW-662 Phase 10 — `company` graduated from "Soon" to live; it
    // sits at the end of the live `CHIP_ORDER` list so we render it
    // automatically from the loop below. Picking it opens the
    // Register-Company dialog on submit (see `submit()` above).
    //
    // `comingSoon` per live chip is the union of its hardcoded baseline
    // and any chip whose `works-<value>` PostHog flag resolved to an
    // explicit `false` server-side. Missing/undefined flags stay enabled.
    const allChips = useMemo<ReadonlyArray<PromptChip<ChipType | 'store'>>>(
        () => [
            ...CHIP_ORDER.map((c) => ({
                value: c,
                label: t(`chips.${c}`),
                Icon: CHIP_ICONS[c],
                comingSoon: disabledSet.has(c),
            })),
            // `store` is the only hardcoded coming-soon baseline now
            // (`company` graduated to a live chip in EW-662 Phase 10).
            // Its `comingSoon` is pinned `true` regardless of any flag.
            { value: 'store' as const, label: 'Store', Icon: Store, comingSoon: true },
        ],
        [t, disabledSet],
    );

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-secondary dark:text-text-secondary-dark mt-1">
                    {t('subtitle')}
                </p>
            </div>

            {/* Composer with chips rendered BELOW the card (matches the
                website's landing layout — chips sit outside the input
                container, not inside). */}
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
                onAttachmentsChange={setAttachments}
                chipsBelow={
                    <div className="space-y-2">
                        <PromptChipsRow
                            chips={allChips}
                            value={effectiveChip}
                            onChange={(next) => {
                                // `store` is the last remaining inert "Soon"
                                // chip — the chips row never emits it.
                                // Narrow back to ChipType before persisting.
                                // (`company` graduated to live in EW-662
                                // Phase 10 and is handled like any other
                                // ChipType.)
                                if (next === null || next === 'store') {
                                    return;
                                }
                                setSelectedChip(next);
                            }}
                            ariaLabel={t('chipLabel')}
                            testIdPrefix="new-chip"
                        />
                        <p className="px-1 text-xs text-text-muted dark:text-text-muted-dark">
                            {t(`chipDescriptions.${effectiveChip}`)}
                        </p>
                    </div>
                }
            />

            {/* EW-662 Phase 10 — Register-Company dialog. Opens when the
                user submits the Company chip or lands on
                `/new?type=company`. */}
            <RegisterCompanyDialog open={companyDialogOpen} onOpenChange={setCompanyDialogOpen} />
        </div>
    );
}
