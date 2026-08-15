// Same posture as tool-grants.controller.spec.ts: the DI types come from
// `@ever-works/agent` barrels whose runtime graphs do not load under this
// app's jest module mapping, and every dependency is injected as a stub.
// `decideToolGrant` is the REAL pure function (required from its leaf
// module, not the barrel) because the composition rule under test IS the
// deny-beats-allow / most-specific-scope attribution it implements; the
// catalog is a fixture so the spec controls the gating metadata.
jest.mock('@ever-works/agent/agents', () => ({
    AgentsService: class {},
    buildAgentToolCatalog: jest.fn(),
    // Mirrors `AGENT_PERMISSIONS_DEFAULT` in `entities/agent.entity.ts`
    // (all-false) — the controller's fallback for a NULL permissions column.
    AGENT_PERMISSIONS_DEFAULT: {
        canCreateAgents: false,
        canAssignTasks: false,
        canEditSkills: false,
        canEditAgentFiles: false,
        canSpend: false,
        canCommitToRepo: false,
        canOpenPullRequests: false,
        canCallExternalTools: false,
    },
}));
jest.mock('@ever-works/agent/policy', () => {
    const { decideToolGrant } = jest.requireActual(
        '../../../../packages/agent/src/policy/tool-grant',
    );
    return { ToolGrantService: class {}, decideToolGrant };
});

import { NotFoundException } from '@nestjs/common';
import type { AgentToolCatalogEntry, ResolvedToolGrants } from '@ever-works/contracts';
import { buildAgentToolCatalog } from '@ever-works/agent/agents';
import { AgentCapabilitiesController } from './agent-capabilities.controller';

const CATALOG: AgentToolCatalogEntry[] = [
    {
        name: 'getSkillBody',
        description: 'Read a bound skill body.',
        gatedByPermission: null,
        source: 'builtin',
    },
    {
        name: 'searchWeb',
        description: 'Web search via the active search plugin.',
        gatedByPermission: 'canCallExternalTools',
        source: 'facade',
    },
    {
        name: 'commitToRepo',
        description: 'Commit to the active Work repo.',
        gatedByPermission: 'canCommitToRepo',
        source: 'facade',
    },
    {
        name: 'createTask',
        description: 'Create a new Task.',
        gatedByPermission: 'canAssignTasks',
        source: 'domain',
    },
];

/** Chain fixture: org denies searchWeb, agent layer denies commitToRepo. */
const RESOLVED: ResolvedToolGrants = {
    matrix: { allow: ['*'], deny: ['searchWeb', 'commitToRepo'] },
    source: 'agent',
    chain: [
        { scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
        { scope: 'organization', id: 'org-1', allow: [], deny: ['searchWeb'], rejected: [] },
        { scope: 'agent', id: 'agent-1', allow: [], deny: ['commitToRepo'], rejected: [] },
    ],
};

const AGENT = {
    id: 'agent-1',
    initScript: '#!/bin/sh\npnpm install\n',
    permissions: {
        canCreateAgents: false,
        canAssignTasks: true,
        canEditSkills: false,
        canEditAgentFiles: false,
        canSpend: false,
        canCommitToRepo: true,
        canOpenPullRequests: false,
        canCallExternalTools: false,
    },
};

describe('AgentCapabilitiesController', () => {
    const auth = { userId: 'user-1' } as never;

    beforeEach(() => {
        (buildAgentToolCatalog as jest.Mock).mockReturnValue(CATALOG.map((e) => ({ ...e })));
    });

    function make(overrides?: { getOne?: jest.Mock; resolve?: jest.Mock; list?: jest.Mock }) {
        const getOne = overrides?.getOne ?? jest.fn().mockResolvedValue({ ...AGENT });
        const resolve = overrides?.resolve ?? jest.fn().mockResolvedValue(RESOLVED);
        const list = overrides?.list ?? jest.fn().mockResolvedValue([]);
        const controller = new AgentCapabilitiesController(
            { getOne } as never,
            { resolve, list } as never,
        );
        return { controller, getOne, resolve, list };
    }

    it('propagates the owner-scoped 404 before resolving anything', async () => {
        const getOne = jest.fn().mockRejectedValue(new NotFoundException('nope'));
        const { controller, resolve, list } = make({ getOne });
        await expect(controller.getCapabilities('agent-9', auth)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(resolve).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
    });

    it('resolves the grant chain for exactly this user + agent', async () => {
        const { controller, resolve } = make();
        await controller.getCapabilities('agent-1', auth);
        expect(resolve).toHaveBeenCalledWith({ userId: 'user-1', agentId: 'agent-1' });
    });

    it('marks a tool denied by a PARENT layer with that layer as the deciding source', async () => {
        const { controller } = make();
        const payload = await controller.getCapabilities('agent-1', auth);
        const searchWeb = payload.tools.find((t) => t.name === 'searchWeb')!;
        expect(searchWeb.decision.allowed).toBe(false);
        expect(searchWeb.decision.code).toBe('tool-denied');
        expect(searchWeb.decision.source).toBe('organization');
        expect(searchWeb.effective).toBe(false);
    });

    it('attributes an agent-layer deny to the agent scope', async () => {
        const { controller } = make();
        const payload = await controller.getCapabilities('agent-1', auth);
        const commit = payload.tools.find((t) => t.name === 'commitToRepo')!;
        expect(commit.decision.allowed).toBe(false);
        expect(commit.decision.source).toBe('agent');
        // Permission flag is ON — the grant row alone turns it off.
        expect(commit.permissionEnabled).toBe(true);
        expect(commit.effective).toBe(false);
    });

    it('computes effective = permissionEnabled AND grant-allowed', async () => {
        const { controller } = make();
        const payload = await controller.getCapabilities('agent-1', auth);

        // Granted by matrix but the permission flag is off.
        const searchWeb = payload.tools.find((t) => t.name === 'searchWeb')!;
        expect(searchWeb.permissionEnabled).toBe(false);

        // Granted + permitted.
        const createTask = payload.tools.find((t) => t.name === 'createTask')!;
        expect(createTask.permissionEnabled).toBe(true);
        expect(createTask.decision.allowed).toBe(true);
        expect(createTask.effective).toBe(true);

        // Ungated tool: permissionEnabled defaults to true.
        const skillBody = payload.tools.find((t) => t.name === 'getSkillBody')!;
        expect(skillBody.permissionEnabled).toBe(true);
        expect(skillBody.effective).toBe(true);
    });

    it('a clean chain (platform default only) leaves every permitted tool effective', async () => {
        const resolve = jest.fn().mockResolvedValue({
            matrix: { allow: ['*'], deny: [] },
            source: 'default',
            chain: [{ scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] }],
        } satisfies ResolvedToolGrants);
        const { controller } = make({ resolve });
        const payload = await controller.getCapabilities('agent-1', auth);
        for (const tool of payload.tools) {
            expect(tool.decision.allowed).toBe(true);
            expect(tool.effective).toBe(tool.permissionEnabled);
        }
    });

    it('surfaces the stored agent-scope grant row (and ONLY that row)', async () => {
        const list = jest.fn().mockResolvedValue([
            { id: 'row-w', scopeType: 'work', scopeId: 'work-1', allow: null, deny: ['x'] },
            {
                id: 'row-a',
                scopeType: 'agent',
                scopeId: 'agent-1',
                allow: null,
                deny: ['commitToRepo'],
                note: 'no direct commits',
            },
            { id: 'row-other', scopeType: 'agent', scopeId: 'agent-2', allow: null, deny: [] },
        ]);
        const { controller } = make({ list });
        const payload = await controller.getCapabilities('agent-1', auth);
        expect(payload.agentGrantRow).toEqual({
            id: 'row-a',
            allow: null,
            deny: ['commitToRepo'],
            note: 'no direct commits',
        });
    });

    it('returns a null agentGrantRow when the Agent inherits', async () => {
        const { controller } = make();
        const payload = await controller.getCapabilities('agent-1', auth);
        expect(payload.agentGrantRow).toBeNull();
    });

    it('falls back to the platform defaults when the permissions column is NULL', async () => {
        // `agents.permissions` is nullable; indexing it raised a TypeError and
        // the payload contract declares a non-null Record. All-false matches
        // how `resolveAllowedTools` reads the flags (`agent.permissions?.x`).
        const getOne = jest.fn().mockResolvedValue({ ...AGENT, permissions: null });
        const { controller } = make({ getOne });
        const payload = await controller.getCapabilities('agent-1', auth);

        expect(payload.permissions).toEqual({
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        });
        // Every permission-gated tool reads as not permitted…
        expect(payload.tools.find((t) => t.name === 'createTask')!.permissionEnabled).toBe(false);
        expect(payload.tools.find((t) => t.name === 'commitToRepo')!.permissionEnabled).toBe(false);
        // …while an ungated one is unaffected.
        expect(payload.tools.find((t) => t.name === 'getSkillBody')!.permissionEnabled).toBe(true);
    });

    it('passes through initScript, permissions and the full grants chain', async () => {
        const { controller } = make();
        const payload = await controller.getCapabilities('agent-1', auth);
        expect(payload.agentId).toBe('agent-1');
        expect(payload.initScript).toBe(AGENT.initScript);
        expect(payload.permissions).toEqual(AGENT.permissions);
        expect(payload.grants).toEqual(RESOLVED);
    });
});
