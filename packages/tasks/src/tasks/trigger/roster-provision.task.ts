import { logger, task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import type { RosterProvisionPayload } from '@ever-works/agent/tasks';
import {
    RosterProvisioningService,
    type RosterProvisionLaneRequest,
} from '@ever-works/agent/agents';
import type { RosterBlueprintSlug, RosterLaneKey } from '@ever-works/contracts/api';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

/**
 * AW-20 P1 — provision one roster: a coordinator plus lane-owning
 * specialists, with reporting lines, a delegation allow-list and the
 * lane's suggested Skills.
 *
 * ## Why this is a job and not a request
 *
 * A four-lane roster is roughly thirty writes. They run sequentially
 * (agent names are unique per person, so parallel creation races that
 * check into false conflicts), each can be refused independently — a
 * taken name, a seat limit, a skill that will not attach — each retries
 * on its own clock, and the panel must be able to say what happened to
 * every lane WHILE the run is still going. None of that fits inside an
 * HTTP request, and holding one open for it would make the endpoint's
 * one-second response impossible.
 *
 * `maxDuration` is 180 s against the service's own 120 s wall clock, so
 * the service always gets to write its own terminal state rather than
 * being cut off mid-run and leaving a record that says `creating`
 * forever.
 *
 * The run id is the idempotency key: a double-fired enqueue (a retry at
 * the transport layer, two tabs whose conflict check raced) collapses to
 * one execution — the same reasoning `workflow-run.dispatcher.ts`
 * documents. Even without it the run would be safe, because provisioning
 * reuses a lane that is already filled; the key just avoids doing the
 * work twice.
 */
export const rosterProvisionTask = task<'roster-provision', RosterProvisionPayload>({
    id: 'roster-provision',
    maxDuration: 180,
    run: async (payload) => {
        // Security: the payload crosses a process boundary, so its ids are
        // validated before any DB access — same posture as the sibling
        // agent tasks in this folder.
        assertUuid(payload.userId, 'userId');
        assertUuid(payload.runId, 'runId');

        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('RosterProvision'));

        try {
            const service = appContext.get(RosterProvisioningService);
            const record = await service.execute({
                userId: payload.userId,
                tenantId: payload.tenantId ?? null,
                organizationId: payload.organizationId ?? null,
                runId: payload.runId,
                blueprintSlug: payload.blueprintSlug as RosterBlueprintSlug,
                lanes: payload.lanes.map(
                    (lane): RosterProvisionLaneRequest => ({
                        laneKey: lane.laneKey as RosterLaneKey,
                        name: lane.name,
                    }),
                ),
            });

            logger.info('roster-provision finished', {
                runId: payload.runId,
                state: record.state,
                laneCount: record.lanes.length,
            });

            return { status: record.state, runId: payload.runId };
        } finally {
            await appContext.close();
        }
    },
});
