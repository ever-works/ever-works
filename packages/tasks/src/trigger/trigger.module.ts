import { Global, Module } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import {
    WORK_GENERATION_DISPATCHER,
    WORK_IMPORT_DISPATCHER,
    TEMPLATE_CUSTOMIZATION_DISPATCHER,
    WEBHOOK_DELIVERY_DISPATCHER,
    KB_MIRROR_DOCUMENT_DISPATCHER,
    KB_BACKFILL_SKELETON_DISPATCHER,
    KB_EMBED_DOCUMENT_DISPATCHER,
    KB_ORG_OVERLAY_FANOUT_DISPATCHER,
} from '@ever-works/agent/tasks';

@Global()
@Module({
    providers: [
        TriggerService,
        {
            provide: WORK_GENERATION_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: WORK_IMPORT_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: TEMPLATE_CUSTOMIZATION_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: WEBHOOK_DELIVERY_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_MIRROR_DOCUMENT_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_BACKFILL_SKELETON_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_EMBED_DOCUMENT_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: KB_ORG_OVERLAY_FANOUT_DISPATCHER,
            useExisting: TriggerService,
        },
    ],
    exports: [
        TriggerService,
        WORK_GENERATION_DISPATCHER,
        WORK_IMPORT_DISPATCHER,
        TEMPLATE_CUSTOMIZATION_DISPATCHER,
        WEBHOOK_DELIVERY_DISPATCHER,
        KB_MIRROR_DOCUMENT_DISPATCHER,
        KB_BACKFILL_SKELETON_DISPATCHER,
        KB_EMBED_DOCUMENT_DISPATCHER,
        KB_ORG_OVERLAY_FANOUT_DISPATCHER,
    ],
})
export class TriggerModule {}
