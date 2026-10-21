import { describe, expect, it } from 'vitest';
import {
    FLEET_HELD_CALL_MAX_AGE_MS,
    formatFleetDecisionExpiry,
    isFleetActionDecisionPayload,
    readFleetActionDecision,
} from './fleet-action-decision.shared';

/** FL-19 T-15 — what the held-fleet-action card shows (spec §5.2, U12). */
describe('readFleetActionDecision', () => {
    const raisedAt = '2026-10-21T10:00:00.000Z';
    const now = Date.parse('2026-10-21T10:02:00.000Z');

    it('reads a fleet-tool-call: category, rung, class, arguments, expiry', () => {
        const view = readFleetActionDecision(
            {
                kind: 'fleet-tool-call',
                tool: 'fleet_services_action',
                args: { nodeId: 'n1', name: 'nginx', action: 'restart' },
                raisedAt,
                category: 'machine.admin',
                rung: 'ask',
                confirmationClass: 'confirm',
            },
            raisedAt,
            now,
        );
        expect(view).toMatchObject({
            kind: 'fleet-tool-call',
            category: 'machine.admin',
            rung: 'ask',
            confirmationClass: 'confirm',
            tool: 'fleet_services_action',
        });
        expect(view?.args).toEqual([
            ['nodeId', 'n1'],
            ['name', 'nginx'],
            ['action', 'restart'],
        ]);
        expect(view?.expiresInMs).toBe(FLEET_HELD_CALL_MAX_AGE_MS - 2 * 60_000);
    });

    it('reads an FL-09 machine action with its blast-radius sentence and no expiry', () => {
        const view = readFleetActionDecision(
            { kind: 'fleet-machine-action', verb: 'services.action', reason: 'blast-radius', sentence: 'This stops…' },
            raisedAt,
            now,
        );
        expect(view).toMatchObject({ sentence: 'This stops…', reason: 'blast-radius', expiresInMs: null, tool: 'services.action' });
    });

    it('ignores other proposals', () => {
        expect(readFleetActionDecision({ kind: 'agent-file-edit' }, raisedAt, now)).toBeNull();
        expect(isFleetActionDecisionPayload(undefined)).toBe(false);
    });

    it('formats hours and minutes left, never negative', () => {
        expect(formatFleetDecisionExpiry(FLEET_HELD_CALL_MAX_AGE_MS - 2 * 60_000)).toEqual({ hours: 23, minutes: 58 });
        expect(formatFleetDecisionExpiry(-5)).toEqual({ hours: 0, minutes: 0 });
    });
});
