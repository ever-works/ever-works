import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FleetJobCompletedEvent } from '@ever-works/agent/events';
import { FleetRunCredentialService } from '@ever-works/agent/fleet';

/**
 * Self-build slice Z (EW-796) — the platform-side half of "the token dies
 * with the job".
 *
 * ## Why a listener and not a call inside `completeJob`
 *
 * Every terminal path a fleet job can take already converges on ONE
 * event: `FleetJobCompletedEvent`, emitted for a node's own report, for
 * an operator cancel, for a lease the reclaim sweep exhausted, and for a
 * job the queue SLA failed. Hanging the revoke off that event covers all
 * four with one subscription, and — just as importantly — adds NOTHING
 * to `FleetJobService`, which sibling slices are editing concurrently.
 *
 * ## Why it does not rely on the node revoking
 *
 * The node revokes explicitly at the end of its model step, and that is
 * the fast path. But a node that lost power, lost the network, or was
 * drained mid-run never gets there. This listener is what guarantees the
 * credential stops working even then: the reclaim sweep settles the job,
 * the event fires, the tokens are deactivated. Belt and braces, with the
 * braces on the platform side where they cannot be skipped.
 *
 * Best-effort by construction: a revoke that throws is logged and
 * swallowed, exactly like the reconciler's own side effects. The token
 * still expires on its own (lease deadline + grace), so a failed revoke
 * narrows to a bounded window rather than an open one.
 */
@Injectable()
export class FleetMcpCredentialListener {
    private readonly logger = new Logger(FleetMcpCredentialListener.name);

    constructor(private readonly credentials: FleetRunCredentialService) {}

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    async onCompleted(event: FleetJobCompletedEvent): Promise<void> {
        // Cheap guard, not an authorization: only `agent-task` jobs ever
        // carry a bridge, so every other kind skips a write.
        if (event.job?.kind !== 'agent-task') return;
        const jobId = event.job.id;
        try {
            const revoked = await this.credentials.revokeForJob(jobId, 'job-settled');
            if (revoked > 0) {
                // jobId and the completion source only — never the token,
                // and never anything the model could have influenced.
                this.logger.log(
                    `Revoked ${revoked} MCP run credential(s) for settled job ${jobId} (${event.source})`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `Could not revoke MCP run credentials for job ${jobId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
