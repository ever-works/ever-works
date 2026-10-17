/**
 * APW-06 T28 (lane aw-deploy-2, 2026-10-17) — **the Activity half of the runtime events**.
 *
 * The isolated worker emits §9.4's events through `APP_RUNTIME_EVENT_SINK`; the API's
 * `AppRuntimeEventRelayService` checks them (catalogue + forbidden keys) and re-emits them on
 * `EventEmitter2`. This listener writes ONE Activity row per relayed event:
 *
 * | event family | `actionType` |
 * | --- | --- |
 * | `app.deploy.*` | `app_deploy` |
 * | `app.job.*` | `app_job` |
 * | `app.smoke.*` | `app_smoke` |
 *
 * `action` is the dotted event name, `metadata` its ids and names only (`deploymentId`, `buildId`,
 * `target`, `phase`, `code`, `names`) — never a value, an env entry or a log line (ACC-06-41;
 * the relay already refused a payload that carried one). The row's user is the payload's
 * `userId`, else the Work's owner, so a Build-triggered Deployment still lands in the owner's feed.
 *
 * Never throws: Activity is a record of what happened, and failing to write it must not fail
 * the event fan-out.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ActivityLogService } from '../activity-log/activity-log.service';
import { WorkRepository } from '../database/repositories/work.repository';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';

/** The ids and names a row may carry, copied field by field from the payload. */
const METADATA_KEYS = ['deploymentId', 'buildId', 'target', 'phase', 'code', 'names'] as const;

@Injectable()
export class AppRuntimeActivityListener {
    private readonly logger = new Logger(AppRuntimeActivityListener.name);

    constructor(
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly works?: WorkRepository,
    ) {}

    // One explicit handler per relayed name (no wildcard: the emitter's `wildcard` option is not
    // assumed), each passing its own name so `action` is exact.
    @OnEvent('app.deploy.started', { async: true })
    async onDeployStarted(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.started');
    }

    @OnEvent('app.deploy.succeeded', { async: true })
    async onDeploySucceeded(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.succeeded');
    }

    @OnEvent('app.deploy.failed', { async: true })
    async onDeployFailed(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.failed');
    }

    @OnEvent('app.deploy.rolled_back', { async: true })
    async onDeployRolledBack(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.rolled_back');
    }

    @OnEvent('app.deploy.paused', { async: true })
    async onDeployPaused(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.paused');
    }

    @OnEvent('app.deploy.resumed', { async: true })
    async onDeployResumed(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.resumed');
    }

    @OnEvent('app.deploy.removed', { async: true })
    async onDeployRemoved(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_DEPLOY, payload, 'app.deploy.removed');
    }

    @OnEvent('app.job.succeeded', { async: true })
    async onJobSucceeded(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_JOB, payload, 'app.job.succeeded');
    }

    @OnEvent('app.job.failed', { async: true })
    async onJobFailed(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_JOB, payload, 'app.job.failed');
    }

    @OnEvent('app.smoke.passed', { async: true })
    async onSmokePassed(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_SMOKE, payload, 'app.smoke.passed');
    }

    @OnEvent('app.smoke.failed', { async: true })
    async onSmokeFailed(payload: Record<string, unknown>): Promise<void> {
        await this.write(ActivityActionType.APP_SMOKE, payload, 'app.smoke.failed');
    }

    /** One row for one relayed event. */
    async write(
        actionType: ActivityActionType,
        payload: Record<string, unknown>,
        name?: string,
    ): Promise<boolean> {
        if (!this.activityLog?.log) return false;
        const workId = text(payload?.workId);
        if (!workId) return false;
        const action = text(name);

        try {
            const userId = text(payload?.userId) || (await this.ownerOf(workId));
            if (!userId) return false;

            const metadata: Record<string, unknown> = {};
            for (const key of METADATA_KEYS) {
                const value = payload?.[key];
                if (value === undefined || value === null || value === '') continue;
                metadata[key] = Array.isArray(value)
                    ? value.map((entry) => String(entry)).slice(0, 20)
                    : String(value);
            }

            await this.activityLog.log({
                userId,
                workId,
                actionType,
                action: action || actionType,
                status: statusFor(action),
                summary: summaryFor(actionType, action, metadata),
                metadata,
            });
            return true;
        } catch (error) {
            this.logger.warn(
                `The Activity row for ${action || actionType} (Work ${workId}) could not be written: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    private async ownerOf(workId: string): Promise<string> {
        try {
            const work = await this.works?.findById(workId);
            return text(work?.userId);
        } catch {
            return '';
        }
    }
}

function statusFor(action: string): ActivityStatus {
    if (/\.(failed|rolled_back)$/.test(action)) return ActivityStatus.FAILED;
    if (action.endsWith('.started')) return ActivityStatus.IN_PROGRESS;
    if (action.endsWith('.removed') || action.endsWith('.paused')) return ActivityStatus.COMPLETED;
    return ActivityStatus.COMPLETED;
}

function summaryFor(
    actionType: ActivityActionType,
    action: string,
    metadata: Record<string, unknown>,
): string {
    const verb = action.split('.').pop() ?? '';
    switch (actionType) {
        case ActivityActionType.APP_DEPLOY:
            return `Deployment ${verb.replace('_', ' ')}${metadata.code ? ` (${String(metadata.code)})` : ''}`;
        case ActivityActionType.APP_JOB:
            return `Job ${Array.isArray(metadata.names) ? (metadata.names as string[]).join(', ') : ''} ${verb}`
                .replace(/\s+/g, ' ')
                .trim();
        default:
            return `Smoke checks ${verb}`;
    }
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
