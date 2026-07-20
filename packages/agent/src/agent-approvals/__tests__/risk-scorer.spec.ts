import { HIGH_FANOUT_DEPTH, RISK_SCORER } from '../risk-scorer';

describe('RISK_SCORER (pure)', () => {
    it('returns no flags for a benign action', () => {
        expect(RISK_SCORER({ actionType: 'send_message', payload: {} })).toEqual([]);
    });

    it('flags budget_override when the action type is budget_override', () => {
        expect(RISK_SCORER({ actionType: 'budget_override', payload: {} })).toEqual([
            'budget_override',
        ]);
    });

    it('does not flag budget_override for other action types', () => {
        expect(RISK_SCORER({ actionType: 'schedule_task', payload: {} })).not.toContain(
            'budget_override',
        );
    });

    it('flags destructive when payload.destructive is truthy', () => {
        expect(RISK_SCORER({ actionType: 'other', payload: { destructive: true } })).toEqual([
            'destructive',
        ]);
    });

    it('flags cross_scope when payload.crossScope is true', () => {
        expect(RISK_SCORER({ actionType: 'spawn_agent', payload: { crossScope: true } })).toEqual([
            'cross_scope',
        ]);
    });

    it('flags cross_scope when source and target scope differ', () => {
        expect(
            RISK_SCORER({
                actionType: 'send_message',
                payload: { sourceScope: 'org-a', targetScope: 'org-b' },
            }),
        ).toEqual(['cross_scope']);
    });

    it('does not flag cross_scope when source and target scope match', () => {
        expect(
            RISK_SCORER({
                actionType: 'send_message',
                payload: { sourceScope: 'org-a', targetScope: 'org-a' },
            }),
        ).toEqual([]);
    });

    it(`flags high_fanout at spawnDepth >= ${HIGH_FANOUT_DEPTH}`, () => {
        expect(
            RISK_SCORER({ actionType: 'spawn_agent', payload: { spawnDepth: HIGH_FANOUT_DEPTH } }),
        ).toEqual(['high_fanout']);
        expect(
            RISK_SCORER({
                actionType: 'spawn_agent',
                payload: { spawnDepth: HIGH_FANOUT_DEPTH + 5 },
            }),
        ).toEqual(['high_fanout']);
    });

    it('does not flag high_fanout below the threshold', () => {
        expect(
            RISK_SCORER({
                actionType: 'spawn_agent',
                payload: { spawnDepth: HIGH_FANOUT_DEPTH - 1 },
            }),
        ).toEqual([]);
    });

    it('emits multiple flags in a stable canonical order', () => {
        const flags = RISK_SCORER({
            actionType: 'budget_override',
            payload: { destructive: true, crossScope: true, spawnDepth: 4 },
        });
        expect(flags).toEqual(['budget_override', 'destructive', 'cross_scope', 'high_fanout']);
    });

    it('tolerates a null / undefined payload', () => {
        expect(RISK_SCORER({ actionType: 'budget_override', payload: null })).toEqual([
            'budget_override',
        ]);
        expect(RISK_SCORER({ actionType: 'other' })).toEqual([]);
    });

    it('is pure — same input yields the same output', () => {
        const input = { actionType: 'spawn_agent' as const, payload: { spawnDepth: 3 } };
        expect(RISK_SCORER(input)).toEqual(RISK_SCORER(input));
    });
});
