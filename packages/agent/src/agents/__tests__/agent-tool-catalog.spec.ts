import { buildAgentToolCatalog, resetAgentToolCatalogCache } from '../agent-tool-catalog';
import { AgentToolService } from '../agent-tool.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    type Agent,
    type AgentPermissions,
} from '../../entities/agent.entity';

/**
 * Capabilities tab — catalog drift guard.
 *
 * The catalog is DERIVED from `resolveAllowedTools`, so trivial equality
 * is not the interesting assertion. What this spec pins:
 *
 *  1. the catalog exactly matches the descriptor names an independently
 *     stubbed, fully-permissioned `AgentToolService` yields (so the
 *     catalog's internal stub harness cannot silently diverge from a
 *     real assembly — e.g. a factory that starts dereferencing its
 *     service at build time would vanish from the catalog but not from
 *     this spec's own assembly, and the set comparison fails);
 *  2. representative names from every assembly branch are present, so a
 *     whole domain silently dropping (buildDomainTools swallows factory
 *     throws) is caught by name, not just by count;
 *  3. the computed permission gates + sources match the gates the
 *     assembly actually applies.
 */

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

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'Drift Guard',
        slug: 'drift-guard',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: fullPermissions(),
        targets: null,
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
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

/** Independent full-surface assembly — deliberately NOT the catalog's own harness. */
function makeFullService(): AgentToolService {
    const stub = <T>(): T => ({}) as T;
    return new AgentToolService(
        { findByIdAndUser: jest.fn() } as never,
        { create: jest.fn() } as never,
        stub(),
        stub(),
        stub(),
        stub(), // git facade
        stub(), // plugin tools facade
        { messageAgent: jest.fn() } as never, // email facade (messageAgent slot present)
        stub(), // notify-channel facade
        {
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
        } as never,
        undefined,
        undefined,
    );
}

describe('buildAgentToolCatalog', () => {
    beforeEach(() => resetAgentToolCatalogCache());

    it('exactly matches the descriptor names resolveAllowedTools yields for a fully-permissioned agent', () => {
        const catalogNames = buildAgentToolCatalog()
            .map((entry) => entry.name)
            .sort();
        const assembledNames = makeFullService()
            .resolveAllowedTools(makeAgent())
            .map((tool) => tool.name)
            .sort();
        expect(catalogNames).toEqual(assembledNames);
    });

    it('has unique names and a non-empty description on every entry', () => {
        const catalog = buildAgentToolCatalog();
        const names = catalog.map((entry) => entry.name);
        expect(new Set(names).size).toBe(names.length);
        for (const entry of catalog) {
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    it('contains representative tools from every assembly branch (guards a silently-dropped domain)', () => {
        const names = new Set(buildAgentToolCatalog().map((entry) => entry.name));
        // Built-ins.
        expect(names).toContain('getSkillBody');
        expect(names).toContain('editAgentFile');
        expect(names).toContain('createSubAgent');
        expect(names).toContain('getActivity');
        expect(names).toContain('getKbDocument');
        // Facade pass-throughs.
        expect(names).toContain('commitToRepo');
        expect(names).toContain('openPullRequest');
        expect(names).toContain('searchWeb');
        expect(names).toContain('screenshot');
        expect(names).toContain('extractContent');
        expect(names).toContain('sendEmail');
        expect(names).toContain('messageAgent');
        expect(names).toContain('notifyChannel');
        // Domain chat tools (one representative per factory).
        expect(names).toContain('createTask');
        expect(names).toContain('resolve_merge_policy');
        expect(names).toContain('resolve_tool_grants');
    });

    it('computes the permission gate the assembly actually applies', () => {
        const byName = new Map(buildAgentToolCatalog().map((entry) => [entry.name, entry]));
        expect(byName.get('editAgentFile')?.gatedByPermission).toBe('canEditAgentFiles');
        expect(byName.get('createSubAgent')?.gatedByPermission).toBe('canCreateAgents');
        expect(byName.get('commitToRepo')?.gatedByPermission).toBe('canCommitToRepo');
        expect(byName.get('openPullRequest')?.gatedByPermission).toBe('canOpenPullRequests');
        expect(byName.get('searchWeb')?.gatedByPermission).toBe('canCallExternalTools');
        expect(byName.get('sendEmail')?.gatedByPermission).toBe('canCallExternalTools');
        // Ungated tools carry null, not a guessed flag.
        expect(byName.get('getSkillBody')?.gatedByPermission).toBeNull();
        expect(byName.get('getActivity')?.gatedByPermission).toBeNull();
    });

    it('classifies sources as builtin / facade / domain', () => {
        const byName = new Map(buildAgentToolCatalog().map((entry) => [entry.name, entry]));
        expect(byName.get('getSkillBody')?.source).toBe('builtin');
        expect(byName.get('editAgentFile')?.source).toBe('builtin');
        expect(byName.get('commitToRepo')?.source).toBe('facade');
        expect(byName.get('searchWeb')?.source).toBe('facade');
        expect(byName.get('createTask')?.source).toBe('domain');
        expect(byName.get('resolve_tool_grants')?.source).toBe('domain');
    });

    it('every permission-gated tool disappears from resolveAllowedTools when its flag is off (cross-check)', () => {
        const service = makeFullService();
        const catalog = buildAgentToolCatalog();
        const gated = catalog.filter((entry) => entry.gatedByPermission);
        expect(gated.length).toBeGreaterThan(0);
        for (const entry of gated) {
            const names = new Set(
                service
                    .resolveAllowedTools(
                        makeAgent({
                            permissions: {
                                ...fullPermissions(),
                                [entry.gatedByPermission as keyof AgentPermissions]: false,
                            },
                        }),
                    )
                    .map((tool) => tool.name),
            );
            expect(names.has(entry.name)).toBe(false);
        }
    });

    it('memoizes but returns defensive copies', () => {
        const first = buildAgentToolCatalog();
        first[0].name = 'mutated';
        const second = buildAgentToolCatalog();
        expect(second[0].name).not.toBe('mutated');
    });
});
