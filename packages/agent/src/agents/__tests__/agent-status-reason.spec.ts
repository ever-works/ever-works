import { buildAgentStatus, resolveAgentStatusReason } from '../agent-status-reason';
import { AgentHaltReason, AgentStatus } from '../../entities/agent.entity';

/**
 * The resolver is the single source of the sentence every agent surface
 * prints. Its PRECEDENCE is the design, so the cases below walk the
 * ladder top to bottom: each one asserts that the rung it names beats
 * every rung under it.
 */
describe('resolveAgentStatusReason', () => {
    const base = {
        status: AgentStatus.ACTIVE as AgentStatus | string,
        lastRunAt: new Date('2026-09-01T10:00:00.000Z'),
    };

    it('1. archived beats everything below it', () => {
        expect(
            resolveAgentStatusReason({
                ...base,
                status: AgentStatus.ARCHIVED,
                inFlightRunId: 'run-1',
                haltReason: AgentHaltReason.CREDENTIAL,
                openDecisionCount: 4,
            }),
        ).toBe('archived');
    });

    it('2. working beats waitingOnYou — what it is doing now is the better sentence', () => {
        expect(
            resolveAgentStatusReason({ ...base, inFlightRunId: 'run-1', openDecisionCount: 3 }),
        ).toBe('working');
        expect(resolveAgentStatusReason({ ...base, status: AgentStatus.RUNNING })).toBe('working');
    });

    it('3. a paused agent halted on a credential names the credential, not the pause', () => {
        expect(
            resolveAgentStatusReason({
                ...base,
                status: AgentStatus.PAUSED,
                haltReason: AgentHaltReason.CREDENTIAL,
            }),
        ).toBe('blockedOnCredential');
    });

    it('4-5. cap and platform halts keep their own reasons', () => {
        expect(
            resolveAgentStatusReason({
                ...base,
                status: AgentStatus.PAUSED,
                haltReason: AgentHaltReason.CAP,
            }),
        ).toBe('stoppedAtACap');
        expect(
            resolveAgentStatusReason({
                ...base,
                status: AgentStatus.PAUSED,
                haltReason: AgentHaltReason.PLATFORM,
            }),
        ).toBe('stoppedByThePlatform');
    });

    it('6. a paused agent with NO stored reason still reads "paused by you"', () => {
        // Every agent paused before AW-23 shipped is this case — no
        // backfill invented a reason for them.
        expect(
            resolveAgentStatusReason({ ...base, status: AgentStatus.PAUSED, haltReason: null }),
        ).toBe('pausedByYou');
    });

    it('6b. a failures halt that landed on paused still reads as an error, not a pause', () => {
        expect(
            resolveAgentStatusReason({
                ...base,
                status: AgentStatus.PAUSED,
                haltReason: AgentHaltReason.FAILURES,
            }),
        ).toBe('stoppedByFailures');
    });

    it('7. status=error reads stoppedByFailures even with decisions open', () => {
        expect(
            resolveAgentStatusReason({
                ...base,
                status: AgentStatus.ERROR,
                openDecisionCount: 2,
            }),
        ).toBe('stoppedByFailures');
    });

    it('8. an open decision beats idle', () => {
        expect(resolveAgentStatusReason({ ...base, openDecisionCount: 1 })).toBe('waitingOnYou');
        expect(resolveAgentStatusReason({ ...base, openDecisionCount: 0 })).toBe('idle');
    });

    it('9. notStarted only when the agent is a draft or has never run', () => {
        expect(resolveAgentStatusReason({ ...base, status: AgentStatus.DRAFT })).toBe('notStarted');
        expect(resolveAgentStatusReason({ ...base, lastRunAt: null })).toBe('notStarted');
        expect(resolveAgentStatusReason(base)).toBe('idle');
    });
});

describe('buildAgentStatus', () => {
    it('never renders a reason without the fields its sentence needs', () => {
        const status = buildAgentStatus('agent-1', {
            status: AgentStatus.PAUSED,
            haltReason: AgentHaltReason.USER,
            haltNote: 'holding until the rebrand ships Friday',
            haltedAt: new Date('2026-09-01T14:02:00.000Z'),
            haltRepeatCount: 1,
            inFlightCount: 1,
            heldCount: 2,
        });
        expect(status).toMatchObject({
            agentId: 'agent-1',
            reason: 'pausedByYou',
            note: 'holding until the rebrand ships Friday',
            since: '2026-09-01T14:02:00.000Z',
            repeatCount: 1,
            inFlightCount: 1,
            heldCount: 2,
        });
    });

    it('links a failure halt to the run that caused it, in one click', () => {
        const status = buildAgentStatus('agent-1', {
            status: AgentStatus.ERROR,
            haltedRunId: 'run-9',
            consecutiveFailures: 3,
            lastRunAt: new Date(),
        });
        expect(status.linkKind).toBe('run');
        expect(status.linkId).toBe('run-9');
        expect(status.failureCount).toBe(3);
    });

    it('falls back to the newest failed run when nothing was stored on the halt', () => {
        const status = buildAgentStatus('agent-1', {
            status: AgentStatus.ERROR,
            lastFailedRunId: 'run-newest',
            lastRunAt: new Date(),
        });
        expect(status.linkId).toBe('run-newest');
    });

    it('names the rejected connection on a credential halt and nothing else', () => {
        const status = buildAgentStatus('agent-1', {
            status: AgentStatus.PAUSED,
            haltReason: AgentHaltReason.CREDENTIAL,
            haltSubjectLabel: 'Model provider',
            haltedRunId: 'run-4',
            haltRepeatCount: 2,
            lastRunAt: new Date(),
        });
        expect(status).toMatchObject({
            reason: 'blockedOnCredential',
            subjectLabel: 'Model provider',
            linkKind: 'run',
            linkId: 'run-4',
            repeatCount: 2,
        });
        // Nothing resembling a secret can reach the payload: the only
        // free-text field on this branch is the caller-supplied label.
        expect(JSON.stringify(status)).not.toContain('sk-');
    });

    it('points a waiting agent at its oldest open decision when one is known', () => {
        expect(
            buildAgentStatus('agent-1', {
                status: AgentStatus.ACTIVE,
                openDecisionCount: 2,
                openDecisionId: 'escalation-7',
                lastRunAt: new Date(),
            }),
        ).toMatchObject({ reason: 'waitingOnYou', linkKind: 'decision', linkId: 'escalation-7' });
    });

    it('always reports counts, never undefined', () => {
        const status = buildAgentStatus('agent-1', { status: AgentStatus.DRAFT });
        expect(status.inFlightCount).toBe(0);
        expect(status.heldCount).toBe(0);
        expect(status.reason).toBe('notStarted');
    });
});
