import { describe, expect, it } from 'vitest';
import type { OrgChartPayload } from '@/lib/api/teams';
import { buildOrgTree, type OrgTreeNode } from './build-org-tree';

/**
 * Teams & Prebuilt Companies (spec §5) — unit coverage for the pure
 * org-chart tree builder: team nesting, teamless reports-to chains,
 * cycle safety (must not hang), member placement, unknown parents.
 */

function makePayload(overrides: Partial<OrgChartPayload> = {}): OrgChartPayload {
    return {
        organization: { id: 'org-1', slug: 'acme', displayName: 'Acme Inc' },
        teams: [],
        agents: [],
        members: [],
        ...overrides,
    };
}

function team(
    id: string,
    name: string,
    extra: Partial<OrgChartPayload['teams'][number]> = {},
): OrgChartPayload['teams'][number] {
    return {
        id,
        slug: id,
        name,
        avatarIcon: null,
        parentTeamId: null,
        managerAgentId: null,
        ...extra,
    };
}

function agent(
    id: string,
    name: string,
    extra: Partial<OrgChartPayload['agents'][number]> = {},
): OrgChartPayload['agents'][number] {
    return {
        id,
        name,
        title: null,
        status: 'active',
        avatarIcon: null,
        reportsToAgentId: null,
        teamIds: [],
        ...extra,
    };
}

function member(
    userId: string,
    name: string | null,
    teamIds: string[] = [],
): OrgChartPayload['members'][number] {
    return { userId, name, avatarUrl: null, teamIds };
}

function labels(nodes: OrgTreeNode[]): string[] {
    return nodes.map((n) => n.label);
}

function findNode(root: OrgTreeNode, id: string): OrgTreeNode | null {
    if (root.id === id) return root;
    for (const child of root.children) {
        const hit = findNode(child, id);
        if (hit) return hit;
    }
    return null;
}

function countNodes(root: OrgTreeNode): number {
    return 1 + root.children.reduce((sum, c) => sum + countNodes(c), 0);
}

describe('buildOrgTree', () => {
    it('roots the tree at the organization', () => {
        const root = buildOrgTree(makePayload());
        expect(root.kind).toBe('organization');
        expect(root.id).toBe('org-1');
        expect(root.label).toBe('Acme Inc');
        expect(root.children).toEqual([]);
    });

    it('nests teams by parentTeamId', () => {
        const root = buildOrgTree(
            makePayload({
                teams: [
                    team('t-eng', 'Engineering'),
                    team('t-qa', 'QA', { parentTeamId: 't-eng' }),
                ],
            }),
        );
        expect(root.children).toHaveLength(1);
        const eng = root.children[0];
        expect(eng.kind).toBe('team');
        expect(eng.id).toBe('t-eng');
        expect(eng.children.map((c) => c.id)).toEqual(['t-qa']);
    });

    it('treats a team with an unknown parentTeamId as top-level', () => {
        const root = buildOrgTree(
            makePayload({
                teams: [
                    team('t-eng', 'Engineering'),
                    team('t-lost', 'Lost', { parentTeamId: 'no-such-team' }),
                ],
            }),
        );
        expect(root.children.map((c) => c.id).sort()).toEqual(['t-eng', 't-lost']);
    });

    it('orders team agents so managers come before their reports, then members last', () => {
        // "Alice" reports to "Zed" — alphabetical alone would put Alice first;
        // the reports-to topological rule must put Zed (the manager) first.
        const root = buildOrgTree(
            makePayload({
                teams: [team('t-eng', 'Engineering')],
                agents: [
                    agent('a-alice', 'Alice', { teamIds: ['t-eng'], reportsToAgentId: 'a-zed' }),
                    agent('a-zed', 'Zed', { teamIds: ['t-eng'] }),
                ],
                members: [member('u-1', 'Ruslan', ['t-eng'])],
            }),
        );
        const eng = findNode(root, 't-eng')!;
        expect(labels(eng.children)).toEqual(['Zed', 'Alice', 'Ruslan']);
        expect(eng.children.map((c) => c.kind)).toEqual(['agent', 'agent', 'member']);
    });

    it('does not hang on a reports-to cycle inside a team and keeps every agent', () => {
        const root = buildOrgTree(
            makePayload({
                teams: [team('t-eng', 'Engineering')],
                agents: [
                    agent('a-1', 'Ping', { teamIds: ['t-eng'], reportsToAgentId: 'a-2' }),
                    agent('a-2', 'Pong', { teamIds: ['t-eng'], reportsToAgentId: 'a-1' }),
                    agent('a-3', 'Solo', { teamIds: ['t-eng'] }),
                ],
            }),
        );
        const eng = findNode(root, 't-eng')!;
        // All three agents survive; the non-cyclic one is emitted first,
        // then the cycle is broken alphabetically.
        expect(labels(eng.children)).toEqual(['Solo', 'Ping', 'Pong']);
    });

    it('nests teamless agents under their teamless manager (reports-to chain)', () => {
        const root = buildOrgTree(
            makePayload({
                agents: [
                    agent('a-ceo', 'CEO'),
                    agent('a-cto', 'CTO', { reportsToAgentId: 'a-ceo' }),
                    agent('a-coder', 'Coder', { reportsToAgentId: 'a-cto' }),
                ],
            }),
        );
        expect(root.children.map((c) => c.id)).toEqual(['a-ceo']);
        const ceo = root.children[0];
        expect(ceo.children.map((c) => c.id)).toEqual(['a-cto']);
        expect(ceo.children[0].children.map((c) => c.id)).toEqual(['a-coder']);
    });

    it('does not hang on a teamless reports-to cycle and keeps every agent', () => {
        const root = buildOrgTree(
            makePayload({
                agents: [
                    agent('a-1', 'Alpha', { reportsToAgentId: 'a-2' }),
                    agent('a-2', 'Beta', { reportsToAgentId: 'a-1' }),
                ],
            }),
        );
        // Cycle broken: exactly the org + both agents, each appearing once.
        expect(countNodes(root)).toBe(3);
        expect(findNode(root, 'a-1')).not.toBeNull();
        expect(findNode(root, 'a-2')).not.toBeNull();
    });

    it('handles a self-reporting agent without hanging', () => {
        const root = buildOrgTree(
            makePayload({ agents: [agent('a-1', 'Loop', { reportsToAgentId: 'a-1' })] }),
        );
        expect(root.children.map((c) => c.id)).toEqual(['a-1']);
        expect(root.children[0].children).toEqual([]);
    });

    it('places members: in-team members after agents, teamless members last under root', () => {
        const root = buildOrgTree(
            makePayload({
                teams: [team('t-eng', 'Engineering')],
                agents: [agent('a-1', 'Bot', { teamIds: ['t-eng'] }), agent('a-2', 'Free agent')],
                members: [member('u-in', 'Insider', ['t-eng']), member('u-out', 'Outsider')],
            }),
        );
        // Root rank order: teams, then teamless agents, then teamless members.
        expect(root.children.map((c) => c.kind)).toEqual(['team', 'agent', 'member']);
        expect(root.children[2].id).toBe('u-out');
        const eng = findNode(root, 't-eng')!;
        expect(eng.children.map((c) => c.kind)).toEqual(['agent', 'member']);
        expect(eng.children[1].id).toBe('u-in');
    });

    it('treats members/agents whose only teamIds are unknown as teamless', () => {
        const root = buildOrgTree(
            makePayload({
                agents: [agent('a-1', 'Ghost', { teamIds: ['no-such-team'] })],
                members: [member('u-1', 'Wanderer', ['no-such-team'])],
            }),
        );
        expect(root.children.map((c) => c.id)).toEqual(['a-1', 'u-1']);
    });

    it('falls back to the userId label when a member has no name', () => {
        const root = buildOrgTree(makePayload({ members: [member('u-1', null)] }));
        expect(root.children[0].label).toBe('u-1');
    });

    it('orders alphabetically within each rank (deterministic)', () => {
        const root = buildOrgTree(
            makePayload({
                teams: [team('t-b', 'Bravo'), team('t-a', 'Alpha')],
                agents: [agent('a-z', 'Zeta'), agent('a-m', 'Mu')],
                members: [member('u-y', 'Yana'), member('u-c', 'Cara')],
            }),
        );
        expect(labels(root.children)).toEqual(['Alpha', 'Bravo', 'Mu', 'Zeta', 'Cara', 'Yana']);
    });
});
