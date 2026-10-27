import { redactAuditDetails } from '../fleet-audit.service';
import {
    fleetRequestedBy,
    fleetRequestedByActor,
    fleetRequestedByExtra,
    parseFleetRequestedBy,
} from '../fleet-requested-by';

/** FL-19 T-19 — `requestedBy` (CONTRACTS §2.3) and its survival through audit redaction. */
describe('fleet requestedBy', () => {
    it('words every requester', () => {
        expect(fleetRequestedBy({ kind: 'user', userId: 'u1' })).toBe('user:u1');
        expect(fleetRequestedBy({ kind: 'agent', agentId: 'a1' })).toBe('agent:a1');
        expect(fleetRequestedBy({ kind: 'schedule', commandId: 'c1' })).toBe('schedule:c1');
        expect(fleetRequestedBy({ kind: 'system', job: 'idle-policy' })).toBe('system:idle-policy');
    });

    it('reads an actor as the Agent when it carries one', () => {
        expect(fleetRequestedByActor({ userId: 'u1', agentId: 'a1' })).toBe('agent:a1');
        expect(fleetRequestedByActor({ userId: 'u1' })).toBe('user:u1');
    });

    it('adds the Decision id only when one ran it', () => {
        expect(fleetRequestedByExtra({ kind: 'agent', agentId: 'a1' }, 'd1')).toEqual({
            requestedBy: 'agent:a1',
            decisionId: 'd1',
        });
        expect(fleetRequestedByExtra({ userId: 'u1' })).toEqual({ requestedBy: 'user:u1' });
    });

    it('parses a value back', () => {
        expect(parseFleetRequestedBy('agent:a1')).toEqual({ kind: 'agent', id: 'a1' });
        expect(parseFleetRequestedBy('robot:x')).toBeNull();
        expect(parseFleetRequestedBy(42)).toBeNull();
    });

    it('survives audit redaction', () => {
        const redacted = redactAuditDetails({
            requestedBy: 'agent:a1',
            decisionId: 'd1',
        }) as Record<string, unknown>;
        expect(redacted.requestedBy).toBe('agent:a1');
        expect(redacted.decisionId).toBe('d1');
    });
});
