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

export const MAX_ACTIVE_TOOLS = 90;

/** Domains that are always available regardless of the message. */
const CORE_DOMAINS = new Set(['core', 'works']);

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
    agents: ['agent'],
    tasks: ['task'],
    skills: ['skill'],
    missions: ['mission'],
    ideas: ['idea', 'proposal'],
    workagent: ['work agent', 'work-agent', 'goal'],
    plugins: ['plugin', 'integration', 'composio', 'connector', 'device'],
    kb: ['knowledge', 'kb', 'document', 'doc', 'upload'],
    notifications: ['notification', 'notify', 'alert', 'channel'],
    email: ['email', 'inbox', 'message', 'mail'],
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
const STATIC_TOOL_DOMAINS: Record<string, string> = {
    // navigation + canvas + research → always-on core
    navigate: 'core',
    reloadPage: 'core',
    renderChart: 'core',
    renderTable: 'core',
    renderStatCards: 'core',
    renderDetail: 'core',
    runReport: 'core',
    listReports: 'core',
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
 * domains; caps the total (core kept first).
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
    const matched: string[] = [];
    for (const name of allNames) {
        const domain = domains.get(name) ?? 'works';
        if (CORE_DOMAINS.has(domain)) core.push(name);
        else if (activeDomains.has(domain)) matched.push(name);
    }

    // Core first (never trimmed), then matched up to the cap.
    const selected = [...core, ...matched].slice(0, cap);
    return selected;
}
