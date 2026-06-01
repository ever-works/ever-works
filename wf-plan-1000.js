export const meta = {
    name: 'ever-works-e2e-1000-gap-plan',
    description: 'Gap-analysis: 24 domain agents survey existing e2e coverage and propose ~1000 uncovered complex flows',
    phases: [{ title: 'Gap analysis', detail: 'one agent per feature domain → uncovered complex flow plan' }],
};

const CTX = `
You are planning NEW complex end-to-end e2e flows for the Ever Works platform monorepo at
C:/Coding/Worktrees/wt-e2e-real-integration. There are already ~352 Playwright spec files in
apps/web/e2e/ (including 33 prior flow-*.spec.ts and many feature/contract specs). Your job for
your assigned DOMAIN: find what COMPLEX, multi-step, cross-feature flows are NOT yet covered, and
propose concrete new ones.

METHOD (do this before proposing):
1. Survey EXISTING coverage for your domain: list the e2e specs that touch it, e.g.
   \`ls apps/web/e2e/ | grep -iE '<keywords>'\` and skim a few (grep for endpoints/describe titles)
   so you do NOT propose duplicates of what already exists.
2. Read the REAL controller(s)/component(s) for your domain under apps/api/src and apps/web/src to
   learn the FULL endpoint + UI surface (every route, status, error, state machine, edge case).
3. Propose NEW flows that are genuinely COMPLEX and not yet covered: multi-entity orchestrations,
   full state-machine walks, cross-feature interactions, edge cases, permission/isolation matrices,
   concurrency/conflict, pagination/filter exhaustion, error-recovery, lifecycle round-trips.

OUTPUT: propose ~7 themed spec FILES for your domain, each with ~6 concrete complex flow
descriptions (so ~40-45 flows for your domain). Each flow description must be concrete enough to
implement directly: name the entities, steps, endpoints, and what to assert. Filenames MUST start
with \`flow-\` and be unique + descriptive (kebab-case, e.g. flow-agent-budget-enforcement.spec.ts);
do NOT reuse any existing filename in apps/web/e2e/.

CI REALITY to respect (so proposed flows are buildable green): sqlite in-memory, NO external LLM
key (chat/AI must be environment-adaptive), NO Trigger.dev (agent runs record but don't complete),
MailHog present but SMTP DELIVERY fails ("Missing credentials for PLAIN") so mail-content is
best-effort, REQUIRE_EMAIL_VERIFICATION=false. Prefer deterministic API-orchestrated flows with
targeted UI checks. Favor flows that exercise REAL behaviour over smoke probes.

Return the structured plan. Be ambitious but realistic — every flow should be implementable.
`;

const DOMAINS = [
    { key: 'auth-sessions', desc: 'Auth & sessions: register/login/logout, JWT + refresh tokens, session lifecycle/revocation, device auth, clock-skew/tolerance, cookie flags/rotation, 2FA if present, account lock/failed-attempts, api-keys auth.' },
    { key: 'mail-flows', desc: 'Email-bearing auth: magic-link issue/redeem (throttle, single-use, expiry), password reset round-trip + edges, email verification, email-bounce/deeplink. Mail-content best-effort (SMTP delivery fails in e2e).' },
    { key: 'orgs-tenants', desc: 'Organizations & tenants: create/switch, slug allocation/collision/check-slug, members & roles, scope context, upgrade-from-account, register-company, lazy-tenant stamping, multi-org switching in header.' },
    { key: 'works-core', desc: 'Works core CRUD: create variants, items/categories/tags/collections sub-resources (read contract + git-gated writes), config/count/stats, update, hard-delete, name/slug edge cases, ownership.' },
    { key: 'works-generation', desc: 'Works generation & pipeline: trigger generation, generateStatus lifecycle, cancellation, scheduled updates (cadence/next-run), community-PR enable/auto-close/state, source validation.' },
    { key: 'works-sync', desc: 'Works import/export round-trips, data-sync dispatch + idempotency/retry-backoff, platform-sync secret rotate, activity-sync pull/push modes, webhook secrets.' },
    { key: 'works-collab', desc: 'Works members & invitations & claim: invite/accept/role-scoped access, single-use tokens, member removal, claim/zero-friction/anonymous→claim, work sharing RBAC matrix, cross-user isolation.' },
    { key: 'agents', desc: 'Agents: lifecycle state-machine (draft→active⇄paused→archived), 8 permissions matrix, instruction files (SOUL/AGENTS/HEARTBEAT/TOOLS/agent.yml + hash conflict), budget caps + spend, runs history + pagination, scoping (tenant/mission/idea/work), templates, inbox/messaging.' },
    { key: 'skills', desc: 'Skills: CRUD, scoping/ownerType/ownerId validation, types, bindings to agents (bind/unbind/rebind/priority), skill-context-tokens, cross-user isolation, agent↔skill interplay.' },
    { key: 'tasks', desc: 'Tasks: full status state-machine + illegal/force semantics + side-effect columns, assignees (user/agent) + duplicate-assignee, approvers gate, labels/priority/search/pagination, parent/subtasks hierarchy, collaboration, agent dispatch run-records.' },
    { key: 'missions-ideas', desc: 'Missions & ideas/work-proposals: mission CRUD/type/schedule/autoBuildWorks, guardrails override, clone/full-fork + backlink, outstanding-ideas cap, mission tick, idea build/retry/rebuild/budget, idea→work accept.' },
    { key: 'plugins-ai', desc: 'Plugins ai-provider/ai-gateway: enable/disable (system-plugin rules), settings + required-field validation + secretSettings, models catalogue, provider-override resolution, default-for-capability, env-var binding, per-work provider.' },
    { key: 'plugins-noai', desc: 'Plugins non-AI (search/content-extractor/screenshot/git/deployment/pipeline/data-source): enable/disable lifecycle, settings validation, capability endpoints (configured-vs-unconfigured), work-level enablement + active capability, oauth/device-auth connection contracts.' },
    { key: 'chat-conversations', desc: 'Chat & conversations: UI round-trip (adaptive), conversation CRUD/rename/delete/messages/ordering/auto-title, work-scoped chat, provider/model metadata, history UI, streaming contract, the new "chat does everything" tool-generation/confirmation-gate/no-bulk/canvas (#1200).' },
    { key: 'kb', desc: 'Knowledge base: document lifecycle (upload/edit/version/history/delete), tree, inherited-from-org + Work override filter, citations resolution, search (semantic/RRF), embeddings, media viewers + size cap, wikilinks, locking, mentions.' },
    { key: 'profile-account', desc: 'Profile & account: username/avatar/committer/budget-alerts update + render, fresh-profile, account data export, account deletion flow, account-merge conflict, anonymous→identity, user research opt-out.' },
    { key: 'settings-integrations', desc: 'Settings & integrations: notification channels/emails/notifications prefs, work-agent integration, git-provider connections, github-app webhook/signature, api-keys management UI, security settings, data settings, danger zone.' },
    { key: 'notifications', desc: 'Notifications: in-app create/list/read/unread-count, channel CRUD, preferences gating, email channel (mailhog best-effort), per-event notification production, bell UI + settings UI.' },
    { key: 'activity-audit', desc: 'Activity log & audit: per-work feed ordering + actor/type, export + sanitization, immutability, sequence integrity/monotonic, tamper-resistance, ingest (platform secret), activity-feed-per-work.' },
    { key: 'subscriptions-budgets', desc: 'Subscriptions, budgets & usage: plan/tier shape + transitions, billing grace, usage tracking, admin-usage, budget caps (global/per-work/agent) create/list/enforce/over-budget, currency.' },
    { key: 'oauth-deploy', desc: 'OAuth providers, git-providers, deployment & screenshot capabilities: providers list, oauth authorize/callback/state integrity (mocked upstream), git connection status, deploy/screenshot capability contracts (configured-vs-unconfigured), vercel/github defaults.' },
    { key: 'templates-onboarding', desc: 'Templates & onboarding: website-template catalog/selection/customization/auto-update, onboarding wizard state/steps/catalog/choices/dismiss/completion/telemetry, claim landing, zero-friction.' },
    { key: 'security-isolation', desc: 'Security & multi-tenant isolation: cross-tenant data-leak matrices across ALL resource types, scope-guard GET/PATCH/DELETE forbidden, rate-limiting/throttle, CSRF double-submit, CORS preflight, security headers, XSS/CSV-injection, redirect-prevention, cookie security.' },
    { key: 'i18n-a11y-errors', desc: 'i18n & a11y & error-pages & SEO: locale switching/fallback/RTL, localized error pages, accessibility deep (axe) on key flows, SEO/meta/sitemap, breadcrumbs deep, dark-mode persistence, keyboard navigation, hydration-no-errors.' },
    { key: 'platform-meta', desc: 'Platform meta: health/degraded, api version header + negotiation, feature flags runtime, config endpoint, graphql introspection (if any), public api contract, error-boundary isolation, etag/cache semantics, concurrency/conflict (optimistic) across entities.' },
];

phase('Gap analysis');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['domain', 'files'],
    properties: {
        domain: { type: 'string' },
        existingCoverageNote: { type: 'string', description: 'what already exists for this domain (so proposals avoid duplication)' },
        files: {
            type: 'array',
            description: '~7 themed spec files',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['file', 'title', 'flows'],
                properties: {
                    file: { type: 'string', description: 'unique flow-*.spec.ts filename (must not collide with existing specs)' },
                    title: { type: 'string' },
                    flows: { type: 'array', items: { type: 'string', description: 'one concrete complex flow: entities, steps, endpoints, assertions' } },
                },
            },
        },
    },
};

const results = await parallel(
    DOMAINS.map((d) => () =>
        agent(
            `${CTX}\n\n=== YOUR DOMAIN: ${d.key} ===\n${d.desc}\n\nSurvey existing coverage, read the real source, and propose ~7 themed files × ~6 concrete uncovered complex flows (~40-45 total). Return the structured plan.`,
            { label: d.key, phase: 'Gap analysis', schema: SCHEMA },
        ),
    ),
);

const ok = results.filter(Boolean);
const totalFiles = ok.reduce((n, r) => n + (r.files?.length || 0), 0);
const totalFlows = ok.reduce((n, r) => n + (r.files || []).reduce((m, f) => m + (f.flows?.length || 0), 0), 0);
log(`Gap analysis: ${ok.length}/${DOMAINS.length} domains, ${totalFiles} files, ${totalFlows} flows proposed`);
return ok;
