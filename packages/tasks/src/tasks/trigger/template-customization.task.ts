import { logger, task } from '@trigger.dev/sdk';
import { TemplateCustomizationPayload } from '@ever-works/agent/tasks';
import { TemplateCustomizationService } from '@ever-works/agent/template-catalog';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

export const templateCustomizationTask = task<
    'template-customization',
    TemplateCustomizationPayload
>({
    id: 'template-customization',
    maxDuration: 3600, // 1 hour — UI-only edits should finish in minutes
    run: async (payload) => {
        return withWorkerContext('TemplateCustomization', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();

            // EW-742 P3.2 T22 — customization-scoped variant: resolves
            // tenantId via the TemplateCustomization row (carries
            // `tenantId` directly). See kb-embed-document.task.ts for
            // the full pattern rationale.
            const binding = await appContext
                .get(TenantRuntimeBindingResolverService)
                .resolveForCustomization(payload, payload.customizationId);
            if (binding.status === 'drained') {
                logger.warn('template-customization: credentials drained, skipping run', {
                    customizationId: payload.customizationId,
                    providerId: binding.providerId,
                    credentialVersion: binding.credentialVersion,
                    tenantId: binding.tenantId,
                });
                return {
                    status: 'skipped' as const,
                    reason: 'credentials-drained' as const,
                    customizationId: payload.customizationId,
                };
            }

            const service = appContext.get(TemplateCustomizationService);
            await service.execute(payload.customizationId);
            return { status: 'completed', customizationId: payload.customizationId };
        });
    },
});
