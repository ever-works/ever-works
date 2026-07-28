import { ALL_OPERATIONS } from './generated/registry.all';

/**
 * Per-turn tool gating.
 *
 * The full chat tool set is large (hand-written + ~280 generated + canvas).
 * Sending every schema on every turn is expensive and can exceed provider
 * function-count limits, which degrades tool selection. So we keep the full
 * set available but surface only a bounded, relevant subset each turn:
 *
 *   active = always-on CORE  +  tools whose domain matches the user's message
 *            or the current page  (capped at MAX_ACTIVE_TOOLS)
 *
 * This is intentionally generous and conservative — when in doubt a domain is
 * included. Coverage is never lost permanently: a follow-up message mentioning
 * the domain pulls its tools in.
 */

export const MAX_ACTIVE_TOOLS = 128;

/**
 * Floor on how many matched-domain tools survive the cap.
 *
 * The largest single domain is comfortably under this, so in practice a
 * focused turn ("create a mission") keeps every tool of that domain plus a
 * generous slice of core. Raising `MAX_ACTIVE_TOOLS` alone would NOT have
 * been enough — core grows with every new generated operation, so without a
 * reserved floor the same starvation returns on the next registry wave.
 */
export const MIN_MATCHED_SLOTS = 48;

/** Domains that are always available regardless of the message. */
const CORE_DOMAINS = new Set(['core', 'works']);

/**
 * Go-to-market vocabulary (Wave 10).
 *
 * The prebuilt Agent templates and the first-party Skills catalog are both
 * reached with campaign language ("draft outreach", "audit my SEO", "build a
 * lead list") that shares no stem with `agent` or `skill`. Without these
 * slots the tools for the surface the user just asked for are gated out of
 * the turn — the Mission-create outage is the cautionary tale for shipping a
 * surface without its keyword slots. Applied to both domains because the
 * flows cross them: pick a template (agents) → wire its Skills (skills).
 */
const GTM_KEYWORDS = [
    'campaign',
    'outreach',
    'go-to-market',
    'gtm',
    'lead',
    'prospect',
    'newsletter',
    'digest',
    'competitor',
    'seo',
    'enrichment',
    'follow-up',
];

/** Keywords that pull a domain's tools into the active set. */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
    works: [
        'work',
        'item',
        'website',
        'generate',
        'schedule',
        'category',
        'categories',
        'tag',
        'collection',
        'readme',
        'markdown',
    ],
    agents: ['agent', ...GTM_KEYWORDS],
    tasks: ['task'],
    skills: ['skill', ...GTM_KEYWORDS],
    missions: ['mission'],
    ideas: ['idea', 'proposal'],
    workagent: ['work agent', 'work-agent', 'goal'],
    plugins: ['plugin', 'integration', 'composio', 'connector', 'device'],
    kb: ['knowledge', 'kb', 'document', 'doc', 'upload'],
    notifications: ['notification', 'notify', 'alert', 'channel'],
    email: ['email', 'inbox', 'message', 'mail'],
    // Meetings v1 (Wave 8, feature a) — keyword slots ship WITH the
    // feature (program DoD rule; the Mission-create outage is the
    // cautionary tale for omitting them).
    meetings: ['meeting', 'transcript', 'recording', 'standup', 'zoom', 'google meet'],
    // Event ingest / digest / PR review — same DoD rule as Meetings
    // above: the keyword slots ship WITH the REST operations that made
    // these three tools registrable at all. Without a slot, `deriveDomain`
    // drops them into the `works` catch-all, where the `isExplicit` guard
    // keeps them out of core and only a `works` keyword can reach them.
    events: ['event', 'ingest', 'ingested', 'feed', 'happened', 'came in'],
    digest: ['digest', 'recap', 'catch up', 'catch-up', 'summary of', 'daily', 'weekly'],
    prreview: ['pull request', 'pull-request', 'merge request', 'review', 'diff', 'changed files'],
    // Tool-grant matrix (audit item G4) — keyword slots ship WITH the
    // surface (program DoD rule). Without a slot, `deriveDomain` drops
    // these into the `works` catch-all where the `isExplicit` guard keeps
    // them out of core, so only a `works` keyword could ever reach them.
    // The phrasings are the ones people actually use when a tool went
    // missing ("why can't the agent deploy") rather than the entity name.
    toolgrants: [
        'tool grant',
        'tool-grant',
        'tool access',
        'grant matrix',
        'allowed tool',
        'allowed tools',
        'tool permission',
        'which tools',
        'revoke tool',
        "why can't the agent",
        'why cannot the agent',
    ],
    members: ['member', 'invite', 'invitation', 'team', 'collaborator', 'people'],
    apikeys: ['api key', 'api-key', 'apikey', 'token'],
    budgets: ['budget', 'usage', 'spend', 'spending', 'cost', 'billing'],
    webhooks: ['webhook'],
    orgs: ['organization', 'organisation', 'org', 'company', 'tenant'],
    templates: ['template'],
    deploy: ['deploy', 'deployment', 'domain', 'vercel', 'rollback'],
    git: ['git', 'github', 'repo', 'repository', 'oauth'],
    comparisons: ['comparison', 'compare'],
    activity: ['activity', 'audit', 'log', 'history'],
    files: ['file', 'upload', 'attachment'],
    account: [
        'account',
        'profile',
        'password',
        'security',
        'session',
        'subscription',
        'plan',
        'onboarding',
        'claim',
    ],
    utils: ['screenshot', 'search', 'memory'],
};

/** Map a controller path to a coarse domain key. */
function deriveDomain(path: string): string {
    const p = path.toLowerCase();
    if (p.includes('/api/agents')) return 'agents';
    if (p.includes('/api/tasks') || p.includes('/task-chat-messages')) return 'tasks';
    if (p.includes('/api/skills') || p.includes('/skill-bindings')) return 'skills';
    if (p.includes('/me/missions')) return 'missions';
    if (p.includes('/me/work-proposals')) return 'ideas';
    if (p.includes('/me/work-agent')) return 'workagent';
    if (p.includes('/plugins') || p.includes('/device-auth')) return 'plugins';
    if (p.includes('/kb/')) return 'kb';
    if (p.includes('/notification')) return 'notifications';
    if (p.includes('/api/email')) return 'email';
    if (p.includes('/api/meetings')) return 'meetings';
    if (p.includes('/api/ingest')) return 'events';
    if (p.includes('/api/digest')) return 'digest';
    if (p.includes('/api/pr-review')) return 'prreview';
    if (p.includes('/api/tool-grants')) return 'toolgrants';
    if (p.includes('/members') || p.includes('/invitations')) return 'members';
    if (p.includes('/api-keys')) return 'apikeys';
    if (p.includes('/budgets') || p.includes('/usage')) return 'budgets';
    if (p.includes('/webhooks')) return 'webhooks';
    if (p.includes('/api/organizations')) return 'orgs';
    if (p.includes('/api/templates')) return 'templates';
    if (p.includes('/api/deploy')) return 'deploy';
    if (p.includes('/git-providers') || p.includes('/github-app') || p.includes('/api/oauth'))
        return 'git';
    if (p.includes('/comparisons')) return 'comparisons';
    if (p.includes('/activity-log')) return 'activity';
    if (p.includes('/api/uploads')) return 'files';
    if (
        p.includes('/api/screenshot') ||
        p.includes('/api/search') ||
        p.includes('/api/agent-memory')
    )
        return 'utils';
    if (
        p.includes('/api/auth') ||
        p.includes('/api/account') ||
        p.includes('/api/onboarding') ||
        p.includes('/api/claim') ||
        p.includes('/api/subscriptions') ||
        p.includes('/api/users')
    ) {
        return 'account';
    }
    return 'works';
}

/** Hand-written + canvas tools (camelCase) → domain. */
export const STATIC_TOOL_DOMAINS: Record<string, string> = {
    // navigation + canvas + research → always-on core
    navigate: 'core',
    reloadPage: 'core',
    renderChart: 'core',
    renderTable: 'core',
    renderStatCards: 'core',
    renderDetail: 'core',
    showComponent: 'core',
    runReport: 'core',
    listReports: 'core',
    buildReport: 'core',
    webSearch: 'core',
    getUserInfo: 'core',
    suggestWorks: 'core',
    // works lifecycle (hand-written)
    listWorks: 'works',
    getWorkDetails: 'works',
    getStats: 'works',
    getWorkItemsSummary: 'works',
    getWorkConfig: 'works',
    getGenerationHistory: 'works',
    getScheduleStatus: 'works',
    createWorkManual: 'works',
    createWorkWithAI: 'works',
    importWork: 'works',
    analyzeImportSource: 'works',
    updateWork: 'works',
    deleteWork: 'works',
    syncWork: 'works',
    addItem: 'works',
    removeItem: 'works',
    updateItem: 'works',
    generateItems: 'works',
    checkItemHealth: 'works',
    regenerateMarkdown: 'works',
    listAvailablePipelines: 'works',
    setSchedule: 'works',
    runScheduleNow: 'works',
    cancelSchedule: 'works',
    checkGitConnection: 'git',
    listGitProviders: 'git',
    checkDeployConnection: 'deploy',
    deployWork: 'deploy',
    checkDeploymentStatus: 'deploy',
    listDomains: 'deploy',
    listMissions: 'missions',
    getMissionDetails: 'missions',
    getMissionBudget: 'missions',
    createMission: 'missions',
    updateMission: 'missions',
    pauseMission: 'missions',
    resumeMission: 'missions',
    completeMission: 'missions',
    deleteMission: 'missions',
    runMissionNow: 'missions',
    cloneMission: 'missions',
    // Mission ↔ Work relation tools. Without these three entries they fell
    // through to `deriveDomain`'s `'works'` catch-all and were treated as
    // always-on core rather than mission-domain tools.
    listMissionWorks: 'missions',
    attachWorkToMission: 'missions',
    detachWorkFromMission: 'missions',
    listIdeas: 'ideas',
    getIdeaDetails: 'ideas',
    getIdeaBudget: 'ideas',
    getIdeasRefreshStatus: 'ideas',
    createIdea: 'ideas',
    refreshIdeas: 'ideas',
    buildIdea: 'ideas',
    dismissIdea: 'ideas',
    acceptIdea: 'ideas',
};

let domainMapCache: Map<string, string> | null = null;

function toolDomainMap(): Map<string, string> {
    if (domainMapCache) return domainMapCache;
    const map = new Map<string, string>(Object.entries(STATIC_TOOL_DOMAINS));
    for (const op of ALL_OPERATIONS) {
        if (!map.has(op.toolName)) map.set(op.toolName, deriveDomain(op.path));
    }
    domainMapCache = map;
    return map;
}

/**
 * Pick the active tool names for a turn given the user's latest message and the
 * page they're on. Always includes CORE + works; adds keyword/page-matched
 * domains; caps the total.
 *
 * ## Why the budget is split rather than "core first, then whatever fits"
 *
 * The original implementation was `[...core, ...matched].slice(0, cap)` with
 * `cap = 90`. Two things made that starve the domain the user was actually
 * talking about:
 *
 *  1. `deriveDomain` returns `'works'` as its catch-all, and `'works'` is a
 *     CORE domain — so every generated operation whose path matched none of
 *     the explicit prefixes silently became always-on and ate the budget.
 *  2. `buildChatTools` spreads generated tools FIRST and hand-written tools
 *     LAST, so a bespoke `createX` sits at the very END of its domain. It is
 *     therefore the first thing dropped when the tail is sliced.
 *
 * Combined, `createIdea` was cut from the active set on *every* turn: the
 * model was told (by the system prompt) that the tool existed, emitted a call
 * for it, and the AI SDK raised `NoSuchToolError`. To the user that looked
 * like "I answered the question and nothing happened".
 *
 * The fix is two-part and both halves matter:
 *  - generated tools can no longer enter `core` (they are still reachable —
 *    they match on their domain keywords like any other tool);
 *  - the matched domain gets a guaranteed floor of the budget, so core can
 *    never consume the whole cap.
 */
export function selectActiveToolNames(
    allNames: string[],
    ctx: { text?: string; pageUrl?: string; cap?: number } = {},
): string[] {
    const haystack = `${ctx.text ?? ''} ${ctx.pageUrl ?? ''}`.toLowerCase();
    const cap = ctx.cap ?? MAX_ACTIVE_TOOLS;

    const activeDomains = new Set(CORE_DOMAINS);
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        if (keywords.some((kw) => haystack.includes(kw))) activeDomains.add(domain);
    }

    const domains = toolDomainMap();
    const core: string[] = [];
    // `matched` is split by provenance and re-joined hand-written-first.
    //
    // `buildChatTools` spreads generated tools BEFORE hand-written ones (so
    // hand-written wins name collisions), which puts every bespoke `createX`
    // at the tail of its domain — exactly where the cap bites. Reserving a
    // budget floor for `matched` is not enough on its own: on a turn that
    // activates several domains, the generated operations alone can fill
    // that floor and the create tool is still cut. Ordering by provenance
    // is what actually guarantees it survives.
    const matchedHandWritten: string[] = [];
    const matchedGenerated: string[] = [];
    for (const name of allNames) {
        const domain = domains.get(name) ?? 'works';
        // Only EXPLICITLY-mapped tools may be always-on. Generated operations
        // resolve their domain through `deriveDomain`, whose fallback is the
        // core `'works'` domain — without this guard they become permanently
        // active and crowd out the domain the user is actually working in.
        const isExplicit = Object.prototype.hasOwnProperty.call(STATIC_TOOL_DOMAINS, name);
        if (isExplicit && CORE_DOMAINS.has(domain)) core.push(name);
        else if (!activeDomains.has(domain)) continue;
        else if (isExplicit) matchedHandWritten.push(name);
        else matchedGenerated.push(name);
    }
    const matched = [...matchedHandWritten, ...matchedGenerated];

    // Guarantee the matched domains a floor of the budget before core claims
    // the rest, so a large core can never slice off the bespoke create/update
    // tools that live at the tail of each domain.
    const matchedFloor = Math.min(matched.length, MIN_MATCHED_SLOTS);
    const coreBudget = Math.max(0, cap - matchedFloor);
    return [...core.slice(0, coreBudget), ...matched].slice(0, cap);
}
