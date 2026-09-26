import {
    BookOpen,
    Bot,
    Building2,
    Files,
    FolderOpen,
    GitBranch,
    Globe,
    Lightbulb,
    ListChecks,
    Star,
    Store,
    Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ROUTES } from '@/lib/constants';

/**
 * The "start something" catalog, shared by every surface that offers the prompt
 * + kind chips: `/new` (the dedicated page) and the Dashboard composer.
 *
 * Extracted from `NewPageClient` so the two surfaces cannot drift — a chip that
 * exists on one and not the other, or a placeholder or route that disagrees,
 * would be a bug in the product's most-used entry point. The only per-surface
 * differences are `rows` and whether the chip description line is rendered;
 * both live at the call site.
 */

/**
 * The chip CATALOG itself lives one level up, in `@/lib/work-kinds/chip-values`
 * — a module with no `'use client'` directive — and is re-exported here.
 *
 * It is not declared in this file, and that is load-bearing in two directions:
 *
 *  - the two server components `app/[locale]/(dashboard)/new/page.tsx` and
 *    `…/works/new/page.tsx` import the arrays directly and hand them to
 *    `getDisabledWorkKinds`, whose first act is `values.filter(…)`. A server
 *    component that imports a plain value from a CLIENT module receives a client
 *    reference rather than the array, which threw
 *    `TypeError: a.filter is not a function` during the server render and 500'd
 *    both pages. `chip-values.ts` exists to be the one module both sides may read;
 *  - `lib/work-kinds/chip-values.unit.spec.ts` asserts **identity**, not equality
 *    (`expect(VIA_NEW_INDEX).toBe(ALL_NEW_CHIP_VALUES)`), and asserts that the
 *    array is declared exactly once in the tree. A second literal here would pass
 *    an equality check and then drift silently, which is the failure that spec was
 *    written to catch.
 *
 * Everything BELOW this re-export — icons, placeholders, descriptions, routes —
 * is genuinely per-surface presentation and stays here, shared by `/new` and the
 * Dashboard composer.
 */
export { CHIP_ORDER, ALL_NEW_CHIP_VALUES, type ChipType } from '@/lib/work-kinds/chip-values';
import type { ChipType } from '@/lib/work-kinds/chip-values';

export const CHIP_ICONS: Record<ChipType, LucideIcon> = {
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
    repo: GitBranch,
    // EW-662 Phase 10 — same `Building2` icon the WorkspaceSwitcher
    // empty state uses for consistency.
    company: Building2,
};

/** The `store` chip's icon — inert today, flag-controlled like every other kind. */
export const STORE_CHIP_ICON: LucideIcon = Store;

export const PLACEHOLDERS_BY_CHIP: Record<ChipType, ReadonlyArray<string>> = {
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
    repo: [
        'e.g. "https://github.com/ever-works/ever-works — the platform monorepo"',
        'e.g. "https://github.com/ever-works/directory-web-template — the directory template"',
        'e.g. "https://github.com/my-org/my-service — a service repo agents should work in"',
        'e.g. "https://github.com/my-org/.github — any GitHub repository you can access"',
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

/** The intent prefix handed to the chat AI for each chip. */
export const CHIP_INTENT_LABEL: Record<ChipType, string> = {
    mission: 'Mission',
    idea: 'Idea',
    agent: 'Agent',
    task: 'Task',
    website: 'website',
    'landing-page': 'landing page',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome list repo',
    repo: 'code repository',
    company: 'Company',
};

/** Chips whose submit lands on a dedicated canvas (no prompt prefill). */
export const CHIP_TO_CANVAS_ROUTE: Partial<Record<ChipType, string>> = {
    agent: ROUTES.DASHBOARD_AGENT_NEW,
    task: ROUTES.DASHBOARD_TASK_NEW,
    website: ROUTES.DASHBOARD_WORKS_NEW,
    'landing-page': ROUTES.DASHBOARD_WORKS_NEW,
    blog: ROUTES.DASHBOARD_WORKS_NEW,
    directory: ROUTES.DASHBOARD_WORKS_NEW,
    'awesome-repo': ROUTES.DASHBOARD_WORKS_NEW,
    repo: ROUTES.DASHBOARD_WORKS_NEW,
};

/** Chips that create a Work of a named kind. */
export const CHIP_TO_WORK_KIND: Partial<Record<ChipType, string>> = {
    website: 'website',
    'landing-page': 'landing-page',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome-repo',
    repo: 'repo',
};

/** Minimum trimmed prompt length the shared composer submits. */
export const NEW_PROMPT_MIN_LENGTH = 10;
