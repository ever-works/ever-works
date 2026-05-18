import { task } from '@trigger.dev/sdk';
import { TemplateCustomizationPayload } from '@ever-works/agent/tasks';
import { TemplateCustomizationService } from '@ever-works/agent/template-catalog';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
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
            const service = appContext.get(TemplateCustomizationService);
            await service.execute(payload.customizationId);
            return { status: 'completed', customizationId: payload.customizationId };
        });
    },
});
