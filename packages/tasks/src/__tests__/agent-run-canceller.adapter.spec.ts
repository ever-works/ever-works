import { describe, it, expect, vi } from 'vitest';
import { createAgentRunCancellerAdapter } from '../dispatchers/agent-task-dispatchers';
import type { TriggerService } from '../trigger/trigger.service';

/**
 * The adapter behind `AGENT_RUN_CANCELLER`. Its whole job is to translate
 * `TriggerService`'s boolean into an outcome an operator can act on, and to
 * uphold the port's never-throw contract — the controller calls it after the
 * DB cancel has already committed, so a throw would fail an HTTP request that
 * has already succeeded.
 */
describe('createAgentRunCancellerAdapter', () => {
    const makeTrigger = (over: Partial<TriggerService> = {}) =>
        ({
            isEnabled: vi.fn().mockReturnValue(true),
            cancel: vi.fn().mockResolvedValue(true),
            ...over,
        }) as unknown as TriggerService;

    it('reports "cancelled" when Trigger.dev accepts the request', async () => {
        const trigger = makeTrigger();
        const adapter = createAgentRunCancellerAdapter(trigger);
        await expect(adapter.cancel('run_abc')).resolves.toBe('cancelled');
        expect(trigger.cancel).toHaveBeenCalledWith('run_abc');
    });

    it('reports "not-configured" without calling the SDK when Trigger.dev is off', async () => {
        // This is the distinction a bare boolean would lose: an operator seeing
        // a wall of 'not-configured' knows TRIGGER_SECRET_KEY is missing, which
        // looks nothing like the benign already-terminal race.
        const trigger = makeTrigger({ isEnabled: vi.fn().mockReturnValue(false) });
        const adapter = createAgentRunCancellerAdapter(trigger);
        await expect(adapter.cancel('run_abc')).resolves.toBe('not-configured');
        expect(trigger.cancel).not.toHaveBeenCalled();
    });

    it('reports "failed" when the SDK call does not succeed', async () => {
        const trigger = makeTrigger({ cancel: vi.fn().mockResolvedValue(false) });
        const adapter = createAgentRunCancellerAdapter(trigger);
        await expect(adapter.cancel('run_abc')).resolves.toBe('failed');
    });

    it('passes the Trigger.dev run id through verbatim, not an AgentRun UUID', async () => {
        const trigger = makeTrigger();
        const adapter = createAgentRunCancellerAdapter(trigger);
        await adapter.cancel('run_xyz789');
        expect(trigger.cancel).toHaveBeenCalledWith('run_xyz789');
    });
});
