import { Injectable, Logger } from '@nestjs/common';
import { configure, runs } from '@trigger.dev/sdk';
import { config } from '@ever-works/agent/config';
import {
    WorkGenerationPayload,
    WorkGenerationDispatcher,
    WorkImportPayload,
    WorkImportDispatcher,
    TemplateCustomizationPayload,
    TemplateCustomizationDispatcher,
    WebhookDeliveryPayload,
    WebhookDeliveryDispatcher,
    KbMirrorDocumentPayload,
    KbMirrorDocumentDispatcher,
    KbBackfillSkeletonPayload,
    KbBackfillSkeletonDispatcher,
} from '@ever-works/agent/tasks';
import { workGenerationTask } from '../tasks/trigger/work-generation.task';
import { workImportTask } from '../tasks/trigger/work-import.task';
import { templateCustomizationTask } from '../tasks/trigger/template-customization.task';
import { webhookDeliveryTask } from '../tasks/trigger/webhook-delivery.task';
import { kbMirrorDocumentTask } from '../tasks/trigger/kb-mirror-document.task';
import { kbBackfillSkeletonTask } from '../tasks/trigger/kb-backfill-skeleton.task';

@Injectable()
export class TriggerService
    implements
        WorkGenerationDispatcher,
        WorkImportDispatcher,
        TemplateCustomizationDispatcher,
        WebhookDeliveryDispatcher,
        KbMirrorDocumentDispatcher,
        KbBackfillSkeletonDispatcher
{
    private readonly logger = new Logger(TriggerService.name);
    private configured = false;

    private supportedMachines = [
        'medium-1x',
        'micro',
        'small-1x',
        'small-2x',
        'medium-2x',
        'large-1x',
        'large-2x',
    ];

    private ensureConfigured(): boolean {
        if (!config.trigger.shouldUseTrigger()) {
            return false;
        }

        if (this.configured) {
            return true;
        }

        const accessToken = config.trigger.getSecretKey();
        const baseURL = config.trigger.getApiUrl();

        if (!accessToken) {
            this.logger.warn('TRIGGER_SECRET_KEY is not configured');
            return false;
        }

        configure({ accessToken, baseURL });
        this.configured = true;
        return true;
    }

    private machine() {
        if (this.supportedMachines.includes(config.trigger.getMachine())) {
            return config.trigger.getMachine();
        }

        return undefined;
    }

    async dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await workGenerationTask.trigger(payload, {
                tags: ['work-generation', payload.mode, payload.workId],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch work-generation task', error as Error);
            return null;
        }
    }

    async cancelWorkGeneration(runId: string): Promise<boolean> {
        if (!this.ensureConfigured()) {
            return false;
        }

        try {
            await runs.cancel(runId);
            return true;
        } catch (error) {
            this.logger.error(`Failed to cancel work-generation task ${runId}`, error as Error);
            return false;
        }
    }

    async dispatchWorkImport(payload: WorkImportPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await workImportTask.trigger(payload, {
                tags: ['work-import', payload.sourceType, payload.workId],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch work-import task', error as Error);
            return null;
        }
    }

    async dispatchTemplateCustomization(
        payload: TemplateCustomizationPayload,
    ): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await templateCustomizationTask.trigger(payload, {
                tags: ['template-customization', payload.customizationId],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch template-customization task', error as Error);
            return null;
        }
    }

    /**
     * EW-634 — enqueue one webhook delivery. Returns the Trigger.dev run id
     * so the producer can record it on the corresponding `webhook_deliveries`
     * row, or null if Trigger.dev is disabled (`shouldUseTrigger()` false)
     * or the dispatch threw. The caller's in-process fallback handles both
     * cases identically so single-instance dev environments still deliver.
     */
    async dispatchWebhookDelivery(payload: WebhookDeliveryPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await webhookDeliveryTask.trigger(payload, {
                tags: [
                    'webhook-delivery',
                    `event:${payload.eventName}`,
                    `subscription:${payload.subscriptionId}`,
                ],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch webhook-delivery task', error as Error);
            return null;
        }
    }

    /**
     * EW-641 — enqueue one KB document mirror to Trigger.dev. The KB
     * service calls this after every create / update / delete so the
     * sidecar `.yml` + body `.md` in the Work's data repo stays in sync
     * with the DB. Returns the Trigger.dev run id (or `null` when
     * Trigger.dev is disabled / disposed).
     */
    async dispatchKbMirrorDocument(payload: KbMirrorDocumentPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            // Greptile P2: serialize mirror runs per Work so rapid
            // successive create/update/delete mutations don't race on
            // `git push`. Trigger.dev's `concurrencyKey` queues
            // subsequent runs behind any in-flight one with the same
            // key — keyed on `workId`, two Works run in parallel but
            // two mutations on the same Work run sequentially.
            const handle = await kbMirrorDocumentTask.trigger(payload, {
                tags: [
                    'kb-mirror-document',
                    `op:${payload.operation}`,
                    `work:${payload.workId}`,
                    `doc:${payload.documentId}`,
                ],
                machine: this.machine() as any,
                concurrencyKey: `kb-mirror:${payload.workId}`,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-mirror-document task', error as Error);
            return null;
        }
    }

    /**
     * EW-641 — enqueue an idempotent KB skeleton backfill for the
     * supplied Works. Used from admin scripts / one-off bootstrap
     * tasks; the per-document mirror task already lazy-creates the
     * skeleton, so this is only needed when the operator wants to
     * pre-populate it without an outbound mutation.
     */
    async dispatchKbBackfillSkeleton(payload: KbBackfillSkeletonPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await kbBackfillSkeletonTask.trigger(payload, {
                tags: ['kb-backfill-skeleton', `count:${payload.workIds?.length ?? 0}`],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-backfill-skeleton task', error as Error);
            return null;
        }
    }
}
