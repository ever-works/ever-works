import { SAFETY_ALLOW } from '@ever-works/contracts';
import {
    capsRail,
    grantsRail,
    ladderRail,
    platformStopRail,
    rulesRail,
    scopePauseRail,
    workspacePauseRail,
} from '../rails';
import type { SafetyRailContext } from '../safety-rails';
import { grantRow, makeContext } from './rail-test-helpers';

const next = async () => SAFETY_ALLOW;

describe('platformStopRail', () => {
    it('passes through when no stop flag is bound', async () => {
        expect(await platformStopRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('passes through when the flag is clear', async () => {
        const context = makeContext({
            platformStop: { shouldHaltDispatch: async () => false },
        });
        expect(await platformStopRail(context, next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses with platform-stopped when the flag is set', async () => {
        const context = makeContext({ platformStop: { shouldHaltDispatch: async () => true } });
        const verdict = await platformStopRail(context, next);
        expect(verdict.decision).toBe('refused');
        expect(verdict.railId).toBe('platform-stop');
        expect(verdict.reasonCode).toBe('platform-stopped');
    });

    it('FAILS CLOSED when the flag cannot be read', async () => {
        // The whole point of the flag is to survive the failure that makes it
        // unreadable, so a throw is a refusal rather than a pass.
        const context = makeContext({
            platformStop: {
                shouldHaltDispatch: async () => {
                    throw new Error('database down');
                },
            },
        });
        expect((await platformStopRail(context, next)).decision).toBe('refused');
    });
});

describe('workspacePauseRail', () => {
    it('passes through while the workspace is running', async () => {
        expect(await workspacePauseRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses while paused, and repeats the reason', async () => {
        const context = makeContext({
            pause: {
                paused: true,
                unverified: false,
                reason: 'chasing a bad instruction',
                pausedByUserId: 'user-1',
                pausedAt: '2026-09-16T10:00:00.000Z',
                refusedStarts: 3,
                cleanlyStopped: 1,
            },
        });
        const verdict = await workspacePauseRail(context, next);
        expect(verdict.decision).toBe('refused');
        expect(verdict.reasonCode).toBe('workspace-paused');
        expect(verdict.summary).toContain('chasing a bad instruction');
    });

    it('reports an unreadable pause as safe mode, and still refuses', async () => {
        const context = makeContext({
            pause: {
                paused: true,
                unverified: true,
                reason: null,
                pausedByUserId: null,
                pausedAt: null,
                refusedStarts: 0,
                cleanlyStopped: 0,
            },
        });
        const verdict = await workspacePauseRail(context, next);
        expect(verdict.decision).toBe('refused');
        expect(verdict.reasonCode).toBe('safe-mode');
    });
});

describe('scopePauseRail', () => {
    it('passes through when no port is bound', async () => {
        expect(await scopePauseRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses when the agent, mission or run is paused', async () => {
        const context = makeContext({ scopePause: { isScopePaused: async () => true } });
        const verdict = await scopePauseRail(context, next);
        expect(verdict.railId).toBe('scope-pause');
        expect(verdict.reasonCode).toBe('scope-paused');
    });

    it('defers to the existing status checks on a read error', async () => {
        // This rail is additive reporting; the authoritative status check is
        // still downstream, so refusing here on a transient failure would stop
        // work the real check would have admitted.
        const context = makeContext({
            scopePause: {
                isScopePaused: async () => {
                    throw new Error('nope');
                },
            },
        });
        expect(await scopePauseRail(context, next)).toEqual(SAFETY_ALLOW);
    });
});

describe('grantsRail', () => {
    it('passes through with no enforcer bound', async () => {
        expect(await grantsRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('passes through for an entry point that is not a tool call', async () => {
        const context = makeContext({
            toolName: null,
            grants: { isToolAllowed: async () => ({ allowed: false }) },
        });
        expect(await grantsRail(context, next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses with grant-denied and repeats the enforcer reason', async () => {
        const context = makeContext({
            grants: {
                isToolAllowed: async () => ({ allowed: false, reason: 'tool "sendEmail" denied' }),
            },
        });
        const verdict = await grantsRail(context, next);
        expect(verdict.reasonCode).toBe('grant-denied');
        expect(verdict.summary).toBe('tool "sendEmail" denied');
    });

    it('FAILS OPEN on an error, matching the enforcer own posture', async () => {
        const context = makeContext({
            grants: {
                isToolAllowed: async () => {
                    throw new Error('nope');
                },
            },
        });
        expect(await grantsRail(context, next)).toEqual(SAFETY_ALLOW);
    });
});

describe('ladderRail', () => {
    it('passes an unclassified action through while the policy is warn', async () => {
        const context = makeContext({ category: null, entryPointId: 'acme_thing' });
        expect(await ladderRail(context, next)).toEqual(SAFETY_ALLOW);
    });

    it('never ladders reading inside the workspace', async () => {
        // FR-2 — connections and tool grants decide that, one rail up.
        const context = makeContext({
            category: 'read.internal',
            rows: [grantRow({ category: 'message.external', rung: 'off' })],
        });
        expect(await ladderRail(context, next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses an explicit off rung, preparing and queueing nothing', async () => {
        const context = makeContext({ rows: [grantRow({ rung: 'off' })] });
        const verdict = await ladderRail(context, next);
        expect(verdict.decision).toBe('refused');
        expect(verdict.railId).toBe('ladder');
        expect(verdict.reasonCode).toBe('rung-off');
        expect(verdict.rung).toBe('off');
    });

    it('holds an explicit draft rung', async () => {
        const context = makeContext({ rows: [grantRow({ rung: 'draft' })] });
        const verdict = await ladderRail(context, next);
        expect(verdict.decision).toBe('held');
        expect(verdict.reasonCode).toBe('rung-held');
        expect(verdict.rung).toBe('draft');
    });

    it('holds an explicit ask rung', async () => {
        const context = makeContext({ rows: [grantRow({ rung: 'ask' })] });
        expect((await ladderRail(context, next)).decision).toBe('held');
    });

    it('passes an explicit auto rung to the rails below it', async () => {
        const context = makeContext({
            category: 'read.external',
            rows: [grantRow({ category: 'read.external', rung: 'auto' })],
        });
        expect(await ladderRail(context, next)).toEqual(SAFETY_ALLOW);
    });

    it('does not act on a rung nobody set', async () => {
        // The shipped default for message.external is `draft`, and it is
        // DISPLAYED rather than enforced until an approval can release a hold.
        expect(await ladderRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses in safe mode with the ceiling reported', async () => {
        const context = makeContext({
            ladder: {
                agentId: null,
                safeMode: true,
                entries: [
                    {
                        category: 'message.external',
                        rung: 'ask',
                        decidedBy: 'default',
                        ceiling: 'ask',
                        draftable: true,
                        defaultRung: 'draft',
                        workspaceRung: null,
                        grantId: null,
                        enforced: true,
                    },
                ],
            },
        });
        const verdict = await ladderRail(context, next);
        expect(verdict.decision).toBe('held');
        expect(verdict.safeMode).toBe(true);
        expect(verdict.ceiling).toEqual({ rung: 'ask', ceiling: 'ask', decidedBy: 'default' });
    });
});

describe('capsRail', () => {
    it('passes through with no budget stack bound', async () => {
        expect(await capsRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses with cap-reached', async () => {
        const context = makeContext({
            caps: { isWithinCaps: async () => ({ allowed: false, reason: 'daily cap reached' }) },
        });
        const verdict = await capsRail(context, next);
        expect(verdict.reasonCode).toBe('cap-reached');
        expect(verdict.summary).toBe('daily cap reached');
    });

    it('FAILS CLOSED when the spend cannot be counted', async () => {
        // A cap that permits whenever it cannot count is not a cap — the same
        // posture the budget guard takes with `unevaluable`.
        const context = makeContext({
            caps: {
                isWithinCaps: async () => {
                    throw new Error('ledger unavailable');
                },
            },
        });
        const verdict = await capsRail(context, next);
        expect(verdict.decision).toBe('refused');
        expect(verdict.reasonCode).toBe('cap-reached');
    });
});

describe('rulesRail', () => {
    it('passes through with nothing bound', async () => {
        expect(await rulesRail(makeContext(), next)).toEqual(SAFETY_ALLOW);
    });

    it('refuses with rule-blocked', async () => {
        const context = makeContext({
            rules: {
                isRuleSatisfied: async () => ({
                    allowed: false,
                    reason: 'agents may not merge into main',
                }),
            },
        });
        const verdict = await rulesRail(context, next);
        expect(verdict.reasonCode).toBe('rule-blocked');
        expect(verdict.summary).toBe('agents may not merge into main');
    });

    it('defers to the rule own call site on an error', async () => {
        const context = makeContext({
            rules: {
                isRuleSatisfied: async () => {
                    throw new Error('nope');
                },
            },
        });
        expect(await rulesRail(context, next)).toEqual(SAFETY_ALLOW);
    });
});

describe('the rail context', () => {
    it('exposes nothing the model can write', async () => {
        // FR-15 is the load-bearing requirement of the epic, and the TYPE is
        // how it stays true: adding an instruction, argument or document field
        // would have to be written into `SafetyRailContext` in the open.
        const context: SafetyRailContext = makeContext();
        const forbidden = [
            'args',
            'arguments',
            'prompt',
            'instructions',
            'standingInstructions',
            'skillBody',
            'memory',
            'memoryFacts',
            'document',
            'documents',
            'knowledge',
            'messages',
            'modelOutput',
            'fileContents',
        ];
        for (const field of forbidden) {
            expect(Object.prototype.hasOwnProperty.call(context, field)).toBe(false);
        }
    });
});
