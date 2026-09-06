import { isUUID } from 'class-validator';
import type { AgentRunCanceller, AgentRunCancelOutcome } from '@ever-works/agent/agents';
import type { FleetJobService } from '@ever-works/agent/fleet';

/**
 * Agent execution v2 (slice B) — cancel the REMOTE half of an AgentRun
 * whichever runtime holds it.
 *
 * `agent_runs.triggerRunId` is the stamp every dispatcher leaves behind:
 * a Trigger.dev run id (`run_…`) on the cloud path, a fleet job id (a
 * uuid) on the fleet path — see `FleetRunRouterService.enqueueAgentTask`
 * ("the caller stamps it onto the AgentRun the same way a Trigger.dev
 * run id is stamped"). Before this adapter the `AGENT_RUN_CANCELLER`
 * binding only knew Trigger.dev, so cancelling a fleet-executed run
 * flipped the row and left the PC's CLI running to completion.
 *
 * Dispatch is by SHAPE of the id, not by a runtime lookup: a uuid is
 * tried against the fleet first, and only a fleet miss ("not-found")
 * falls through to Trigger.dev, so a Trigger.dev deployment that happens
 * to mint uuid-shaped ids still cancels correctly. Never throws —
 * cancellation is best-effort and the DB transition has already
 * committed by the time this runs (see the port's contract).
 */
export function createFleetAwareAgentRunCanceller(
    trigger: AgentRunCanceller,
    fleetJobs: Pick<FleetJobService, 'cancel'>,
): AgentRunCanceller {
    return {
        async cancel(remoteRunId: string): Promise<AgentRunCancelOutcome> {
            if (typeof remoteRunId === 'string' && isUUID(remoteRunId)) {
                try {
                    const outcome = await fleetJobs.cancel(remoteRunId);
                    if (outcome.state !== 'not-found') {
                        return outcome.cancelled ? 'cancelled' : 'failed';
                    }
                } catch {
                    // A fleet store hiccup must not stop the Trigger.dev
                    // attempt below; the DB row is already cancelled.
                }
            }
            return trigger.cancel(remoteRunId);
        },
    };
}
