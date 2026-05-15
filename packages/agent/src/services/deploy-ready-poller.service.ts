import { Injectable, Logger } from '@nestjs/common';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { ZeroFrictionFunnelService } from './zero-friction-funnel.service';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';

export interface DeployReadyPollerSummary {
    scanned: number;
    ready: number;
    stillPending: number;
    failed: number;
}

const READY_STATE = 'READY';

/**
 * Pending-style states the poller probes for readiness. Mirrors the
 * states the DeploymentVerifierService transitions through.
 */
const PENDING_STATES: readonly string[] = ['pending', 'INITIALIZING', 'QUEUED', 'BUILDING'];

/**
 * EW-617 G8 — emits the funnel `deploy_ready` event when a freshly
 * deployed Work's slug-based URL starts responding 200. Backed by a
 * Trigger.dev schedule (every 2 minutes); see
 * `packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`.
 *
 * Strictly best-effort:
 *  - works without a persisted `lastDeployCorrelationId` get their state
 *    flipped to READY but no funnel event is emitted (we have nothing to
 *    correlate with).
 *  - health-check failures (network errors, non-200 responses) leave the
 *    row in its current state for the next poll tick.
 */
@Injectable()
export class DeployReadyPollerService {
    private readonly logger = new Logger(DeployReadyPollerService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly funnel: ZeroFrictionFunnelService,
    ) {}

    async pollOnce(
        options: {
            fetch?: typeof fetch;
            now?: () => Date;
            healthTimeoutMs?: number;
            domain?: string;
        } = {},
    ): Promise<DeployReadyPollerSummary> {
        const httpFetch = options.fetch ?? fetch;
        const now = options.now ?? (() => new Date());
        const timeoutMs = options.healthTimeoutMs ?? 5000;
        const domain = options.domain ?? process.env.EVER_WORKS_DOMAIN ?? 'ever.works';

        const pendingWorks = await this.workRepository.findByDeploymentStates([...PENDING_STATES]);
        const summary: DeployReadyPollerSummary = {
            scanned: pendingWorks.length,
            ready: 0,
            stillPending: 0,
            failed: 0,
        };

        for (const work of pendingWorks) {
            try {
                const url = `https://${work.slug}.${domain}/api/healthz`;
                const ok = await this.probeUrl(httpFetch, url, timeoutMs);
                if (!ok) {
                    summary.stillPending += 1;
                    continue;
                }

                const startedAt = work.deploymentStartedAt
                    ? new Date(work.deploymentStartedAt).getTime()
                    : undefined;
                const elapsedMs = startedAt ? now().getTime() - startedAt : 0;

                await this.workRepository.update(work.id, { deploymentState: READY_STATE });
                summary.ready += 1;

                if (work.lastDeployCorrelationId) {
                    this.funnel.emit({
                        event: ZERO_FRICTION_FUNNEL_EVENTS.DEPLOY_READY,
                        funnelStep: 7,
                        timestamp: now().toISOString(),
                        correlationId: work.lastDeployCorrelationId,
                        workId: work.id,
                        websiteUrl: `https://${work.slug}.${domain}`,
                        elapsedMs,
                    });
                }
            } catch (cause) {
                summary.failed += 1;
                const message = cause instanceof Error ? cause.message : String(cause);
                this.logger.warn(`deploy-ready-poller failed for work ${work.id}: ${message}`);
            }
        }

        return summary;
    }

    private async probeUrl(
        httpFetch: typeof fetch,
        url: string,
        timeoutMs: number,
    ): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await httpFetch(url, { method: 'GET', signal: controller.signal });
            return res.status === 200;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}
