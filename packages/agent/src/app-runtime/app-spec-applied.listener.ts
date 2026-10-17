/**
 * APW-06 T35 (lane aw-deploy-2, 2026-10-17) — **the spec-applied trigger** (plan §5.8:887-888).
 *
 * A published-image App (`build.strategy: image`) has no Build to succeed, so the
 * Build-succeeded trigger (`app-build-succeeded.listener.ts`) never fires for it. Its redeploy
 * signal is APW-03's `app.spec.applied`: when the applied spec changed something that runs, the
 * App is redeployed at that commit. This listener requests ONE `spec-applied` Deployment when:
 *
 * - App Works is switched on;
 * - the changed blocks intersect {@link APP_IMAGE_REDEPLOY_BLOCKS};
 * - the target is not `none` and `targetSettings.autoDeploy` is not off (plan §7.2 default on);
 * - the effective spec at that commit has `build.strategy: image` — a `dockerfile`/`auto` App
 *   is redeployed by its Build instead, so a spec change there requests nothing here.
 *
 * Idempotent on the commit: a Deployment row already naming this commit with the `spec-applied`
 * trigger means the request was made. Never throws into the event fan-out.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { config } from '../config';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { AppSpecService } from '../app-spec/app-spec.service';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import { AppDeployRequestService, type AppDeployRequestResult } from './app-deploy-request.service';

/** §5.8:888 — the blocks whose change alters what a published-image App runs. */
export const APP_IMAGE_REDEPLOY_BLOCKS: readonly string[] = [
    'build',
    'components',
    'jobs',
    'cron',
    'smoke',
    'env',
    'dependencies',
    'domains',
];

export type AppSpecAppliedTriggerOutcome =
    | { requested: true; result: AppDeployRequestResult }
    | { requested: false; reason: string };

@Injectable()
export class AppSpecAppliedListener {
    private readonly logger = new Logger(AppSpecAppliedListener.name);
    private readonly inFlight = new Set<string>();

    constructor(
        @Optional() private readonly requests?: AppDeployRequestService,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: {
            getOrCreate(workId: string): Promise<{
                target?: string | null;
                targetSettings?: { autoDeploy?: boolean | null } | null;
            } | null>;
        },
        @Optional() private readonly specs?: AppSpecService,
        @Optional() private readonly deployments?: WorkDeploymentRepository,
    ) {}

    @OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true })
    async onSpecApplied(event: AppSpecAppliedEvent): Promise<AppSpecAppliedTriggerOutcome> {
        try {
            return await this.handle(event);
        } catch (error) {
            this.logger.warn(
                `The spec-applied redeploy of Work ${event?.workId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { requested: false, reason: 'threw' };
        }
    }

    private async handle(event: AppSpecAppliedEvent): Promise<AppSpecAppliedTriggerOutcome> {
        if (!config.everWorks?.apps?.worksEnabled?.())
            return { requested: false, reason: 'disabled' };
        const workId = text(event?.workId);
        const commitSha = text(event?.commitSha);
        if (!workId || !commitSha) return { requested: false, reason: 'invalid_payload' };
        if (!this.requests?.request || !this.states?.getOrCreate || !this.specs?.getEffectiveSpec) {
            return { requested: false, reason: 'unbound' };
        }

        const changed = [...(event.changedBlocks ?? [])];
        if (!changed.some((block) => APP_IMAGE_REDEPLOY_BLOCKS.includes(block))) {
            return { requested: false, reason: 'nothing_that_runs_changed' };
        }

        const state = await this.states.getOrCreate(workId);
        if (!state?.target || state.target === 'none')
            return { requested: false, reason: 'target_none' };
        if (state.targetSettings?.autoDeploy === false)
            return { requested: false, reason: 'auto_deploy_off' };

        const snapshot = (await this.specs.getEffectiveSpec(workId, commitSha)) as unknown as {
            spec?: { build?: { strategy?: unknown } | null } | null;
        } | null;
        if (snapshot?.spec?.build?.strategy !== 'image') {
            return { requested: false, reason: 'not_image_strategy' };
        }

        const key = `${workId}:${commitSha}`;
        if (this.inFlight.has(key)) return { requested: false, reason: 'in_flight' };
        this.inFlight.add(key);
        try {
            if (await this.alreadyRequested(workId, commitSha)) {
                return { requested: false, reason: 'already_requested' };
            }
            const result = await this.requests.request({
                workId,
                userId: null,
                trigger: 'spec-applied',
                specCommitSha: commitSha,
                requestId: `app-spec:${commitSha}`,
            });
            return { requested: true, result };
        } finally {
            this.inFlight.delete(key);
        }
    }

    private async alreadyRequested(workId: string, commitSha: string): Promise<boolean> {
        if (!this.deployments?.findByWork) return false;
        try {
            const rows = await this.deployments.findByWork(workId, { limit: 25 });
            return (rows ?? []).some(
                (row) => row?.appTrigger === 'spec-applied' && row?.commitSha === commitSha,
            );
        } catch {
            return false;
        }
    }
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
