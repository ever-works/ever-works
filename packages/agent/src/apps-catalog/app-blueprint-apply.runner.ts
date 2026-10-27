/**
 * APW-03 T28 (lane aw-blueprints) — the two narrow classes around
 * {@link AppBlueprintUpgradeService}:
 *
 *  - {@link AppBlueprintApplyRunner} is what the Trigger worker reaches over the internal
 *    RPC channel (`TriggerInternalController.remoteMap`). The worker owns no
 *    `DataSource`, and the run writes the App spec state row and Activity, so the job
 *    body runs HERE, in the API process — the `AppForkReadinessRunner` /
 *    `AppBuildPrepareRunner` shape. It exposes `run` and nothing else: the RPC allow-list
 *    is derived from a class's own methods, and the worker has no business calling
 *    `request` or `dismiss` with a user id of its choosing.
 *  - {@link AppBlueprintUpgradeListener} closes the loop when the member merges the
 *    proposal: the App spec evaluation that the merge triggers publishes
 *    `app.spec.applied`, and `reconcile` records the landing.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import type { AppBlueprintApplyJobPayload } from './app-blueprint-apply.job';
import { AppBlueprintUpgradeService, type AppBlueprintRunResult } from './app-blueprint-upgrade.service';

@Injectable()
export class AppBlueprintApplyRunner {
    constructor(@Optional() private readonly upgrades?: AppBlueprintUpgradeService) {}

    /** One `app-blueprint-apply` run. Never throws: the result names what happened. */
    async run(payload: AppBlueprintApplyJobPayload): Promise<AppBlueprintRunResult> {
        if (!this.upgrades) {
            return {
                status: 'failed',
                workId: typeof payload?.workId === 'string' ? payload.workId : '',
                mode: payload?.mode ?? null,
                version: typeof payload?.version === 'string' ? payload.version : null,
                reason: 'dependenciesUnavailable',
                pullRequest: null,
                conflictCount: 0,
            };
        }
        return this.upgrades.run(payload);
    }
}

@Injectable()
export class AppBlueprintUpgradeListener {
    private readonly logger = new Logger(AppBlueprintUpgradeListener.name);

    constructor(@Optional() private readonly upgrades?: AppBlueprintUpgradeService) {}

    @OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true, suppressErrors: true })
    async onSpecApplied(event: AppSpecAppliedEvent): Promise<void> {
        if (!this.upgrades || !event?.workId) return;
        try {
            await this.upgrades.reconcile(event.workId);
        } catch (error) {
            this.logger.warn(
                `Blueprint: reconciling work ${event.workId} after app.spec.applied failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }
}
