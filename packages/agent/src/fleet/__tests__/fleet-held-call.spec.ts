import {
    FLEET_TOOL_CALL_PROPOSAL_KIND,
    buildFleetHeldCallPayload,
    fleetHeldCallConfirmFields,
    fleetHeldCallSubjectKey,
    fleetHeldCallSummary,
    heldFleetToolEntry,
    isFleetHeldCallPayload,
    isFleetHeldCallStale,
    sanitizeFleetHeldArgs,
} from '../fleet-held-call';

/** FL-19 T-13 — a held fleet act as a Decision (spec S3, U12; CONTRACTS R-33). */
describe('fleet held calls', () => {
    const input = {
        userId: 'u1',
        agentId: 'a1',
        agentName: 'Nina',
        runId: 'r1',
        tool: 'fleet_services_action',
        args: {
            nodeId: 'n1',
            name: 'nginx',
            action: 'restart',
            confirm: true,
            acknowledgeBlastRadius: true,
        },
        category: 'machine.admin',
        rung: 'ask',
    };

    it('holds only catalogued state-changing fleet tools', () => {
        expect(heldFleetToolEntry('fleet_services_action')?.name).toBe('fleet_services_action');
        expect(heldFleetToolEntry('fleet_services_list')).toBeNull();
        expect(heldFleetToolEntry('sendEmail')).toBeNull();
        expect(buildFleetHeldCallPayload({ ...input, tool: 'fleet_services_list' })).toBeNull();
    });

    it('builds the platform-written payload without the model confirmation fields', () => {
        const payload = buildFleetHeldCallPayload(input, new Date('2026-10-21T10:00:00Z'))!;
        expect(payload).toMatchObject({
            kind: FLEET_TOOL_CALL_PROPOSAL_KIND,
            tool: 'fleet_services_action',
            args: { nodeId: 'n1', name: 'nginx', action: 'restart' },
            agentId: 'a1',
            runId: 'r1',
            raisedAt: '2026-10-21T10:00:00.000Z',
            rung: 'ask',
            confirmationClass: 'confirm',
        });
        expect(payload.summary).toBe('Nina wants to restart nginx (services)');
        expect(isFleetHeldCallPayload(payload)).toBe(true);
    });

    it('refuses arguments that are not an object or too large to keep', () => {
        expect(sanitizeFleetHeldArgs('restart')).toBeNull();
        expect(sanitizeFleetHeldArgs({ blob: 'x'.repeat(9_000) })).toBeNull();
        expect(sanitizeFleetHeldArgs(undefined)).toEqual({});
    });

    it('has the approval supply the confirmation, keeping only a typed name', () => {
        expect(fleetHeldCallConfirmFields({ args: {} })).toEqual({
            confirm: true,
            acknowledgeBlastRadius: true,
        });
        expect(fleetHeldCallConfirmFields({ args: { confirmName: 'win-11-vm' } })).toEqual({
            confirm: true,
            acknowledgeBlastRadius: true,
            confirmName: 'win-11-vm',
        });
    });

    it('treats an approval more than 24 h after the hold as stale (U12)', () => {
        const now = new Date('2026-10-22T11:00:00Z');
        expect(isFleetHeldCallStale({ raisedAt: '2026-10-21T10:00:00Z' }, now)).toBe(true);
        expect(isFleetHeldCallStale({ raisedAt: '2026-10-22T10:00:00Z' }, now)).toBe(false);
    });

    it('de-duplicates per Agent, tool, arguments and hour', () => {
        const a = buildFleetHeldCallPayload(input, new Date('2026-10-21T10:05:00Z'))!;
        const b = buildFleetHeldCallPayload(input, new Date('2026-10-21T10:55:00Z'))!;
        const c = buildFleetHeldCallPayload(input, new Date('2026-10-21T11:05:00Z'))!;
        expect(fleetHeldCallSubjectKey(a)).toBe(fleetHeldCallSubjectKey(b));
        expect(fleetHeldCallSubjectKey(a)).not.toBe(fleetHeldCallSubjectKey(c));
        expect(
            fleetHeldCallSubjectKey(a).startsWith('fleet-tool-call:fleet_services_action:'),
        ).toBe(true);
    });

    it('names the act a person recognises', () => {
        expect(
            fleetHeldCallSummary(
                null,
                { name: 'fleet_ports_open', family: 'ports', verb: 'open' },
                { port: 3000 },
            ),
        ).toBe('An Agent wants to open 3000 (ports)');
    });

    it('rejects a payload that is not a held call', () => {
        expect(isFleetHeldCallPayload({ kind: 'fleet-machine-action' })).toBe(false);
        expect(isFleetHeldCallPayload(null)).toBe(false);
    });
});
