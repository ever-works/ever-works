import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkCreatedEvent } from '@ever-works/agent/events';
import { FleetExecutionPreferenceService, FleetNodeRepository } from '@ever-works/agent/fleet';
import { appWorkCloudPushAllowed } from '@ever-works/agent/tasks-domain';
import type { FleetExecutionMode, FleetNodeStatus } from '@ever-works/contracts';

/**
 * The statuses a node can still take work from (or will once it reconnects). A node still
 * `enrolling` never finished linking and a `disabled` one was taken out of service by its owner:
 * neither makes "wait for the fleet" a reasonable default.
 */
const USABLE_NODE_STATUSES: readonly FleetNodeStatus[] = ['online', 'offline', 'paused'];

/** The mode a new App Work defaults to when its owner has a fleet. */
export const APP_WORK_DEFAULT_EXECUTION_MODE: FleetExecutionMode = 'local-wait';

/**
 * What {@link FleetAppWorkPreferenceListener.defaultFor} decided for one new Work, as a short
 * machine token the spec and the log line both read.
 */
export type AppWorkPreferenceDefaultOutcome =
    | 'not-app-work'
    | 'work-row-exists'
    | 'owner-chose-cloud'
    | 'no-fleet'
    | 'written'
    | 'failed';

/**
 * 2026-10-21 (App Works follow-up b) — a new App Work defaults to its owner's FLEET.
 *
 * ## Why
 *
 * An App Work publishes ONLY from a Fleet node: cloud push is off for App Works (FR-12,
 * `appWorkCloudPushAllowed`). On prod 2026-10-18 (T-45) the Cal App Work had no execution
 * preference at all, so its change Task resolved to the platform default `local-fallback`, found
 * its pinned node unable to lease, and was relocated to a cloud run that could publish nothing and
 * parked asking a human. #2809 made the router hold such a run for the fleet; this listener makes
 * the Work SAY so from the moment it exists, so the Work's settings show the routing that will
 * actually happen and an owner can change it in one place.
 *
 * ## What it writes
 *
 * On `work.created` for an App Work whose creator owns at least one usable Fleet node, a
 * Work-scope execution preference of {@link APP_WORK_DEFAULT_EXECUTION_MODE} — through
 * `FleetExecutionPreferenceService.setForUser`, so the write is owner-scoped and audited exactly
 * like one made from the settings UI. Nothing is written when:
 *
 * - the Work is not an App Work (every other kind keeps the plain inheritance chain);
 * - a Work-scope row already exists (an explicit choice is never overwritten);
 * - the owner's account-wide preference is `cloud` (an explicit owner choice; the App Work then
 *   inherits it, and the router honours an explicit `cloud`);
 * - the owner has no usable node (there is nothing to wait for).
 *
 * Best-effort by construction: any failure is logged and swallowed, because a routing default must
 * never be the thing that fails a create — the router's own App Work guard (#2809) still holds the
 * run for the fleet without the row.
 */
@Injectable()
export class FleetAppWorkPreferenceListener {
    private readonly logger = new Logger(FleetAppWorkPreferenceListener.name);

    constructor(
        @Optional() private readonly preferences?: FleetExecutionPreferenceService,
        @Optional() private readonly nodes?: FleetNodeRepository,
    ) {}

    @OnEvent(WorkCreatedEvent.EVENT_NAME, { async: true })
    async onWorkCreated(event: WorkCreatedEvent): Promise<void> {
        const outcome = await this.defaultFor(event);
        if (outcome === 'written') {
            this.logger.log(
                `App Work ${event.work?.id} defaults to '${APP_WORK_DEFAULT_EXECUTION_MODE}' (its owner has a fleet)`,
            );
        }
    }

    /** The decision and the write, separated from the decorator so a spec drives it directly. */
    async defaultFor(event: WorkCreatedEvent): Promise<AppWorkPreferenceDefaultOutcome> {
        const work = event?.work;
        const workId = typeof work?.id === 'string' ? work.id : '';
        const ownerId = typeof work?.userId === 'string' ? work.userId : '';
        if (!workId || !ownerId || appWorkCloudPushAllowed(work?.kind)) {
            return 'not-app-work';
        }
        if (!this.preferences || !this.nodes) {
            return 'failed';
        }
        try {
            const rows = await this.preferences.listForUser(ownerId);
            if (rows.some((row) => row.scopeType === 'work' && row.scopeId === workId)) {
                return 'work-row-exists';
            }
            if (rows.some((row) => row.scopeType === 'user' && row.mode === 'cloud')) {
                return 'owner-chose-cloud';
            }
            const owned = await this.nodes.findByUser(ownerId);
            if (!owned.some((node) => USABLE_NODE_STATUSES.includes(node.status))) {
                return 'no-fleet';
            }
            await this.preferences.setForUser(ownerId, {
                scopeType: 'work',
                scopeId: workId,
                mode: APP_WORK_DEFAULT_EXECUTION_MODE,
                organizationId: work?.organizationId ?? null,
            });
            return 'written';
        } catch (error) {
            this.logger.warn(
                `Could not default App Work ${workId} to the owner's fleet: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return 'failed';
        }
    }
}
