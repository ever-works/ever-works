/**
 * APW-06 T35 (A0.6, 2026-10-17) — **the Build-succeeded trigger** (plan §5.6, FR-23, APW06-G11).
 *
 * Consumes APW-05's `app.build.succeeded` (`AppBuildSucceededEvent`, emitted in the API process by
 * `AppBuildsService` when a Build lands green) and requests **one** Deployment of that Build when:
 *
 * - App Works is switched on (`EVER_WORKS_APP_WORKS_ENABLED`);
 * - the Build is `deployable: true` — APW-05's verdict, which already encodes "on the tracked
 *   (deploy) branch, a push/manual trigger, not a pull request" (`deployable-verdict.ts`);
 * - the App Work has a target other than `none`;
 * - `targetSettings.autoDeploy` is on (plan §7.2's default is `true`) — **or** the Build is the one
 *   `pendingDomainRebuildBuildId` names, in which case the Deployment is a `domain-change` one and
 *   the marker is cleared.
 *
 * `app.build.failed` / `app.build.cancelled` for the marked Build clears the marker and requests
 * nothing (APW06-G11).
 *
 * ## Exactly once
 *
 * An event can arrive twice (a retried watch run re-emits). The listener is idempotent on the
 * Build: an in-process guard covers two deliveries racing in this process, and the Work's recent
 * Deployment rows are read first — a row that already names this Build with a `build` /
 * `domain-change` trigger means the request was already made, so nothing is asked again. The
 * request itself goes through `AppDeployRequestService.request`, which re-runs every §5.1
 * precondition and queues behind a running Deployment (latest wins), so this file decides only
 * *whether* to ask, never *how* to deploy.
 *
 * Every failure is logged and swallowed: a listener that threw would fail the Build's own event
 * fan-out, and the Build already succeeded.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AppBuildEventPayload } from '@ever-works/contracts';

import { config } from '../config';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import {
    AppBuildCancelledEvent,
    AppBuildFailedEvent,
    AppBuildSucceededEvent,
} from '../events/app-build.events';
import { AppDeployRequestService, type AppDeployRequestResult } from './app-deploy-request.service';

/** The runtime-state facts this listener reads and the one write it makes. */
export interface AppBuildTriggerStateStore {
    getOrCreate(workId: string): Promise<{
        target?: string | null;
        pendingDomainRebuildBuildId?: string | null;
        targetSettings?: { autoDeploy?: boolean | null } | null;
    } | null>;
    clearPendingDomainRebuild?(workId: string, buildId: string): Promise<boolean | void>;
}

/** What the listener decided, returned for its spec (the `@OnEvent` caller ignores it). */
export type AppBuildTriggerOutcome =
    | { requested: true; trigger: 'build' | 'domain-change'; result: AppDeployRequestResult }
    | { requested: false; reason: string };

/** How many recent Deployment rows the idempotency read looks at. */
const RECENT_DEPLOYMENTS = 25;

@Injectable()
export class AppBuildSucceededListener {
    private readonly logger = new Logger(AppBuildSucceededListener.name);
    private readonly inFlight = new Set<string>();

    constructor(
        @Optional() private readonly requests?: AppDeployRequestService,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppBuildTriggerStateStore,
        @Optional() private readonly deployments?: WorkDeploymentRepository,
    ) {}

    @OnEvent(AppBuildSucceededEvent.EVENT_NAME, { async: true })
    async onBuildSucceeded(
        event: AppBuildSucceededEvent | AppBuildEventPayload,
    ): Promise<AppBuildTriggerOutcome> {
        const payload = payloadOf(event);
        try {
            return await this.handleSucceeded(payload);
        } catch (error) {
            this.logger.warn(
                `Auto-deploy for Build ${payload?.buildId} of Work ${payload?.workId} failed: ${messageOf(error)}`,
            );
            return { requested: false, reason: 'threw' };
        }
    }

    @OnEvent(AppBuildFailedEvent.EVENT_NAME, { async: true })
    async onBuildFailed(event: AppBuildFailedEvent | AppBuildEventPayload): Promise<void> {
        await this.clearMarkerIfPending(payloadOf(event));
    }

    @OnEvent(AppBuildCancelledEvent.EVENT_NAME, { async: true })
    async onBuildCancelled(event: AppBuildCancelledEvent | AppBuildEventPayload): Promise<void> {
        await this.clearMarkerIfPending(payloadOf(event));
    }

    private async handleSucceeded(
        payload: AppBuildEventPayload | null,
    ): Promise<AppBuildTriggerOutcome> {
        if (!config.everWorks?.apps?.worksEnabled?.())
            return { requested: false, reason: 'disabled' };
        if (!payload?.workId || !payload.buildId)
            return { requested: false, reason: 'invalid_payload' };
        if (!this.requests?.request || !this.states?.getOrCreate) {
            return { requested: false, reason: 'unbound' };
        }

        const state = await this.states.getOrCreate(payload.workId);
        const target = state?.target ?? null;
        if (!target || target === 'none') return { requested: false, reason: 'target_none' };

        const pending = state?.pendingDomainRebuildBuildId === payload.buildId;
        // `deployable: false` never requests a Deployment — not even for a pending rebuild, whose
        // marker then waits for a deployable Build (or is cleared by a failed/cancelled one).
        if (payload.deployable !== true) return { requested: false, reason: 'not_deployable' };
        if (!pending && state?.targetSettings?.autoDeploy === false) {
            return { requested: false, reason: 'auto_deploy_off' };
        }

        const key = `${payload.workId}:${payload.buildId}`;
        if (this.inFlight.has(key)) return { requested: false, reason: 'in_flight' };
        this.inFlight.add(key);

        try {
            if (await this.alreadyRequested(payload.workId, payload.buildId)) {
                return { requested: false, reason: 'already_requested' };
            }

            const trigger = pending ? 'domain-change' : 'build';
            const result = await this.requests.request({
                workId: payload.workId,
                userId: null,
                trigger,
                buildId: payload.buildId,
                branch: payload.branch || null,
                headCommitSha: payload.commitSha || null,
                requestId: `app-build:${payload.buildId}`,
            });

            if (pending) await this.clearMarker(payload.workId, payload.buildId);

            if (result.status === 'refused') {
                this.logger.log(
                    `Auto-deploy of Build ${payload.buildId} (Work ${payload.workId}) was refused: ${result.code}.`,
                );
            }
            return { requested: true, trigger, result };
        } finally {
            this.inFlight.delete(key);
        }
    }

    private async alreadyRequested(workId: string, buildId: string): Promise<boolean> {
        if (!this.deployments?.findByWork) return false;
        try {
            const rows = await this.deployments.findByWork(workId, { limit: RECENT_DEPLOYMENTS });
            return (rows ?? []).some(
                (row) =>
                    row?.buildId === buildId &&
                    (row.appTrigger === 'build' || row.appTrigger === 'domain-change'),
            );
        } catch (error) {
            // Unreadable history: asking is the safer error — the request path dedupes a queued
            // entry by Build and refuses a second concurrent one with the lock.
            this.logger.warn(
                `Recent Deployments of Work ${workId} unreadable: ${messageOf(error)}`,
            );
            return false;
        }
    }

    private async clearMarkerIfPending(payload: AppBuildEventPayload | null): Promise<void> {
        if (!payload?.workId || !payload.buildId || !this.states?.getOrCreate) return;
        try {
            const state = await this.states.getOrCreate(payload.workId);
            if (state?.pendingDomainRebuildBuildId === payload.buildId) {
                await this.clearMarker(payload.workId, payload.buildId);
            }
        } catch (error) {
            this.logger.warn(
                `Clearing the pending domain rebuild of Work ${payload.workId} failed: ${messageOf(error)}`,
            );
        }
    }

    private async clearMarker(workId: string, buildId: string): Promise<void> {
        if (!this.states?.clearPendingDomainRebuild) return;
        await this.states.clearPendingDomainRebuild(workId, buildId);
    }
}

function payloadOf(event: unknown): AppBuildEventPayload | null {
    if (!event || typeof event !== 'object') return null;
    const wrapped = (event as { payload?: unknown }).payload;
    return (wrapped && typeof wrapped === 'object' ? wrapped : event) as AppBuildEventPayload;
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}
