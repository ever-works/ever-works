import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkGenerationHistoryRepository } from '@ever-works/agent/database';
import { GenerateStatusType } from '@ever-works/contracts/api';
import {
    TRIGGER_WEBHOOK_EVENTS,
    TriggerWebhookInternalEventName,
    TriggerWebhookInternalEventPayload,
} from '../trigger-webhook-events';

/**
 * EW-743 Phase 3 — listens to `trigger.run.{succeeded,failed,cancelled}`
 * and flips the matching `work_generation_history` row's status to a
 * terminal value (`generated` / `error` / `cancelled`).
 *
 * Match key: `triggerRunId` extracted from the Trigger.dev webhook
 * payload (`payload.run.id`). We do NOT create a new row when no match
 * exists — the upstream dispatcher (`WorkGenerationService`) is the
 * authoritative producer of history rows; this subscriber only reacts.
 *
 * # Why WorkGenerationHistory (and not AgentRun / TemplateCustomization / WebhookDelivery)
 *
 * `work_generation_history` has the cleanest fit:
 *   - It's the dominant `triggerRunId`-bearing entity (every work
 *     generation gets a row).
 *   - Its status enum (`GENERATING|GENERATED|ERROR|CANCELLED`) maps
 *     1:1 to the three terminal Trigger.dev run states.
 *   - Its repository is already wired into the global `DatabaseModule`
 *     and is therefore DI-available in `WebhooksModule` without any
 *     module-graph surgery.
 *
 * `AgentRun` also has `triggerRunId` + a similar terminal-status enum,
 * but its repository is feature-module-scoped (not exported from
 * `DatabaseModule`), so wiring it here would force a feature-module
 * import cascade outside this PR's scope. A follow-up subscriber for
 * `AgentRun` can land independently.
 *
 * # Constraints
 *
 *  - Idempotent: re-applying a terminal status is a no-op at the SQL
 *    layer (`UPDATE ... SET status = 'generated' WHERE id = ?` against
 *    an already-`generated` row writes the same value), so duplicate
 *    deliveries (Trigger.dev is at-least-once) are safe by construction.
 *    We additionally short-circuit early when the persisted status is
 *    already terminal to avoid pointless UPDATEs + finishedAt clobber.
 *  - Never throws: per the router's contract, a thrown subscriber would
 *    poison EventEmitter2 and bring down sibling subscribers (Sentry
 *    breadcrumb subscriber, future notification subscriber, ...). All
 *    handler bodies are wrapped in try/catch and failures are logged.
 *  - Missing record: if no row has the runId, log at debug + drop. This
 *    is expected for runs originated outside the platform (Trigger.dev
 *    `dev` runs, manual `triggers.run.dev`, stale alerts after a tenant
 *    re-provision) and should NOT page operators.
 */
@Injectable()
export class TriggerRunStatusSubscriber {
    private readonly logger = new Logger(TriggerRunStatusSubscriber.name);

    constructor(private readonly history: WorkGenerationHistoryRepository) {}

    @OnEvent(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED)
    async onRunSucceeded(event: TriggerWebhookInternalEventPayload): Promise<void> {
        await this.handle(event, GenerateStatusType.GENERATED);
    }

    @OnEvent(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED)
    async onRunFailed(event: TriggerWebhookInternalEventPayload): Promise<void> {
        await this.handle(event, GenerateStatusType.ERROR);
    }

    @OnEvent(TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED)
    async onRunCancelled(event: TriggerWebhookInternalEventPayload): Promise<void> {
        await this.handle(event, GenerateStatusType.CANCELLED);
    }

    private async handle(
        event: TriggerWebhookInternalEventPayload,
        terminalStatus: GenerateStatusType,
    ): Promise<void> {
        try {
            const runId = extractRunId(event.payload);
            if (!runId) {
                this.logger.debug(
                    `${event.internalEventName as TriggerWebhookInternalEventName} ` +
                        `dropped: missing payload.run.id (tenantId=${event.tenantId})`,
                );
                return;
            }

            const record = await this.history.findByTriggerRunId(runId);
            if (!record) {
                // Expected for runs originated outside the platform —
                // see class header. Debug, not warn.
                this.logger.debug(
                    `${event.internalEventName} dropped: no work_generation_history row ` +
                        `for triggerRunId=${runId} (tenantId=${event.tenantId})`,
                );
                return;
            }

            // Idempotency short-circuit: terminal statuses are final.
            // Without this, a retry delivery would rewrite finishedAt to
            // the second-delivery's `now`, drifting the persisted
            // duration. Comparing the persisted status against the
            // event's target also covers the "router fires the wrong
            // terminal status for this row" case (extremely unlikely
            // but defensible).
            if (isTerminal(record.status)) {
                this.logger.debug(
                    `${event.internalEventName} ignored: row ${record.id} already ` +
                        `terminal (status=${record.status})`,
                );
                return;
            }

            const errorMessage = extractErrorMessage(event.payload);
            await this.history.updateEntry(record.id, {
                status: terminalStatus,
                finishedAt: new Date(event.createdAt) || new Date(),
                ...(terminalStatus === GenerateStatusType.ERROR && errorMessage
                    ? { errorMessage }
                    : {}),
            });

            this.logger.log(
                `${event.internalEventName}: work_generation_history ${record.id} → ${terminalStatus} ` +
                    `(triggerRunId=${runId}, tenantId=${event.tenantId})`,
            );
        } catch (err) {
            // MUST NOT throw — router contract. Log + swallow.
            this.logger.error(
                `${event.internalEventName ?? 'trigger.run.?'} handler failed: ` +
                    `${(err as Error).message ?? String(err)}`,
                (err as Error).stack,
            );
        }
    }
}

function isTerminal(status: GenerateStatusType): boolean {
    return (
        status === GenerateStatusType.GENERATED ||
        status === GenerateStatusType.ERROR ||
        status === GenerateStatusType.CANCELLED
    );
}

/**
 * Trigger.dev v4 `alert.run.*` payload shape (per
 * https://trigger.dev/docs/troubleshooting-alerts#alert-webhooks):
 *
 *   { run: { id: "run_abc", status: "COMPLETED", ... }, ... }
 *
 * We don't import a typed schema for two reasons:
 *   1. Trigger.dev's webhook contract is documented but not exported
 *      as a TS type from `@trigger.dev/sdk` (the alert types live
 *      on their SaaS-side workers).
 *   2. The router intentionally passes the payload through opaquely
 *      so future schema growth doesn't require a router redeploy.
 *
 * Hence: defensive accessor with explicit type checks.
 */
function extractRunId(payload: Readonly<Record<string, unknown>>): string | null {
    const run = (payload as { run?: unknown }).run;
    if (!run || typeof run !== 'object') return null;
    const id = (run as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Best-effort error extraction from the alert.run.failed payload. The
 * Trigger.dev schema is `{ run: { error: { message: string, ... } } }`
 * for failed runs; `null` for any other shape so the column update
 * stays optional rather than persisting "undefined".
 */
function extractErrorMessage(payload: Readonly<Record<string, unknown>>): string | null {
    const run = (payload as { run?: unknown }).run;
    if (!run || typeof run !== 'object') return null;
    const error = (run as { error?: unknown }).error;
    if (!error || typeof error !== 'object') return null;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
        // Truncate aggressively — `errorMessage` is `text` but we don't
        // want to dump a 100 KB stack into the DB just because Trigger
        // forwarded one.
        return message.length > 2048 ? `${message.slice(0, 2048)}…` : message;
    }
    return null;
}
