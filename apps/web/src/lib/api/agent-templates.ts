/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.6 (scaffold).
 *
 * Per-feature template browser API helpers for the Agents / Skills /
 * Tasks family. Distinct from `templates.ts` (which is the
 * Workshop Templates catalog for kind=website/work/mission).
 *
 * The platform-wide unified template catalog (ADR-010) is on a
 * separate branch and hasn't landed on develop yet. Until then this
 * module returns a hand-curated fallback list per entity type so
 * the new Templates routes (Agents / Skills / Tasks) render with
 * real content. When ADR-010 ships, swap the fallback constants for
 * `serverFetch('/api/agent-templates?entity=…')` — the return type
 * is stable so the three route pages do not change.
 */

export type AstTemplateEntityType = 'agent' | 'skill' | 'task';

export interface AstTemplateEntry {
    /** Stable slug. Becomes the `?from=<slug>` query param on the New flow. */
    slug: string;
    title: string;
    description: string;
    /** Short category label rendered as a chip. */
    category?: string;
    /** Lucide-icon name, resolved at render time. */
    iconName?: string;
    /** Optional preview body (markdown) shown in the side panel. */
    previewMd?: string;
    /** Tags for filtering. */
    tags?: string[];
}

const AGENT_TEMPLATES: AstTemplateEntry[] = [
    // Named-role starters the operator asked to surface as quick-pick
    // chips on /agents (CEO, CTO, Lead Engineer, Copywriter, Sales,
    // Brand Specialist, …). These are the built-in FALLBACK shown until
    // the `ever-works/agents` repo (ADR-011) is the live source — they
    // keep the chip row populated even with a cold/unreachable catalog
    // (spec E2). Additive: the original PM/Coder/Researcher starters
    // stay below.
    {
        slug: 'ceo',
        title: 'CEO',
        description:
            'Chief Executive — keeps every Mission laddering up to a clear goal, sets priorities, and nudges stalled work forward.',
        category: 'Leadership',
        tags: ['strategy', 'roadmap', 'coordination'],
        iconName: 'Crown',
    },
    {
        slug: 'cto',
        title: 'CTO',
        description:
            'Chief Technology Officer — owns technical direction, reviews architecture decisions, and guards delivery quality.',
        category: 'Leadership',
        tags: ['architecture', 'engineering', 'review'],
        iconName: 'Cpu',
    },
    {
        slug: 'lead-engineer',
        title: 'Lead Engineer',
        description:
            'Breaks features into tasks, implements the hard parts end-to-end, and unblocks the rest of the team. Requires git permissions.',
        category: 'Engineering',
        tags: ['git', 'pr', 'implementation'],
        iconName: 'Wrench',
    },
    {
        slug: 'copywriter',
        title: 'Copywriter',
        description:
            'Writes and rewrites marketing + product copy in a consistent brand voice — landing pages, descriptions, release notes.',
        category: 'Content',
        tags: ['content', 'marketing', 'voice'],
        iconName: 'PenLine',
    },
    {
        slug: 'sales',
        title: 'Sales',
        description:
            'Drafts outreach, qualifies inbound interest, and keeps a pipeline of follow-ups moving with timely nudges.',
        category: 'Go-to-market',
        tags: ['outreach', 'pipeline', 'crm'],
        iconName: 'TrendingUp',
    },
    {
        slug: 'brand-specialist',
        title: 'Brand Specialist',
        description:
            'Guards brand consistency across copy, naming, and visuals — flags off-voice content and proposes on-brand alternatives.',
        category: 'Content',
        tags: ['brand', 'voice', 'design'],
        iconName: 'Sparkles',
    },
    {
        slug: 'starter-pm',
        title: 'Project Manager',
        description:
            'Coordinates a Work — assigns Tasks, follows up on blockers, posts daily summaries.',
        category: 'Coordination',
        tags: ['tasks', 'standup', 'coordination'],
        iconName: 'ClipboardList',
    },
    {
        slug: 'starter-coder',
        title: 'Coder',
        description:
            'Implements small features end-to-end — reads the issue, writes a patch, opens a PR. Requires git permissions.',
        category: 'Engineering',
        tags: ['git', 'pr', 'review'],
        iconName: 'Code2',
    },
    {
        slug: 'starter-researcher',
        title: 'Researcher',
        description:
            'Web-search-heavy assistant — gathers sources, summarises, drops findings into a KB doc.',
        category: 'Research',
        tags: ['search', 'kb', 'summary'],
        iconName: 'BookOpen',
    },
];

const SKILL_TEMPLATES: AstTemplateEntry[] = [
    {
        slug: 'cron-defaults',
        title: 'Cron defaults',
        description: 'Conventions for cron expressions used in Work schedules.',
        category: 'Reference',
        tags: ['cron', 'schedule'],
    },
    {
        slug: 'secret-handling',
        title: 'Secret handling',
        description: 'How Agents should treat API keys / credentials in tool outputs.',
        category: 'Security',
        tags: ['secrets', 'security'],
    },
    {
        slug: 'commit-message-style',
        title: 'Commit message style',
        description: 'Conventional-commit format with examples.',
        category: 'Engineering',
        tags: ['git', 'conventions'],
    },
];

const TASK_TEMPLATES: AstTemplateEntry[] = [
    {
        slug: 'bug-triage',
        title: 'Bug triage',
        description:
            'Standard triage Task — reproduce, assign severity, attach repro KB doc, link to PR.',
        category: 'Engineering',
        tags: ['bug', 'triage'],
    },
    {
        slug: 'weekly-review',
        title: 'Weekly review',
        description: 'Recurring weekly Task — review what shipped, what is stuck, what is next.',
        category: 'Coordination',
        tags: ['recurring', 'standup'],
    },
    {
        slug: 'release-checklist',
        title: 'Release checklist',
        description:
            'Multi-sub-task release runbook — version bump, changelog, tag, deploy, smoke-test.',
        category: 'Engineering',
        tags: ['release', 'checklist'],
    },
];

const FALLBACK: Record<AstTemplateEntityType, AstTemplateEntry[]> = {
    agent: AGENT_TEMPLATES,
    skill: SKILL_TEMPLATES,
    task: TASK_TEMPLATES,
};

/**
 * Returns the curated template list for an entity type.
 *
 * Safe to import from both server and client components — no
 * `server-only` modules are pulled in. The ADR-010 unified Workshop
 * Templates catalog swap path lives behind a separate server action
 * (`listAstTemplatesFromCatalogAction` — TBA) so the client bundle
 * can keep importing this file freely.
 *
 * FU-11 — call signature is stable; when the catalog ships, route
 * pages (server components) can opt into the action path while
 * client pre-fill hooks keep using these constants.
 *
 * Post-CI fix (2026-05-26): the earlier env-flag + lazy import
 * approach broke the Next.js webpack build — webpack still traced
 * into `./server-api` even though the import was dynamic, because
 * its target is statically determinable. Keeping this isomorphic
 * pure-data path avoids the bundle pollution; the catalog-swap path
 * moves to a dedicated server action when ADR-010 lands.
 */
/**
 * Session-scoped catalog cache (spec FR-30). Keeps the template chips
 * + `View All` catalog instant across re-renders and route revisits
 * without refetching within the TTL. Keyed by entity type. On the
 * client this persists for the tab session; on the server it's a
 * per-process cache — both are correct because the agent-template
 * catalog is a public, non-request-scoped resource (so this does not
 * violate the "no shared module state for request data" rule). When
 * the ADR-010/ADR-011 server-action swap lands, the fetch+fallback
 * goes here behind the same cache; the return type stays stable.
 */
const CLIENT_CACHE_TTL_MS = 5 * 60_000;
const catalogCache = new Map<AstTemplateEntityType, { at: number; data: AstTemplateEntry[] }>();

export async function listAstTemplates(entity: AstTemplateEntityType): Promise<AstTemplateEntry[]> {
    const cached = catalogCache.get(entity);
    if (cached && Date.now() - cached.at < CLIENT_CACHE_TTL_MS) {
        return cached.data;
    }
    const data = FALLBACK[entity] ?? [];
    catalogCache.set(entity, { at: Date.now(), data });
    return data;
}

/**
 * Lookup-by-slug helper used by the per-template detail panel (and
 * by the future `?from=<slug>` pre-fill on the New flow). Returns
 * null when the slug is unknown.
 *
 * FU-11 review fix (greptile P1): `listAstTemplates` already routes
 * through the ADR-010 catalog when the env flag is on, so a derived
 * lookup via `listAstTemplates(...).find(...)` is already
 * flag-aware. Earlier the implementation here hard-coded `FALLBACK`,
 * which made catalog-only slugs unreachable via `getAstTemplate`.
 * Keeping this thin wrapper means both helpers stay consistent —
 * if the catalog returns a row, `getAstTemplate` returns it; if the
 * fetch falls back, this falls back too.
 */
export async function getAstTemplate(
    entity: AstTemplateEntityType,
    slug: string,
): Promise<AstTemplateEntry | null> {
    const all = await listAstTemplates(entity);
    return all.find((t) => t.slug === slug) ?? null;
}
