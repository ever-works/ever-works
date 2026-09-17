import type { ResolvedLadder } from '@ever-works/contracts';
import { resolveLadder, type AutonomyGrantRow } from '../../safety/trust-ladder';
import {
    PROPOSAL_ACTION_CATEGORY,
    applyLadderToGuardrailDecision,
    ladderDecidedGuardrail,
} from '../../safety/guardrail-interop';
import { evaluateGuardrails } from '../guardrails';

function ladderWith(rows: AutonomyGrantRow[]): ResolvedLadder {
    return resolveLadder(rows, { workspaceScopeId: 'org-1' });
}

function row(partial: Partial<AutonomyGrantRow>): AutonomyGrantRow {
    return {
        id: 'row-1',
        scopeType: 'workspace',
        scopeId: 'org-1',
        category: 'agent.fanout',
        rung: 'ask',
        ...partial,
    } as AutonomyGrantRow;
}

describe('applyLadderToGuardrailDecision', () => {
    it('changes nothing when no ladder is bound', () => {
        // The pre-ladder behaviour, and the behaviour of every runtime that
        // does not bind the safety module.
        expect(applyLadderToGuardrailDecision('auto_approve', 'spawn_agent', null)).toBe(
            'auto_approve',
        );
        expect(applyLadderToGuardrailDecision('queue', 'send_message', undefined)).toBe('queue');
    });

    it('changes nothing for an action type nothing classifies', () => {
        // FR-3 — unclassified is never guessed into a category, so the ladder
        // simply has no opinion about `other`.
        expect(
            applyLadderToGuardrailDecision(
                'auto_approve',
                'other',
                ladderWith([row({ category: 'agent.fanout', rung: 'off' })]),
            ),
        ).toBe('auto_approve');
    });

    it('does not act on a rung nobody set', () => {
        expect(applyLadderToGuardrailDecision('auto_approve', 'spawn_agent', ladderWith([]))).toBe(
            'auto_approve',
        );
    });

    it('blocks when the category is switched off', () => {
        const ladder = ladderWith([row({ category: 'agent.fanout', rung: 'off' })]);
        expect(applyLadderToGuardrailDecision('auto_approve', 'spawn_agent', ladder)).toBe('block');
        expect(applyLadderToGuardrailDecision('queue', 'schedule_task', ladder)).toBe('block');
    });

    it('queues an autonomous agent when the rung says draft or ask', () => {
        for (const rung of ['draft', 'ask'] as const) {
            const ladder = ladderWith([row({ category: 'message.external', rung })]);
            expect(applyLadderToGuardrailDecision('auto_approve', 'send_message', ladder)).toBe(
                'queue',
            );
        }
    });

    it('leaves an autonomous agent alone when the rung is auto', () => {
        const ladder = ladderWith([row({ category: 'agent.fanout', rung: 'auto' })]);
        expect(applyLadderToGuardrailDecision('auto_approve', 'spawn_agent', ladder)).toBe(
            'auto_approve',
        );
    });

    it('never softens a guardrail block', () => {
        // The stricter wins in BOTH directions, which is what stops one
        // switch quietly undoing the other.
        const ladder = ladderWith([row({ category: 'agent.fanout', rung: 'auto' })]);
        expect(applyLadderToGuardrailDecision('block', 'spawn_agent', ladder)).toBe('block');
    });

    it('never widens: a queue stays a queue however permissive the rung', () => {
        const ladder = ladderWith([row({ category: 'agent.fanout', rung: 'auto' })]);
        expect(applyLadderToGuardrailDecision('queue', 'spawn_agent', ladder)).toBe('queue');
    });

    it('composes with evaluateGuardrails without changing it', () => {
        // `evaluateGuardrails` itself is untouched: the interop wraps its
        // answer rather than replacing its rules.
        const guardrails = { mode: 'autonomous' as const };
        const decision = evaluateGuardrails(guardrails, 'spawn_agent', []);
        expect(decision).toBe('auto_approve');

        const ladder = ladderWith([row({ category: 'agent.fanout', rung: 'ask' })]);
        expect(applyLadderToGuardrailDecision(decision, 'spawn_agent', ladder)).toBe('queue');
    });

    it('keeps a merge proposal queued whatever the rung says', () => {
        // `merge_pull_request` queues unconditionally in `evaluateGuardrails`,
        // and the ladder can only ever be equal or stricter.
        const decision = evaluateGuardrails({ mode: 'autonomous' }, 'merge_pull_request', []);
        expect(decision).toBe('queue');
        const ladder = ladderWith([row({ category: 'publish.external', rung: 'auto' })]);
        expect(applyLadderToGuardrailDecision(decision, 'merge_pull_request', ladder)).toBe(
            'queue',
        );
    });
});

describe('PROPOSAL_ACTION_CATEGORY', () => {
    it('classifies a proposed message as leaving the workspace', () => {
        // The recipient lives in the payload, and a payload field is
        // model-writable, so the classification takes the more restrictive of
        // the two plausible categories instead of reading it (FR-4, FR-6).
        expect(PROPOSAL_ACTION_CATEGORY.send_message).toBe('message.external');
    });

    it('maps hiring and scheduling to the same kind of work', () => {
        expect(PROPOSAL_ACTION_CATEGORY.spawn_agent).toBe('agent.fanout');
        expect(PROPOSAL_ACTION_CATEGORY.schedule_task).toBe('agent.fanout');
    });

    it('leaves `other` unmapped', () => {
        expect(PROPOSAL_ACTION_CATEGORY.other).toBeUndefined();
    });
});

describe('ladderDecidedGuardrail', () => {
    it('names which of the two decided', () => {
        expect(ladderDecidedGuardrail('auto_approve', 'auto_approve')).toBe('guardrails');
        expect(ladderDecidedGuardrail('auto_approve', 'queue')).toBe('ladder');
    });
});
