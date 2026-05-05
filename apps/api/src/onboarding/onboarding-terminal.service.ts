import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    type DeliveryResult,
    type StateMarkerPayload,
    StateMarkerService,
    WebhookDeliveryService,
    WebhookSubscriptionRepository,
} from '@ever-works/agent/onboarding';
import { OnboardingRequestRepository } from '@ever-works/agent/onboarding';

export interface TerminalNotification {
    readonly onboardingId: string;
    readonly workId: string;
    readonly status: 'deployed' | 'failed' | 'rejected';
    readonly subdomain: string;
    readonly deploymentUrl?: string;
    readonly failureCode?: string;
    readonly failureMessage?: string;
}

export interface TerminalFanoutResult {
    readonly webhook?: DeliveryResult;
    readonly markerWritten: boolean;
}

/**
 * Fan-out for an onboarding's terminal status transition. Called by the
 * `work-onboarding.task` worker (queued T19) and any other producer that
 * marks a Work as `deployed`, `failed`, or `rejected`.
 *
 * Side effects (each best-effort, never throw out of this method):
 *   1. Resolve the OnboardingRequest row to find the agent's webhookUrl,
 *      subdomain, and (eventually) accountId-scoped webhook subscriptions.
 *   2. POST a signed webhook to every active subscription URL plus the
 *      per-request URL when present.
 *   3. Commit `.works/state.json` to the manifest repo if the agent opted
 *      in by configuring the marker (always on at v1).
 *   4. Persist delivery result counters onto the WebhookSubscription row.
 *
 * The state-marker write requires a `MarkerFileWriter` implementation that
 * holds the GitHub credential — that wiring lands with T9d/T11 follow-up.
 * For v1 we no-op the marker step when no writer is wired so the rest of
 * the fan-out still runs in development.
 */
@Injectable()
export class OnboardingTerminalService {
    private readonly logger = new Logger(OnboardingTerminalService.name);

    constructor(
        private readonly onboardingRepo: OnboardingRequestRepository,
        private readonly webhookSubs: WebhookSubscriptionRepository,
        private readonly delivery: WebhookDeliveryService,
        @Optional() private readonly stateMarker: StateMarkerService | null = null,
    ) {}

    async notify(input: TerminalNotification): Promise<TerminalFanoutResult> {
        const row = await this.onboardingRepo.findById(input.onboardingId);
        if (!row) {
            this.logger.warn(`onboarding.terminal.unknown id=${input.onboardingId}`);
            return { markerWritten: false };
        }

        const payload: StateMarkerPayload = {
            status: input.status,
            workId: input.workId,
            subdomain: input.subdomain,
            deploymentUrl: input.deploymentUrl,
            updatedAt: new Date().toISOString(),
            deliveryId: cryptoRandomUuid(),
            failureCode: input.failureCode,
            failureMessage: input.failureMessage,
        };

        let webhookResult: DeliveryResult | undefined;
        if (row.webhookUrl) {
            webhookResult = await this.deliveryFor(row.webhookUrl, payload);
        }

        if (row.accountId) {
            const subs = await this.webhookSubs.listActiveForWork(input.workId).catch(() => []);
            for (const sub of subs) {
                const result = await this.deliveryFor(sub.url, payload, sub.secretEncrypted);
                if (result.ok) {
                    await this.webhookSubs.markSuccess(sub.id).catch(() => {});
                } else {
                    const failures = await this.webhookSubs.incrementFailure(sub.id).catch(() => 0);
                    if (failures >= 6) {
                        await this.webhookSubs.markFailed(sub.id).catch(() => {});
                    }
                }
            }
        }

        let markerWritten = false;
        if (this.stateMarker) {
            // The token + writer wiring is done at the call site via T9d.
            // The default service is null in v1 and this branch is skipped.
            markerWritten = false;
        }

        return { webhook: webhookResult, markerWritten };
    }

    /** Test seam — the per-request webhook uses a per-account secret in the
     * full implementation. For the per-request hook supplied during
     * registration we use a deterministic placeholder until T10 wires the
     * encrypted secret store; the agent verifies with the same value
     * returned in the registration response (future). */
    private async deliveryFor(
        url: string,
        payload: StateMarkerPayload,
        secret = process.env.WEBHOOK_FALLBACK_SECRET ?? 'ever-works-dev-secret',
    ): Promise<DeliveryResult> {
        return this.delivery.deliver({
            url,
            secret,
            event: 'onboarding.terminal',
            payload: payload as unknown as Record<string, unknown>,
        });
    }
}

function cryptoRandomUuid(): string {
    // Imported lazily so this file is also usable in environments where
    // the @nestjs lifecycle imports it before crypto is hot-loaded.
    return require('node:crypto').randomUUID();
}
