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
 * Returns the curated template list for an entity type. Pure
 * client-side until ADR-010 lands; safe to call from server
 * components (no fetch, no environment lookup).
 *
 * Stable shape — when ADR-010 lands swap the body for
 * `serverFetch('/api/agent-templates?entity=' + entity)` and
 * callers stay unchanged.
 */
export async function listAstTemplates(
    entity: AstTemplateEntityType,
): Promise<AstTemplateEntry[]> {
    // TODO(ADR-010): replace with `serverFetch('/api/agent-templates?entity=' + entity)`.
    return FALLBACK[entity] ?? [];
}

/**
 * Lookup-by-slug helper used by the per-template detail panel (and
 * by the future `?from=<slug>` pre-fill on the New flow). Returns
 * null when the slug is unknown.
 */
export async function getAstTemplate(
    entity: AstTemplateEntityType,
    slug: string,
): Promise<AstTemplateEntry | null> {
    const all = await listAstTemplates(entity);
    return all.find((t) => t.slug === slug) ?? null;
}
