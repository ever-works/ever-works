import {
    SKILL_CARD_STATES,
    deriveSkillCardState,
    type SkillReadinessState,
    type SkillRequirement,
} from '@ever-works/contracts';
import {
    decideSkillReadiness,
    declaredToolsOf,
    mcpServerNameOf,
    withRunSuppression,
    type SkillReadinessFindings,
} from '../skill-readiness.ladder';

/**
 * Skills shelf — the precedence ladder (spec FR-21/FR-22) as a table test.
 *
 * Stored verdicts: needs_setup → missing_requirements → blocked_by_access →
 * unknown → ready. The two switches (disabled, needs_review) are layered on
 * top at read time by `deriveSkillCardState`. A failed check can only ever
 * produce `unknown`.
 */
const NOW = new Date('2026-09-14T10:00:00.000Z');

function findings(over: Partial<SkillReadinessFindings> = {}): SkillReadinessFindings {
    return {
        bindingsFailed: false,
        boundTargetCount: 1,
        mutedBindingCount: 0,
        requirements: [],
        blockedForEveryAgent: false,
        evaluatedForAgentIds: ['a1'],
        evaluatedAt: NOW,
        ...over,
    };
}

const missing: SkillRequirement = {
    kind: 'credential',
    id: 'stripe_key',
    status: 'missing',
    reason: 'notSet',
};
const unknownRow: SkillRequirement = {
    kind: 'connection',
    id: 'billing-api',
    status: 'unknown',
    reason: 'checkFailed',
};
const refused: SkillRequirement = {
    kind: 'tool',
    id: 'deploy_work',
    status: 'refused',
    reason: 'refusedByGrants',
};
const met: SkillRequirement = { kind: 'tool', id: 'git_commit', status: 'met' };

describe('decideSkillReadiness — precedence ladder', () => {
    const table: Array<[string, Partial<SkillReadinessFindings>, SkillReadinessState]> = [
        ['nothing declared, one binding', {}, 'ready'],
        ['only met requirements', { requirements: [met] }, 'ready'],
        ['no binding at all', { boundTargetCount: 0 }, 'needs_setup'],
        ['every binding muted', { boundTargetCount: 2, mutedBindingCount: 2 }, 'needs_setup'],
        ['one of two bindings muted', { boundTargetCount: 2, mutedBindingCount: 1 }, 'ready'],
        ['a missing requirement', { requirements: [met, missing] }, 'missing_requirements'],
        [
            'blocked for every agent',
            { requirements: [refused], blockedForEveryAgent: true },
            'blocked_by_access',
        ],
        [
            'a refused tool but not blocked (partial capability)',
            { requirements: [refused, met] },
            'ready',
        ],
        ['a requirement that could not be checked', { requirements: [unknownRow] }, 'unknown'],
        ['binding lookup failed', { bindingsFailed: true, boundTargetCount: 0 }, 'unknown'],
        // Precedence between competing findings.
        [
            'needs_setup beats missing',
            { boundTargetCount: 0, requirements: [missing] },
            'needs_setup',
        ],
        [
            'needs_setup beats blocked',
            { boundTargetCount: 0, requirements: [refused], blockedForEveryAgent: true },
            'needs_setup',
        ],
        [
            'missing beats blocked',
            { requirements: [missing, refused], blockedForEveryAgent: true },
            'missing_requirements',
        ],
        ['missing beats unknown', { requirements: [unknownRow, missing] }, 'missing_requirements'],
        [
            'blocked beats unknown',
            { requirements: [unknownRow, refused], blockedForEveryAgent: true },
            'blocked_by_access',
        ],
        [
            'a failed binding lookup beats everything',
            { bindingsFailed: true, requirements: [missing] },
            'unknown',
        ],
    ];

    it.each(table)('%s → %s', (_name, over, expected) => {
        expect(decideSkillReadiness(findings(over)).readiness).toBe(expected);
    });

    it('never reports ready when any requirement could not be checked', () => {
        for (const extra of [[], [met], [refused]]) {
            const { readiness } = decideSkillReadiness(
                findings({ requirements: [...extra, unknownRow] }),
            );
            expect(readiness).not.toBe('ready');
        }
    });

    it('layers the two switches over every stored verdict for all seven card states', () => {
        const seen = new Set<string>();
        const verdicts: SkillReadinessState[] = [
            'ready',
            'needs_setup',
            'missing_requirements',
            'blocked_by_access',
            'unknown',
        ];
        for (const readiness of verdicts) {
            for (const disabledAt of [null, NOW]) {
                for (const reviewState of [null, 'proposed']) {
                    const state = deriveSkillCardState({ readiness, disabledAt, reviewState });
                    seen.add(state);
                    if (disabledAt) expect(state).toBe('disabled');
                    else if (reviewState) expect(state).toBe('needs_review');
                    else expect(state).toBe(readiness);
                }
            }
        }
        expect([...seen].sort()).toEqual([...SKILL_CARD_STATES].sort());
    });
});

describe('decideSkillReadiness — detail', () => {
    it('orders requirements missing → unknown → refused → met, stable within a status', () => {
        const a: SkillRequirement = { ...missing, id: 'a_key' };
        const b: SkillRequirement = { ...missing, id: 'b_key' };
        const { detail } = decideSkillReadiness(
            findings({ requirements: [met, refused, a, unknownRow, b] }),
        );
        expect(detail.requirements.map((row) => row.id)).toEqual([
            'a_key',
            'b_key',
            'billing-api',
            'deploy_work',
            'git_commit',
        ]);
        expect(detail.truncated).toBeUndefined();
        expect(detail.evaluatedAt).toBe(NOW.toISOString());
    });

    it('truncates at 20 rows and counts the overflow', () => {
        const rows = Array.from(
            { length: 23 },
            (_, i): SkillRequirement => ({
                kind: 'tool',
                id: `tool_${i}`,
                status: 'met',
            }),
        );
        const { detail } = decideSkillReadiness(findings({ requirements: rows }));
        expect(detail.requirements).toHaveLength(20);
        expect(detail.truncated).toBe(true);
        expect(detail.truncatedCount).toBe(3);
    });

    it('carries the binding counts and the agents the verdict covers', () => {
        const { detail } = decideSkillReadiness(
            findings({
                boundTargetCount: 3,
                mutedBindingCount: 1,
                evaluatedForAgentIds: ['a1', 'a2'],
            }),
        );
        expect(detail).toMatchObject({
            boundTargetCount: 3,
            mutedBindingCount: 1,
            evaluatedForAgentIds: ['a1', 'a2'],
        });
    });
});

describe('ladder helpers', () => {
    it.each([
        ['mcp__billing-api__create_invoice', 'billing-api'],
        ['mcp__crm__list__deep', 'crm'],
        ['mcp__solo', 'solo'],
        ['mcp____x', null],
        ['git_commit', null],
    ])('mcpServerNameOf(%p) → %p', (tool, server) => {
        expect(mcpServerNameOf(tool)).toBe(server);
    });

    it('declaredToolsOf trims, dedupes and ignores non-strings', () => {
        expect(declaredToolsOf([' git_commit ', 'git_commit', '', 3, 'deploy_work'])).toEqual([
            'git_commit',
            'deploy_work',
        ]);
        expect(declaredToolsOf(undefined)).toEqual([]);
        expect(declaredToolsOf('git_commit')).toEqual([]);
    });
});

describe('withRunSuppression', () => {
    it('marks a previously-ready Skill blocked and records the refused tools against the agent', () => {
        const next = withRunSuppression(
            {
                readiness: 'ready',
                readinessDetail: {
                    requirements: [{ kind: 'tool', id: 'deploy_work', status: 'met' }, met],
                    boundTargetCount: 2,
                    mutedBindingCount: 0,
                    evaluatedForAgentIds: ['a2'],
                    evaluatedAt: '2026-09-13T00:00:00.000Z',
                },
            },
            ['deploy_work'],
            'a1',
            NOW,
        );
        expect(next.readiness).toBe('blocked_by_access');
        expect(next.detail.requirements[0]).toEqual({
            kind: 'tool',
            id: 'deploy_work',
            status: 'refused',
            reason: 'refusedByGrants',
            fixTarget: { surface: 'access', ref: 'a1' },
        });
        expect(next.detail.requirements.filter((row) => row.id === 'deploy_work')).toHaveLength(1);
        expect(next.detail.boundTargetCount).toBe(2);
        expect(next.detail.evaluatedForAgentIds).toEqual(['a1', 'a2']);
        expect(next.detail.evaluatedAt).toBe(NOW.toISOString());
    });

    it('keeps the higher-priority missing_requirements badge', () => {
        const next = withRunSuppression(
            { readiness: 'missing_requirements' },
            ['deploy_work'],
            'a1',
            NOW,
        );
        expect(next.readiness).toBe('missing_requirements');
        expect(next.detail.boundTargetCount).toBe(1);
    });
});
