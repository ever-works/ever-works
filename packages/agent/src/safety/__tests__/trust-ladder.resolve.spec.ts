import {
    ACTION_CATEGORY_CEILING,
    ACTION_CATEGORY_DEFAULT,
    LADDERED_CATEGORIES,
    SHIPPED_DEFAULT_RUNG_POLICY,
} from '@ever-works/contracts';
import { ladderEntry, resolveLadder, type AutonomyGrantRow } from '../trust-ladder';

const WORKSPACE = 'org-1';
const AGENT = 'agent-1';

function row(partial: Partial<AutonomyGrantRow>): AutonomyGrantRow {
    return {
        id: 'row-1',
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        category: 'message.external',
        rung: 'ask',
        ...partial,
    } as AutonomyGrantRow;
}

describe('resolveLadder', () => {
    it('returns every laddered category, in ladder order', () => {
        const ladder = resolveLadder([], { workspaceScopeId: WORKSPACE });
        expect(ladder.entries.map((entry) => entry.category)).toEqual([...LADDERED_CATEGORIES]);
    });

    it('starts a workspace with no rows on the shipped defaults', () => {
        const ladder = resolveLadder([], { workspaceScopeId: WORKSPACE });
        for (const entry of ladder.entries) {
            expect(entry.rung).toBe(ACTION_CATEGORY_DEFAULT[entry.category]);
            expect(entry.decidedBy).toBe('default');
            expect(entry.grantId).toBeNull();
        }
    });

    it('does not ENFORCE an untouched default while the policy says display', () => {
        // Holding an action nobody asked to hold, in a phase where no approval
        // can release it, would stop work that runs today.
        const ladder = resolveLadder([], { workspaceScopeId: WORKSPACE });
        const expected = SHIPPED_DEFAULT_RUNG_POLICY === 'enforce';
        for (const entry of ladder.entries) expect(entry.enforced).toBe(expected);
    });

    it('enforces an EXPLICIT rung under either policy', () => {
        const ladder = resolveLadder([row({ rung: 'off' })], { workspaceScopeId: WORKSPACE });
        expect(ladderEntry(ladder, 'message.external')?.enforced).toBe(true);
    });

    it('lets a Workspace row decide, and says so', () => {
        const ladder = resolveLadder([row({ id: 'w1', rung: 'off' })], {
            workspaceScopeId: WORKSPACE,
        });
        const entry = ladderEntry(ladder, 'message.external');
        expect(entry?.rung).toBe('off');
        expect(entry?.decidedBy).toBe('workspace');
        expect(entry?.grantId).toBe('w1');
    });

    it('lets an Agent row NARROW below its workspace', () => {
        const ladder = resolveLadder(
            [
                row({ id: 'w1', category: 'machine.run', rung: 'auto' }),
                row({
                    id: 'a1',
                    scopeType: 'agent',
                    scopeId: AGENT,
                    category: 'machine.run',
                    rung: 'ask',
                }),
            ],
            { workspaceScopeId: WORKSPACE, agentId: AGENT },
        );
        const entry = ladderEntry(ladder, 'machine.run');
        expect(entry?.rung).toBe('ask');
        expect(entry?.decidedBy).toBe('agent');
        expect(entry?.workspaceRung).toBe('auto');
    });

    it('never lets an Agent row RAISE above its workspace', () => {
        // FR-10, read side. A row that predates a workspace demotion must not
        // be able to widen anything.
        const ladder = resolveLadder(
            [
                row({ id: 'w1', category: 'machine.run', rung: 'off' }),
                row({
                    id: 'a1',
                    scopeType: 'agent',
                    scopeId: AGENT,
                    category: 'machine.run',
                    rung: 'auto',
                }),
            ],
            { workspaceScopeId: WORKSPACE, agentId: AGENT },
        );
        const entry = ladderEntry(ladder, 'machine.run');
        expect(entry?.rung).toBe('off');
        expect(entry?.decidedBy).toBe('workspace');
    });

    it('reads a stored rung above its ceiling AT the ceiling', () => {
        // A row written before a ceiling existed, or by a direct database
        // edit, must not be able to exceed one.
        const ladder = resolveLadder([row({ category: 'message.external', rung: 'auto' })], {
            workspaceScopeId: WORKSPACE,
        });
        expect(ladderEntry(ladder, 'message.external')?.rung).toBe(
            ACTION_CATEGORY_CEILING['message.external'],
        );
    });

    it('keeps money off even when a row says otherwise', () => {
        const ladder = resolveLadder([row({ category: 'spend.commitment', rung: 'auto' })], {
            workspaceScopeId: WORKSPACE,
        });
        expect(ladderEntry(ladder, 'spend.commitment')?.rung).toBe('off');
    });

    it('ignores rows belonging to another workspace or another agent', () => {
        const ladder = resolveLadder(
            [
                row({ scopeId: 'someone-else', rung: 'off' }),
                row({ scopeType: 'agent', scopeId: 'other-agent', rung: 'off' }),
            ],
            { workspaceScopeId: WORKSPACE, agentId: AGENT },
        );
        expect(ladderEntry(ladder, 'message.external')?.decidedBy).toBe('default');
    });

    it('ignores agent rows entirely when resolving the workspace ladder', () => {
        const ladder = resolveLadder([row({ scopeType: 'agent', scopeId: AGENT, rung: 'off' })], {
            workspaceScopeId: WORKSPACE,
        });
        expect(ladderEntry(ladder, 'message.external')?.decidedBy).toBe('default');
    });

    it('resolves every laddered category to Ask in safe mode', () => {
        // FR-18 — the rails fail CLOSED. A rung that could not be read behaves
        // as Ask, and says so out loud.
        const ladder = resolveLadder([row({ rung: 'auto' })], {
            workspaceScopeId: WORKSPACE,
            safeMode: true,
        });
        expect(ladder.safeMode).toBe(true);
        for (const entry of ladder.entries) {
            expect(entry.enforced).toBe(true);
            expect(['off', 'ask']).toContain(entry.rung);
        }
    });

    it('never uses safe mode to widen a category whose ceiling is lower', () => {
        const ladder = resolveLadder([], { workspaceScopeId: WORKSPACE, safeMode: true });
        expect(ladderEntry(ladder, 'spend.commitment')?.rung).toBe('off');
    });

    it('carries the agent id it resolved for', () => {
        expect(resolveLadder([], { workspaceScopeId: WORKSPACE, agentId: AGENT }).agentId).toBe(
            AGENT,
        );
        expect(resolveLadder([], { workspaceScopeId: WORKSPACE }).agentId).toBeNull();
    });
});
