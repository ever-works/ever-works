import {
    FLEET_SESSION_SCHEDULE_LABEL,
    fleetSessionScheduleLabels,
    isFleetSessionScheduleTask,
    readFleetSessionScheduleLabels,
} from '../task-session-schedule.port';

const CHECKOUT = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

describe('Agent-session schedule labels (FL-13 P2, spec FR-8)', () => {
    it('round-trips the agent CLI and the checkout', () => {
        const labels = fleetSessionScheduleLabels({ provider: 'codex', checkoutId: CHECKOUT.toUpperCase() });
        expect(labels).toEqual([FLEET_SESSION_SCHEDULE_LABEL, 'fleet:provider:codex', `fleet:checkout:${CHECKOUT}`]);
        expect(readFleetSessionScheduleLabels(labels)).toEqual({ provider: 'codex', checkoutId: CHECKOUT });
    });

    it('defaults to Claude Code and the home folder, and ignores anything malformed', () => {
        expect(readFleetSessionScheduleLabels(['fleet:provider:other', 'fleet:checkout:../etc', 'bug'])).toEqual({
            provider: 'claude-code',
            checkoutId: null,
        });
        expect(readFleetSessionScheduleLabels(null)).toEqual({ provider: 'claude-code', checkoutId: null });
    });

    it('marks only Tasks that carry the label', () => {
        expect(isFleetSessionScheduleTask({ labels: [FLEET_SESSION_SCHEDULE_LABEL] })).toBe(true);
        expect(isFleetSessionScheduleTask({ labels: ['fleet:provider:codex'] })).toBe(false);
        expect(isFleetSessionScheduleTask({ labels: null })).toBe(false);
        expect(isFleetSessionScheduleTask(null)).toBe(false);
    });
});
