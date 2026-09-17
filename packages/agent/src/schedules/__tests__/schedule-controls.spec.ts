import { buildScheduleControls } from '../schedule-controls';
import type { ScheduleHealth, ScheduleView } from '../schedule-view.types';

const OK: ScheduleHealth = {
    ok: true,
    reason: null,
    reasonKey: null,
    repair: 'none',
    checkedAt: null,
};

function row(over: Partial<Pick<ScheduleView, 'sourceType' | 'status' | 'pausedAt' | 'health'>>) {
    return {
        sourceType: 'recurring_task' as const,
        status: 'active' as const,
        pausedAt: null,
        health: OK,
        ...over,
    };
}

const CONTROLS = ['runNow', 'pause', 'resume', 'edit', 'duplicate', 'reassign'] as const;

describe('buildScheduleControls', () => {
    it('always declares all six controls, with a reason for every one that is off', () => {
        for (const sourceType of [
            'recurring_task',
            'agent_heartbeat',
            'work_schedule',
            'mission_tick',
            'source_validation',
            'data_sync',
            'inbound_trigger',
        ] as const) {
            const controls = buildScheduleControls(row({ sourceType }));
            for (const control of CONTROLS) {
                expect(typeof controls[control]).toBe('boolean');
                if (!controls[control]) {
                    expect(controls.disabledReasons[control]).toBeTruthy();
                } else {
                    expect(controls.disabledReasons[control]).toBeUndefined();
                }
            }
            // Every source has an owning editor to open.
            expect(controls.edit).toBe(true);
        }
    });

    it('recurring Task: run now + pause while active, resume while paused', () => {
        const active = buildScheduleControls(row({}));
        expect(active).toMatchObject({ runNow: true, pause: true, resume: false });
        expect(active.disabledReasons.resume).toBe('notPaused');
        expect(active.disabledReasons.duplicate).toBe('notAvailableYet');

        const paused = buildScheduleControls(
            row({ status: 'paused', pausedAt: '2026-09-14T09:00:00.000Z' }),
        );
        // Run now on a paused Schedule is allowed and does not resume it (FR-16).
        expect(paused).toMatchObject({ runNow: true, pause: false, resume: true });
        expect(paused.disabledReasons.pause).toBe('alreadyPaused');
    });

    it('recurring Task: refuses run now for the reason health already states', () => {
        const noAgent = buildScheduleControls(
            row({
                health: {
                    ...OK,
                    ok: false,
                    reason: 'no-agent',
                    reasonKey: 'noAgent',
                    repair: 'choice',
                },
            }),
        );
        expect(noAgent.runNow).toBe(false);
        expect(noAgent.disabledReasons.runNow).toBe('noAgent');

        const archived = buildScheduleControls(
            row({
                health: {
                    ...OK,
                    ok: false,
                    reason: 'owner-archived',
                    reasonKey: 'ownerArchived',
                    repair: 'choice',
                },
            }),
        );
        expect(archived.disabledReasons.runNow).toBe('ownerArchived');
    });

    it('recurring Task that has ended cannot be paused or resumed', () => {
        const ended = buildScheduleControls(row({ status: 'ended' }));
        expect(ended).toMatchObject({ pause: false, resume: false });
        expect(ended.disabledReasons.pause).toBe('ended');
    });

    it('heartbeat: pause is independent of the Agent; run now needs an active or errored Agent', () => {
        expect(buildScheduleControls(row({ sourceType: 'agent_heartbeat' }))).toMatchObject({
            runNow: true,
            pause: true,
            resume: false,
        });
        const draft = buildScheduleControls(
            row({ sourceType: 'agent_heartbeat', status: 'disabled' }),
        );
        expect(draft.disabledReasons.runNow).toBe('ownerInactive');
        expect(draft.pause).toBe(true);
        expect(
            buildScheduleControls(row({ sourceType: 'agent_heartbeat', status: 'error' })).runNow,
        ).toBe(true);
        const archived = buildScheduleControls(
            row({ sourceType: 'agent_heartbeat', status: 'ended' }),
        );
        expect(archived).toMatchObject({ runNow: false, pause: false, resume: false });
        expect(archived.disabledReasons.pause).toBe('ownerArchived');
    });

    it('Mission tick: pausing an active Mission asks first; a completed one is Ended', () => {
        const active = buildScheduleControls(row({ sourceType: 'mission_tick' }));
        expect(active).toMatchObject({
            runNow: true,
            pause: true,
            pauseNeedsAcknowledgement: true,
        });
        const paused = buildScheduleControls(row({ sourceType: 'mission_tick', status: 'paused' }));
        expect(paused).toMatchObject({
            runNow: true,
            pause: false,
            resume: true,
            pauseNeedsAcknowledgement: false,
        });
        const failed = buildScheduleControls(row({ sourceType: 'mission_tick', status: 'error' }));
        expect(failed).toMatchObject({ runNow: false, pause: false, resume: true });
        const ended = buildScheduleControls(row({ sourceType: 'mission_tick', status: 'ended' }));
        expect(ended).toMatchObject({ runNow: false, pause: false, resume: false });
        expect(ended.disabledReasons.runNow).toBe('ended');
    });

    it('inbound Trigger: nothing to run now; pause and resume follow its status', () => {
        const active = buildScheduleControls(row({ sourceType: 'inbound_trigger' }));
        expect(active).toMatchObject({ runNow: false, pause: true, resume: false });
        expect(active.disabledReasons.runNow).toBe('eventDriven');
        expect(
            buildScheduleControls(row({ sourceType: 'inbound_trigger', status: 'paused' })),
        ).toMatchObject({
            pause: false,
            resume: true,
        });
    });

    it.each(['work_schedule', 'source_validation', 'data_sync'] as const)(
        '%s is managed on its Work',
        (sourceType) => {
            const controls = buildScheduleControls(row({ sourceType }));
            expect(controls).toMatchObject({
                runNow: false,
                pause: false,
                resume: false,
                edit: true,
            });
            expect(controls.disabledReasons).toMatchObject({
                runNow: 'managedOnWork',
                pause: 'managedOnWork',
                resume: 'managedOnWork',
                duplicate: 'noAuthoredForm',
                reassign: 'noAuthoredForm',
            });
        },
    );
});
