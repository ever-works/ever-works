import {
    FLEET_TOOL_GATE_ORDER,
    fleetToolEntry,
    type FleetToolCatalogueEntry,
    type TrustRung,
} from '@ever-works/contracts';
import {
    FLEET_TOOL_GATES_SKIPPED_BY_READS,
    decideFleetToolCall,
    type FleetToolGateComputer,
    type FleetToolGateInput,
} from '../fleet-tool-gate';

/**
 * FL-19 T-03 — the gate truth table (spec ACC-FL19-05/06/07): grants × rung ×
 * audience × consent × kill switch, the first refusing gate named, an
 * audience refusal never creating a Decision.
 */

const services = fleetToolEntry('fleet_services_action') as FleetToolCatalogueEntry;
const servicesList = fleetToolEntry('fleet_services_list') as FleetToolCatalogueEntry;
const commandsRun = fleetToolEntry('fleet_commands_run') as FleetToolCatalogueEntry;

function computer(over: Partial<FleetToolGateComputer> = {}): FleetToolGateComputer {
    return {
        name: 'build-01',
        role: 'owner',
        viewAllows: true,
        familyAllows: true,
        consentRequired: 'manage',
        consents: { work: true, attend: false, manage: true, usageScan: false },
        ...over,
    };
}

function input(over: Partial<FleetToolGateInput> = {}): FleetToolGateInput {
    return {
        tool: services,
        agentName: 'Nina',
        killSwitch: false,
        workspacePaused: false,
        agentPaused: false,
        grant: { allowed: true },
        rung: 'auto',
        capExceeded: null,
        computer: computer(),
        ...over,
    };
}

describe('decideFleetToolCall', () => {
    it('publishes the AW-24 order and the gates a read skips', () => {
        expect(FLEET_TOOL_GATE_ORDER[0]).toBe('kill_switch');
        expect(FLEET_TOOL_GATE_ORDER[FLEET_TOOL_GATE_ORDER.length - 1]).toBe('consent');
        for (const gate of FLEET_TOOL_GATES_SKIPPED_BY_READS) expect(FLEET_TOOL_GATE_ORDER).toContain(gate);
    });

    it('allows an act at Auto when every gate agrees', () => {
        expect(decideFleetToolCall(input())).toMatchObject({ outcome: 'allow', gate: null, createsDecision: false });
    });

    it.each<[TrustRung, 'held' | 'refused' | 'allow']>([
        ['auto', 'allow'],
        ['ask', 'held'],
        ['draft', 'held'],
        ['off', 'refused'],
    ])('rung %s → %s', (rung, outcome) => {
        expect(decideFleetToolCall(input({ rung })).outcome).toBe(outcome);
    });

    it('holds at Ask with a Decision (spec S3)', () => {
        const decision = decideFleetToolCall(input({ rung: 'ask' }));
        expect(decision).toMatchObject({ outcome: 'held', gate: 'ladder', createsDecision: true, heldAt: 'ask' });
    });

    it('names the rung in an Off refusal and records it (spec U4)', () => {
        const decision = decideFleetToolCall(input({ rung: 'off' }));
        expect(decision.gate).toBe('ladder');
        expect(decision.error?.code).toBe('permission_denied');
        expect(decision.error?.hint).toBe("'Change a computer' is Off for Nina — raise it on Nina's Safety tab");
        expect(decision.recordsRefusal).toBe(true);
        expect(decision.createsDecision).toBe(false);
    });

    it('names the grant scope in a grant refusal (spec U5)', () => {
        const decision = decideFleetToolCall(input({ grant: { allowed: false, deniedAtScope: 'Work' } }));
        expect(decision.gate).toBe('grants');
        expect(decision.error?.hint).toBe('fleet_services_action is denied by a tool grant at Work scope');
        expect(decision.recordsRefusal).toBe(true);
    });

    it('refuses on the computer audience without a Decision, even at Ask (FR-9, spec S5)', () => {
        const decision = decideFleetToolCall(
            input({ rung: 'ask', computer: computer({ role: 'org-member', familyAllows: false }) }),
        );
        expect(decision.outcome).toBe('refused');
        expect(decision.gate).toBe('audience');
        expect(decision.error?.code).toBe('permission_denied');
        expect(decision.error?.hint).toBe('Ask the owner of build-01 to allow org members: services.');
        expect(decision.createsDecision).toBe(false);
        expect(decision.recordsRefusal).toBe(false);
    });

    it('answers not_found for a computer outside view', () => {
        const decision = decideFleetToolCall(input({ computer: computer({ role: 'stranger', viewAllows: false }) }));
        expect(decision.error?.code).toBe('not_found');
    });

    it('refuses a missing consent with the start command (spec U2)', () => {
        const decision = decideFleetToolCall(
            input({ computer: computer({ consents: { work: true, attend: false, manage: false, usageScan: false } }) }),
        );
        expect(decision.gate).toBe('consent');
        expect(decision.error).toMatchObject({ code: 'consent_missing' });
        expect(decision.error?.hint).toContain('--manage');
        expect(decision.error?.hint).toContain('build-01');
    });

    it('treats a node that never reported consents as holding none', () => {
        expect(decideFleetToolCall(input({ computer: computer({ consents: null }) })).gate).toBe('consent');
    });

    it('refuses every act while the kill switch is on, first (spec U3)', () => {
        const decision = decideFleetToolCall(
            input({ killSwitch: true, rung: 'off', grant: { allowed: false } }),
        );
        expect(decision.gate).toBe('kill_switch');
        expect(decision.error).toEqual({
            code: 'kill_switch',
            hint: 'clear it under Settings → Fleet',
            details: { gate: 'kill_switch' },
        });
    });

    it('keeps reads working under the kill switch, the pauses and an Off rung', () => {
        const decision = decideFleetToolCall(
            input({ tool: servicesList, killSwitch: true, workspacePaused: true, agentPaused: true, rung: 'off' }),
        );
        expect(decision.outcome).toBe('allow');
    });

    it('still checks a read against its grant, the audience and the consent', () => {
        expect(decideFleetToolCall(input({ tool: servicesList, grant: { allowed: false } })).gate).toBe('grants');
        expect(
            decideFleetToolCall(input({ tool: servicesList, computer: computer({ familyAllows: false, role: 'org-admin' }) }))
                .gate,
        ).toBe('audience');
    });

    it('applies the pauses in order before the grants', () => {
        expect(decideFleetToolCall(input({ workspacePaused: true, agentPaused: true })).gate).toBe('workspace_pause');
        expect(decideFleetToolCall(input({ agentPaused: true, grant: { allowed: false } })).gate).toBe('agent_pause');
    });

    it('refuses an exhausted cap after the ladder', () => {
        const decision = decideFleetToolCall(input({ capExceeded: '8 owner sessions on build-01' }));
        expect(decision.gate).toBe('caps');
        expect(decision.error).toMatchObject({ code: 'limit_exceeded', hint: '8 owner sessions on build-01' });
        expect(decideFleetToolCall(input({ rung: 'off', capExceeded: 'x' })).gate).toBe('ladder');
    });

    it('holds an always-held row even at Auto, but never past an audience refusal', () => {
        expect(decideFleetToolCall(input({ tool: commandsRun, computer: computer() }))).toMatchObject({
            outcome: 'held',
            heldAt: 'always',
        });
        expect(
            decideFleetToolCall(input({ tool: commandsRun, computer: computer({ familyAllows: false, role: 'org-member' }) }))
                .outcome,
        ).toBe('refused');
    });

    it('allows a fleet-wide call with no computer', () => {
        expect(decideFleetToolCall(input({ computer: null })).outcome).toBe('allow');
    });
});
