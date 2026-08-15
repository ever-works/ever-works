import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    type Agent,
    type AgentPermissions,
} from '../entities/agent.entity';
import type { AgentToolCatalogEntry } from '@ever-works/contracts';
import { AgentToolService } from './agent-tool.service';
import type { AgentDomainToolSources } from './agent-domain-tool-sources';

/**
 * Agent tool catalog (Capabilities tab) — the static "what tools exist"
 * answer, DERIVED from the very same assembly `resolveAllowedTools`
 * runs, never hand-maintained.
 *
 * ## How it stays drift-proof
 *
 * Instead of a hand-written list (which WOULD drift the first time a
 * domain gains a tool), the catalog instantiates `AgentToolService` with
 * inert stub dependencies and calls `resolveAllowedTools` — descriptor
 * assembly is synchronous and touches its backing services only inside
 * the `invoke` closures, which the catalog never calls. Names and
 * descriptions therefore come from the one authoritative assembly point.
 *
 * The two metadata columns the UI needs beyond name/description are
 * COMPUTED the same way, not declared:
 *
 *  - `gatedByPermission` — resolve once fully-permissioned, then once
 *    per flag with only that flag off; a tool that disappears is gated
 *    by that flag.
 *  - `source` — resolve once without the facade tokens (git / plugin /
 *    email / notify-channel) and once without the domain tool sources; a
 *    tool that disappears is 'facade' / 'domain' respectively, the rest
 *    are 'builtin'.
 *
 * The result is memoized: it depends only on code, so one process
 * computes it once.
 *
 * ## What the stubs must satisfy
 *
 * Only what descriptor BUILD time touches: presence (truthiness) of the
 * facade tokens, `typeof emailFacade.messageAgent === 'function'`, and
 * the per-domain source bundles. If a factory ever starts dereferencing
 * its service at build time, `buildDomainTools` swallows the throw and
 * the domain's tools silently vanish from the catalog — which is exactly
 * what `agent-tool-catalog.spec.ts` pins representative names against.
 */

const PERMISSION_FLAGS: ReadonlyArray<keyof AgentPermissions> = [
    'canCreateAgents',
    'canAssignTasks',
    'canEditSkills',
    'canEditAgentFiles',
    'canSpend',
    'canCommitToRepo',
    'canOpenPullRequests',
    'canCallExternalTools',
];

function fullPermissions(): AgentPermissions {
    return {
        canCreateAgents: true,
        canAssignTasks: true,
        canEditSkills: true,
        canEditAgentFiles: true,
        canSpend: true,
        canCommitToRepo: true,
        canOpenPullRequests: true,
        canCallExternalTools: true,
    };
}

/**
 * Synthetic Agent for catalog resolution. Tenant scope on purpose —
 * scope only changes invoke-time behaviour (e.g. commitToRepo rejects a
 * non-Work scope when CALLED), never which descriptors are assembled.
 */
function syntheticAgent(permissions: AgentPermissions): Agent {
    return {
        id: 'catalog',
        userId: 'catalog',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        scopeTargetId: '',
        name: 'Catalog',
        slug: 'catalog',
        title: null,
        capabilities: null,
        reportsToAgentId: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        memoryRecallEnabled: true,
        status: AgentStatus.ACTIVE,
        permissions,
        targets: null,
        guardrails: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        soulMd: null,
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        committerName: null,
        committerEmail: null,
        scorecard: null,
        mergePolicy: null,
        initScript: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        syncScopeTargetId() {
            /* no-op — never persisted */
        },
    } as Agent;
}

/** Inert stand-ins — only ever captured by invoke closures, never called. */
function stubDomainSources(): AgentDomainToolSources {
    const stub = <T>(): T => ({}) as T;
    return {
        tasks: {
            tasksService: stub(),
            chatService: stub(),
            assignees: stub(),
            reviewers: stub(),
            approvers: stub(),
        },
        ingest: { repository: stub() },
        digest: { digestService: stub() },
        meetings: { repository: stub() },
        fleet: { service: stub() },
        prReview: { prReviewService: stub() },
        mergePolicy: { service: stub(), authorize: async () => null },
        browser: { facade: stub() },
        escalations: { service: stub() },
        toolGrants: { service: stub(), authorize: async () => null },
        workflow: { executor: stub() },
    };
}

function makeCatalogService(options: { facades: boolean; domains: boolean }): AgentToolService {
    const stub = <T>(): T => ({}) as T;
    return new AgentToolService(
        // AgentRepository — messageAgent's owner check runs at invoke time.
        stub(),
        // AgentsService — createSubAgent routes through it at invoke time.
        stub(),
        // SkillRepository + SkillBindingRepository — presence exposes getSkillBody.
        stub(),
        stub(),
        // AgentFileService — presence (with the permission) exposes editAgentFile.
        stub(),
        options.facades ? stub() : undefined, // AGENT_GIT_FACADE
        options.facades ? stub() : undefined, // AGENT_PLUGIN_TOOLS_FACADE
        // AGENT_EMAIL_FACADE — messageAgent additionally requires the
        // optional method slot to be a function at build time.
        options.facades ? ({ messageAgent: async () => stub() } as never) : undefined,
        options.facades ? stub() : undefined, // AGENT_NOTIFY_CHANNEL_FACADE
        options.domains ? stubDomainSources() : undefined,
        // No tool-grant enforcer / credential resolver: the catalog is the
        // ungated "what exists" answer — grants are applied by the caller.
        undefined,
        undefined,
    );
}

function resolveNames(service: AgentToolService, permissions: AgentPermissions): Set<string> {
    return new Set(service.resolveAllowedTools(syntheticAgent(permissions)).map((t) => t.name));
}

let cachedCatalog: AgentToolCatalogEntry[] | null = null;

/**
 * Build (or return the memoized) agent tool catalog:
 * `[{ name, description, gatedByPermission, source }]`, in the exact
 * order `resolveAllowedTools` assembles the descriptors.
 */
export function buildAgentToolCatalog(): AgentToolCatalogEntry[] {
    if (!cachedCatalog) {
        cachedCatalog = computeCatalog();
    }
    // Fresh copies — callers must not be able to mutate the cache.
    return cachedCatalog.map((entry) => ({ ...entry }));
}

/** Test seam — forces the next `buildAgentToolCatalog()` to recompute. */
export function resetAgentToolCatalogCache(): void {
    cachedCatalog = null;
}

function computeCatalog(): AgentToolCatalogEntry[] {
    const full = makeCatalogService({ facades: true, domains: true });
    const descriptors = full.resolveAllowedTools(syntheticAgent(fullPermissions()));

    // gatedByPermission: the FIRST flag whose removal drops the tool.
    // (No current tool is gated on two flags at descriptor-assembly time;
    // invoke-time implications like canOpenPullRequests ⇒ canCommitToRepo
    // are service-level refinements, not assembly gates.)
    const gatedBy = new Map<string, keyof AgentPermissions>();
    for (const flag of PERMISSION_FLAGS) {
        const without = resolveNames(full, { ...fullPermissions(), [flag]: false });
        for (const descriptor of descriptors) {
            if (!without.has(descriptor.name) && !gatedBy.has(descriptor.name)) {
                gatedBy.set(descriptor.name, flag);
            }
        }
    }

    const withoutFacades = resolveNames(
        makeCatalogService({ facades: false, domains: true }),
        fullPermissions(),
    );
    const withoutDomains = resolveNames(
        makeCatalogService({ facades: true, domains: false }),
        fullPermissions(),
    );

    return descriptors.map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        gatedByPermission: gatedBy.get(descriptor.name) ?? null,
        source: !withoutDomains.has(descriptor.name)
            ? ('domain' as const)
            : !withoutFacades.has(descriptor.name)
              ? ('facade' as const)
              : ('builtin' as const),
    }));
}
