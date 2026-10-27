import type {
    ScheduleControlName,
    ScheduleControlReasonKey,
    ScheduleControls,
    ScheduleView,
} from './schedule-view.types';

/**
 * Schedules — which of the six row controls apply to a row, and why not.
 *
 * Pure. Every control is always DECLARED; one that does not apply is `false`
 * with a reason key, so the row menu keeps its shape and tells the owner why
 * (never a hidden entry). The descriptor only claims what the Schedules
 * control service can actually do for that source today:
 *
 *  - recurring Task — run now, and a pause that keeps the cadence;
 *  - Agent heartbeat — run now through the Agent's run-now path, and a pause
 *    that leaves the Agent itself active;
 *  - Mission tick — run one tick, and pause / resume the Mission (the tick
 *    cannot be separated from its Mission, so pausing asks first);
 *  - inbound Trigger — pause / resume; it fires on an external event, so
 *    there is nothing to run now;
 *  - the three Work-owned sources — managed on the Work's own settings;
 *  - a Command schedule on a computer (FL-13) — run now (needs the computer
 *    online and started with `--manage`), pause / resume, and duplicate /
 *    reassign (move to another computer) through the computer's own dialog.
 *
 * `edit` opens the owning entity's existing editor, which every source has.
 * Duplicate and reassign need the authored Schedule form and are declared
 * unavailable until it exists.
 */

type RowState = Pick<ScheduleView, 'sourceType' | 'status' | 'pausedAt' | 'health'> & {
    /**
     * The owning entity's own status when it differs from the row's — a
     * heartbeat row reads `paused` while its Agent is still `active`.
     * Defaults to the row status.
     */
    ownerStatus?: ScheduleView['status'];
    /** FL-13: the platform holds the computer's link right now (a Command schedule's Run now needs it). */
    nodeLinkUp?: boolean;
};

export function buildScheduleControls(row: RowState): ScheduleControls {
    const reasons: Partial<Record<ScheduleControlName, ScheduleControlReasonKey>> = {};
    const allow = (control: ScheduleControlName, reason: ScheduleControlReasonKey | null) => {
        if (reason) reasons[control] = reason;
        return reason === null;
    };

    const healthReason = row.health?.ok === false ? row.health.reason : null;

    let runNow: ScheduleControlReasonKey | null = null;
    let pause: ScheduleControlReasonKey | null = null;
    let resume: ScheduleControlReasonKey | null = null;
    let duplicate: ScheduleControlReasonKey | null = 'noAuthoredForm';
    let reassign: ScheduleControlReasonKey | null = 'noAuthoredForm';
    let pauseNeedsAcknowledgement = false;

    switch (row.sourceType) {
        case 'recurring_task': {
            if (healthReason === 'owner-archived') runNow = 'ownerArchived';
            else if (healthReason === 'no-agent') runNow = 'noAgent';
            if (row.status === 'ended') {
                pause = 'ended';
                resume = 'ended';
            } else if (row.pausedAt) {
                pause = 'alreadyPaused';
            } else {
                resume = 'notPaused';
            }
            duplicate = 'notAvailableYet';
            reassign = 'notAvailableYet';
            break;
        }
        case 'agent_heartbeat': {
            const agentStatus = row.ownerStatus ?? row.status;
            if (agentStatus === 'ended') {
                runNow = 'ownerArchived';
                pause = 'ownerArchived';
                resume = 'ownerArchived';
                break;
            }
            // The Agent's own run-now accepts ACTIVE (and RUNNING-normalised)
            // and ERROR Agents; a paused or draft Agent must be activated first.
            if (agentStatus !== 'active' && agentStatus !== 'error') runNow = 'ownerInactive';
            if (row.pausedAt) pause = 'alreadyPaused';
            else resume = 'notPaused';
            break;
        }
        case 'mission_tick': {
            if (row.status === 'ended') {
                runNow = 'ended';
                pause = 'ended';
                resume = 'ended';
            } else if (row.status === 'paused') {
                pause = 'alreadyPaused';
            } else if (row.status === 'error') {
                runNow = 'ownerInactive';
                pause = 'ownerInactive';
            } else if (row.status === 'active') {
                resume = 'notPaused';
                pauseNeedsAcknowledgement = true;
            } else {
                runNow = 'ownerInactive';
                pause = 'ownerInactive';
                resume = 'ownerInactive';
            }
            break;
        }
        case 'node_schedule': {
            // Schedules on computers (FL-13, spec FR-18): every control applies,
            // each disabled with the machine's own reason when it cannot.
            if (healthReason === 'consent-missing') runNow = 'consentMissing';
            else if (healthReason === 'node-removed') runNow = 'ownerArchived';
            else if (healthReason === 'node-unsupported') runNow = 'notAvailableYet';
            else if (row.nodeLinkUp === false) runNow = 'nodeOffline';
            if (row.pausedAt || row.status === 'paused') pause = 'alreadyPaused';
            else resume = 'notPaused';
            duplicate = null;
            reassign = null;
            break;
        }
        case 'inbound_trigger': {
            runNow = 'eventDriven';
            if (row.status === 'paused') pause = 'alreadyPaused';
            else resume = 'notPaused';
            break;
        }
        case 'work_schedule':
        case 'source_validation':
        case 'data_sync':
        // APW-02 T53: the upstream sync is spec-owned; Sync now is on the Work's Upstream tab.
        case 'app_upstream_sync':
        default: {
            runNow = 'managedOnWork';
            pause = 'managedOnWork';
            resume = 'managedOnWork';
            break;
        }
    }

    return {
        runNow: allow('runNow', runNow),
        pause: allow('pause', pause),
        resume: allow('resume', resume),
        edit: allow('edit', null),
        duplicate: allow('duplicate', duplicate),
        reassign: allow('reassign', reassign),
        pauseNeedsAcknowledgement,
        disabledReasons: reasons,
    };
}
