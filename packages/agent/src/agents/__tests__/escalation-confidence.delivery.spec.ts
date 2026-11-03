import { heuristicConfidence } from '../escalation-confidence';

/**
 * APW-08 T7 — `delivery-failed` (a merged App Work change whose follow-up budget is spent)
 * carries the plan §3.4 prior of 0.85: a person has to decide, it is not infrastructure noise.
 */
describe('heuristicConfidence — delivery-failed (APW-08 T7)', () => {
    const attempt = { label: 'deploy', outcome: 'rolled back' };

    it('scores delivery-failed from its 0.85 prior, not the unknown-reason 0.5', () => {
        // One attempt on the trail = +0.05.
        expect(heuristicConfidence({ reasonCode: 'delivery-failed', attempted: [attempt] })).toBe(
            0.9,
        );
    });

    it('ranks it with guardrail-refusal and above a red gate', () => {
        const delivery = heuristicConfidence({ reasonCode: 'delivery-failed', attempted: [] });
        expect(delivery).toBe(
            heuristicConfidence({ reasonCode: 'guardrail-refusal', attempted: [] }),
        );
        expect(delivery).toBeGreaterThan(
            heuristicConfidence({ reasonCode: 'gate-exhausted', attempted: [] }),
        );
    });
});
