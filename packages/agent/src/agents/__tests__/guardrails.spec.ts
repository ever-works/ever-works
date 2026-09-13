import {
    AGENT_GUARDRAIL_MODES,
    evaluateGuardrails,
    validateGuardrails,
    type AgentGuardrails,
} from '../guardrails';

describe('validateGuardrails (pure)', () => {
    it('accepts a minimal require_approval policy', () => {
        expect(validateGuardrails({ mode: 'require_approval' })).toBeNull();
    });

    it('accepts a full autonomous policy with disjoint lists', () => {
        expect(
            validateGuardrails({
                mode: 'autonomous',
                autoApproveActionTypes: ['send_message', 'schedule_task'],
                blockedActionTypes: ['budget_override'],
            }),
        ).toBeNull();
    });

    it('accepts empty action-type lists', () => {
        expect(
            validateGuardrails({
                mode: 'autonomous',
                autoApproveActionTypes: [],
                blockedActionTypes: [],
            }),
        ).toBeNull();
    });

    it.each([null, undefined, 'autonomous', 42, ['autonomous']])(
        'rejects a non-object candidate (%p)',
        (candidate) => {
            expect(validateGuardrails(candidate)).toMatch(/must be an object/i);
        },
    );

    it('rejects a missing mode', () => {
        expect(validateGuardrails({})).toMatch(/mode must be one of/i);
    });

    it('rejects an unknown mode', () => {
        expect(validateGuardrails({ mode: 'yolo' })).toMatch(/mode must be one of/i);
    });

    it('rejects a non-array action-type list', () => {
        expect(
            validateGuardrails({ mode: 'autonomous', autoApproveActionTypes: 'send_message' }),
        ).toMatch(/autoApproveActionTypes must be an array/i);
        expect(validateGuardrails({ mode: 'autonomous', blockedActionTypes: null })).toMatch(
            /blockedActionTypes must be an array/i,
        );
    });

    it('rejects an unknown action type in either list', () => {
        expect(
            validateGuardrails({ mode: 'autonomous', autoApproveActionTypes: ['launch_rocket'] }),
        ).toMatch(/unknown action type: launch_rocket/i);
        expect(validateGuardrails({ mode: 'require_approval', blockedActionTypes: [7] })).toMatch(
            /unknown action type/i,
        );
    });

    it('rejects duplicate entries in a list', () => {
        expect(
            validateGuardrails({
                mode: 'autonomous',
                blockedActionTypes: ['send_message', 'send_message'],
            }),
        ).toMatch(/duplicate action type: send_message/i);
    });

    it('rejects overlapping auto-approve + blocked lists', () => {
        expect(
            validateGuardrails({
                mode: 'autonomous',
                autoApproveActionTypes: ['spawn_agent', 'send_message'],
                blockedActionTypes: ['other', 'send_message'],
            }),
        ).toMatch(/"send_message" cannot be both auto-approved and blocked/i);
    });

    it('exports exactly the two dispatch modes', () => {
        expect(AGENT_GUARDRAIL_MODES).toEqual(['require_approval', 'autonomous']);
    });
});

describe('evaluateGuardrails (pure)', () => {
    const autonomous: AgentGuardrails = { mode: 'autonomous' };

    it('queues when guardrails are null or undefined (legacy behavior)', () => {
        expect(evaluateGuardrails(null, 'send_message', [])).toBe('queue');
        expect(evaluateGuardrails(undefined, 'spawn_agent', [])).toBe('queue');
    });

    it('queues in require_approval mode even for a benign action', () => {
        expect(evaluateGuardrails({ mode: 'require_approval' }, 'send_message', [])).toBe('queue');
    });

    it('auto-approves an unflagged action in autonomous mode', () => {
        expect(evaluateGuardrails(autonomous, 'send_message', [])).toBe('auto_approve');
    });

    it('risk flags always force the queue, even in autonomous mode', () => {
        expect(evaluateGuardrails(autonomous, 'spawn_agent', ['high_fanout'])).toBe('queue');
        expect(evaluateGuardrails(autonomous, 'budget_override', ['budget_override'])).toBe(
            'queue',
        );
    });

    it('block wins over autonomous auto-approval', () => {
        expect(
            evaluateGuardrails(
                { mode: 'autonomous', blockedActionTypes: ['send_message'] },
                'send_message',
                [],
            ),
        ).toBe('block');
    });

    it('blocks in require_approval mode too', () => {
        expect(
            evaluateGuardrails(
                { mode: 'require_approval', blockedActionTypes: ['budget_override'] },
                'budget_override',
                [],
            ),
        ).toBe('block');
    });

    it('block wins even when the action carries risk flags', () => {
        expect(
            evaluateGuardrails(
                { mode: 'autonomous', blockedActionTypes: ['spawn_agent'] },
                'spawn_agent',
                ['high_fanout'],
            ),
        ).toBe('block');
    });

    it('autoApproveActionTypes narrows autonomous auto-approval', () => {
        const narrowed: AgentGuardrails = {
            mode: 'autonomous',
            autoApproveActionTypes: ['schedule_task'],
        };
        expect(evaluateGuardrails(narrowed, 'schedule_task', [])).toBe('auto_approve');
        expect(evaluateGuardrails(narrowed, 'send_message', [])).toBe('queue');
    });

    it('an empty autoApproveActionTypes list auto-approves nothing', () => {
        expect(
            evaluateGuardrails(
                { mode: 'autonomous', autoApproveActionTypes: [] },
                'send_message',
                [],
            ),
        ).toBe('queue');
    });

    it('an omitted autoApproveActionTypes list auto-approves every unflagged type', () => {
        for (const actionType of [
            'spawn_agent',
            'schedule_task',
            'send_message',
            'budget_override',
            'other',
        ] as const) {
            expect(evaluateGuardrails(autonomous, actionType, [])).toBe('auto_approve');
        }
    });

    // ── merge approval (self-build slice AE, EW-805) ─────────────────
    //
    // `merge_pull_request` is the one action type an Agent's own
    // configuration may never authorise. A merge onto a real branch
    // cannot be undone by a follow-up commit, so "the platform approved
    // its own work" is the failure that has no recovery.

    it('NEVER auto-approves a merge, whatever the Agent is configured to do', () => {
        expect(evaluateGuardrails(autonomous, 'merge_pull_request', [])).toBe('queue');
        expect(
            evaluateGuardrails(
                { mode: 'autonomous', autoApproveActionTypes: ['merge_pull_request'] },
                'merge_pull_request',
                [],
            ),
        ).toBe('queue');
    });

    it('still BLOCKS a merge when the Agent forbids it — the rule only stops approval', () => {
        expect(
            evaluateGuardrails(
                { mode: 'autonomous', blockedActionTypes: ['merge_pull_request'] },
                'merge_pull_request',
                [],
            ),
        ).toBe('block');
    });

    it('queues a merge under a require_approval Agent, like everything else', () => {
        expect(evaluateGuardrails({ mode: 'require_approval' }, 'merge_pull_request', [])).toBe(
            'queue',
        );
    });
});
