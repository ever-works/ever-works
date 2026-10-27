import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkUpstreamStateRepository } from '@ever-works/agent/database';
import { AppSpecAppliedEvent } from '@ever-works/agent/events';
import { AppSpecService } from '@ever-works/agent/app-spec';
import { nextUpstreamSyncAt, readUpstreamSyncSettings } from '@ever-works/agent/app-works';

/**
 * APW-02 T49 (FR-64, ACC-02-28) — the App spec decides the upstream sync schedule, so a
 * spec change must move the next slot.
 *
 * The sync run reads the four `upstreamSync` fields fresh on every run, but the dispatcher
 * only claims a row whose `nextSyncAt` has arrived — so before this listener a spec that
 * turned the schedule off kept its old slot until the next run, and one that turned it on
 * (or tightened the cron) waited for a slot that was never written.
 *
 * **In the API process**, on `app.spec.applied`, when `changedBlocks` includes `upstreamSync`
 * or `source`: recompute `syncSchedule` (what the card renders) and `nextSyncAt` (what the
 * dispatcher claims) from the effective spec. Nothing is dispatched and no other column is
 * written. `enabled: false` (or a `mode` the platform does not carry out) ⇒ `nextSyncAt =
 * null`, so the dispatcher never selects the row; a manual **Sync now** still works.
 *
 * A row that is not ready, or is paused (archived / unavailable upstream, a missing Work
 * Repository), gets the schedule only: its `nextSyncAt` is the pause's to clear and the
 * readiness hand-off's (or the unavailable sweep's) to set, and a slot written here would
 * only queue a run that pauses again.
 */
export interface AppSpecAppliedUpstreamOutcome {
    workId: string;
    recomputed: boolean;
    reason:
        | 'recomputed'
        | 'schedule_only'
        | 'unrelated_blocks'
        | 'no_work'
        | 'no_state'
        | 'link'
        | 'failed';
    schedule?: string;
    nextSyncAt?: string | null;
}

/** The two spec blocks that decide the upstream schedule (T49). */
export const APP_UPSTREAM_SCHEDULE_BLOCKS: readonly string[] = ['upstreamSync', 'source'];

@Injectable()
export class AppSpecAppliedUpstreamListener {
    private readonly logger = new Logger(AppSpecAppliedUpstreamListener.name);

    constructor(
        private readonly rows: WorkUpstreamStateRepository,
        @Optional() private readonly specs?: AppSpecService,
    ) {}

    @OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true })
    async onSpecApplied(
        event: Pick<AppSpecAppliedEvent, 'workId' | 'changedBlocks'>,
        now: Date = new Date(),
    ): Promise<AppSpecAppliedUpstreamOutcome> {
        const workId = typeof event?.workId === 'string' ? event.workId.trim() : '';
        if (!workId) {
            return { workId: '', recomputed: false, reason: 'no_work' };
        }
        const blocks = Array.isArray(event?.changedBlocks) ? event.changedBlocks : [];
        if (!blocks.some((block) => APP_UPSTREAM_SCHEDULE_BLOCKS.includes(block))) {
            return { workId, recomputed: false, reason: 'unrelated_blocks' };
        }

        try {
            const row = await this.rows.findByWorkId(workId);
            if (!row) {
                return { workId, recomputed: false, reason: 'no_state' };
            }
            if (row.relation === 'link') {
                // FR-44: a linked App Work has no upstream and never syncs.
                return { workId, recomputed: false, reason: 'link' };
            }

            const snapshot = this.specs ? await this.specs.getEffectiveSpec(workId) : null;
            const settings = readUpstreamSyncSettings(
                (snapshot?.spec as Record<string, unknown> | null | undefined) ?? null,
            );

            const paused =
                row.upstreamStatus === 'archived' ||
                row.upstreamStatus === 'unavailable' ||
                row.dataRepositoryStatus === 'missing' ||
                row.lastSyncResult === 'paused';
            const ready =
                row.readinessState === 'ready' || row.readinessState === 'waiting_for_setup_pr';

            if (paused || !ready) {
                await this.rows.update(workId, { syncSchedule: settings.schedule });
                return {
                    workId,
                    recomputed: false,
                    reason: 'schedule_only',
                    schedule: settings.schedule,
                };
            }

            const nextSyncAt = nextUpstreamSyncAt(settings, now, workId);
            await this.rows.update(workId, { syncSchedule: settings.schedule, nextSyncAt });
            return {
                workId,
                recomputed: true,
                reason: 'recomputed',
                schedule: settings.schedule,
                nextSyncAt: nextSyncAt ? nextSyncAt.toISOString() : null,
            };
        } catch (error) {
            // A listener that throws would surface in whatever emitted the event; the next
            // sync run records the effective schedule anyway (FR-64), so this is logged only.
            this.logger.warn(
                `App upstream: recomputing the sync schedule of work ${workId} after an App spec change failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return { workId, recomputed: false, reason: 'failed' };
        }
    }
}
